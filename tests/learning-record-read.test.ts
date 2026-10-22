import { describe, expect, it } from "vitest";
import { createEpisode, recordAttempt, type LearningEpisode } from "../src/learning-episode.js";
import { LearningEpisodeStore } from "../src/learning-episode-store.js";
import { createEpisodeV2, LearningV2Store, type EpisodeV2 } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank.js";
import { LearningDialogue } from "../src/learning-dialogue.js";
import { learningContext } from "../src/learning-context.js";
import { combineRecordReadResults, MAX_LEARNING_RECORD_BYTES, type LearningIO } from "../src/learning-record-read.js";
import { LearningInvalidation } from "../src/learning-invalidation.js";

function memory() {
  const files = new Map<string, string>();
  const io: LearningIO = {
    read: async path => files.get(path) ?? null,
    list: async root => [...files.keys()].filter(path => path.startsWith(root + "/")),
    write: async (path, text) => { files.set(path, text); },
    compareWrite: async (path, old, next) => {
      if ((files.get(path) ?? null) !== old) throw new Error("external-conflict");
      files.set(path, next);
    },
  };
  return { files, io };
}
const makeV1 = (source = "math.md") => createEpisode({ path: source, version: "1" }, "value-limit");
const makeV2 = (source = "math.md") => createEpisodeV2({ path: source, version: "1" }, instantiateQuestion("value-limit", "practice"),
  { at: new Date().toISOString(), requestId: crypto.randomUUID(), conversationId: crypto.randomUUID() });

describe.each([1, 2] as const)("learning v%i record isolation", format => {
  function setup() {
    const m = memory(), root = `learning/v${format}/episodes`;
    const record = format === 1 ? makeV1() : makeV2();
    const store = format === 1 ? new LearningEpisodeStore(m.io, root) : new LearningV2Store(m.io, root);
    const path = `${root}/${record.id}.json`;
    m.files.set(path, JSON.stringify(record));
    return { ...m, root, record, store, path };
  }
  it("keeps valid records and original bytes when a first write was interrupted without a backup", async () => {
    const f = setup(), badPath = `${f.root}/${crypto.randomUUID()}.json`;
    f.files.set(badPath, "{interrupted");
    const read = await f.store.listResult();
    expect(read.records.map(record => record.id)).toEqual([f.record.id]);
    expect(read).toMatchObject({ completeness: "partial", integrityIssues: [{ category: "corrupt", recovered: false }] });
    expect(f.files.get(badPath)).toBe("{interrupted");
    expect(await f.store.list()).toHaveLength(1);
    expect(f.store.takeIntegrityIssues()).toHaveLength(1);
    await f.store.listResult(); expect(f.store.takeIntegrityIssues()).toEqual([]);
  });
  it("distinguishes a directory read failure from an empty directory", async () => {
    const f = setup();
    f.io.list = async () => { throw new Error("private path and access error"); };
    expect(await f.store.listResult()).toMatchObject({ records: [], completeness: "unavailable", integrityIssues: [{ category: "directory-unreadable" }] });
    expect(await f.store.list()).toEqual([]);
    expect(JSON.stringify(f.store.takeIntegrityIssues())).not.toMatch(/private|path|math\.md/);
    f.io.list = async () => [];
    expect(await f.store.listResult()).toMatchObject({ records: [], completeness: "complete", integrityIssues: [] });
  });
  it("isolates a record read error without hiding valid neighbors", async () => {
    const f = setup(), bad = `${f.root}/${crypto.randomUUID()}.json`, originalRead = f.io.read;
    f.files.set(bad, "private content");
    f.io.read = async path => { if (path === bad) throw new Error("EACCES"); return originalRead(path); };
    expect(await f.store.listResult()).toMatchObject({ completeness: "partial", records: [{ id: f.record.id }], integrityIssues: [{ category: "read-failed" }] });
  });
  it("restores a valid same-identity backup and retains the interrupted bytes", async () => {
    const f = setup(), backup = f.files.get(f.path)!;
    f.files.set(f.path + ".previous", backup); f.files.set(f.path, "{interrupted");
    const read = await f.store.listResult();
    expect(read).toMatchObject({ completeness: "complete", records: [{ id: f.record.id }], integrityIssues: [{ category: "corrupt", recovered: true }] });
    expect(f.files.get(f.path)).toBe(backup);
    expect([...f.files.entries()].some(([path, text]) => path.includes(".corrupt-") && text === "{interrupted")).toBe(true);
    expect(learningContext(read, { source: "math.md" }).revision).toBe(learningContext(await f.store.listResult(), { source: "math.md" }).revision);
  });
  it("keeps a broken primary isolated when its backup is invalid or belongs to another ID", async () => {
    const f = setup(); f.files.set(f.path, "{interrupted");
    for (const backup of ["{also broken", JSON.stringify({ ...f.record, id: crypto.randomUUID() })]) {
      f.files.set(f.path + ".previous", backup);
      const read = await f.store.listResult();
      expect(read.records).toEqual([]); expect(read.completeness).toBe("partial");
      expect(read.integrityIssues.map(issue => issue.category)).toEqual(["corrupt", "backup-invalid"]);
      expect(f.files.get(f.path)).toBe("{interrupted");
    }
  });
  it("checks identities even when the primary JSON passes its schema", async () => {
    const f = setup(); f.files.set(f.path, JSON.stringify({ ...f.record, id: crypto.randomUUID() }));
    expect(await f.store.listResult()).toMatchObject({ records: [], integrityIssues: [{ category: "identity-mismatch" }] });
  });
  it("isolates duplicate canonical file identities", async () => {
    const f = setup();
    const id = "abcdef01-2345-4678-9abc-def012345678", record = { ...f.record, id };
    f.files.clear();
    for (const name of [id, id.toUpperCase()]) f.files.set(`${f.root}/${name}.json`, JSON.stringify(record));
    const read = await f.store.listResult();
    expect(read.records).toEqual([]); expect(read.integrityIssues.map(issue => issue.category)).toEqual(["duplicate-id", "duplicate-id"]);
  });
  it("preserves an unsupported future format without downgrading from its backup", async () => {
    const f = setup(), future = JSON.stringify({ ...f.record, format: 3, newEvidence: "future" });
    f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, future);
    expect(await f.store.listResult()).toMatchObject({ records: [], integrityIssues: [{ category: "unsupported-format" }] });
    expect(f.files.get(f.path)).toBe(future); expect([...f.files.keys()].some(path => path.includes(".corrupt-"))).toBe(false);
  });
  it("identifies oversize data before JSON parsing", async () => {
    const f = setup(); f.files.set(f.path, "x".repeat(MAX_LEARNING_RECORD_BYTES + 1));
    expect(await f.store.listResult()).toMatchObject({ records: [], integrityIssues: [{ category: "too-large" }] });
    expect(f.files.get(f.path)?.length).toBe(MAX_LEARNING_RECORD_BYTES + 1);
  });
  it("never restores a deleted record from an old backup, including an empty barrier", async () => {
    const f = setup(); f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken"); f.files.set(f.path + ".deleted", "");
    expect(await f.store.listResult()).toMatchObject({ records: [], completeness: "complete", integrityIssues: [] });
    expect(f.files.get(f.path)).toBe("{broken");
  });
  it("rechecks a deletion barrier created while archiving corrupt bytes", async () => {
    const f = setup(); f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken");
    const write = f.io.write;
    f.io.write = async (path, text) => { await write(path, text); if (path.includes(".corrupt-")) f.files.set(f.path + ".deleted", "deleted"); };
    expect((await f.store.listResult()).records).toEqual([]); expect(f.files.get(f.path)).toBe("{broken");
  });
  it("does not expose a recovered backup when deletion occurs at the compare-write boundary", async () => {
    const f = setup(); f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken");
    const compareWrite = f.io.compareWrite;
    f.io.compareWrite = async (path, old, next) => { f.files.set(path + ".deleted", "deleted"); await compareWrite(path, old, next); };
    expect((await f.store.listResult()).records).toEqual([]); expect((await f.store.listResult()).records).toEqual([]);
  });
  it("keeps and reads an external repair that wins the restoration race", async () => {
    const f = setup(), repaired = { ...f.record, revision: 17 };
    f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken");
    const compareWrite = f.io.compareWrite;
    f.io.compareWrite = async (path, old, next) => { f.files.set(path, JSON.stringify(repaired)); await compareWrite(path, old, next); };
    expect(await f.store.listResult()).toMatchObject({ completeness: "complete", records: [{ revision: 17 }], integrityIssues: [{ category: "recovery-conflict", recovered: true }] });
    expect(JSON.parse(f.files.get(f.path)!).revision).toBe(17);
  });
  it("does not accumulate another preservation copy every time a failed restore is read", async () => {
    const f = setup(); f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken");
    f.io.compareWrite = async () => { throw new Error("write unavailable"); };
    await f.store.listResult(); await f.store.listResult(); await f.store.listResult();
    expect([...f.files.keys()].filter(path => path.includes(".corrupt-"))).toHaveLength(1);
    expect(f.files.get(f.path)).toBe("{broken");
  });
  it("retains the damaged primary if its preservation copy cannot be saved", async () => {
    const f = setup(); f.files.set(f.path + ".previous", f.files.get(f.path)!); f.files.set(f.path, "{broken");
    f.io.write = async () => { throw new Error("disk full"); };
    const read = await f.store.listResult();
    expect(read.records).toEqual([]); expect(read.integrityIssues.map(issue => issue.category)).toContain("recovery-failed");
    expect(f.files.get(f.path)).toBe("{broken");
  });
  it("rejects invalid evidence cross-references before projection", async () => {
    const f = setup();
    const broken = format === 1 ? { ...recordAttempt(f.record as LearningEpisode, "4"), evidence: [{ ...recordAttempt(f.record as LearningEpisode, "4").evidence[0]!, questionId: "missing-question" }] } : { ...f.record, currentQuestionId: crypto.randomUUID() };
    f.files.set(f.path, JSON.stringify(broken));
    const read = await f.store.listResult();
    expect(read).toMatchObject({ records: [], integrityIssues: [{ category: "cross-reference" }] });
    expect(learningContext(read, { source: "math.md" })).toMatchObject({ episodes: [], completeness: "unavailable" });
  });
});

describe("scoped learning integrity and invalidation", () => {
  it("leaves another document's evidence revision and dialogue valid when known unrelated records break", async () => {
    const m = memory(), store = new LearningV2Store(m.io, "v2"), a = await store.save(makeV2("a.md")), b = await store.save(makeV2("b.md"));
    const dialogue = new LearningDialogue(store, async () => []), conversationId = crypto.randomUUID();
    const turn = await dialogue.prepare({ source: a.source, conversationId, requestId: crypto.randomUUID(), text: "继续", episodeId: a.id });
    const before = learningContext(await store.listResult(), { source: "a.md" });
    const path = `v2/${b.id}.json`; m.files.set(path, "{broken");
    const change = await store.change(path);
    expect(change).toMatchObject({ recordId: b.id, sources: ["b.md"], unknownScope: false });
    const read = await store.listResult();
    expect(learningContext(read, { source: "a.md" }).revision).toBe(before.revision);
    expect(learningContext(read, { source: "b.md" })).toMatchObject({ completeness: "unavailable", episodes: [] });
    expect(await dialogue.apply(turn, { type: "none" }, new AbortController().signal)).toBe("");
  });
  it("does not equate missing relevant history with never having learned or offer a replacement", async () => {
    const m = memory(), v1 = new LearningEpisodeStore(m.io, "v1"), store = new LearningV2Store(m.io, "v2"), record = await store.save(makeV2());
    m.files.set(`v2/${record.id}.json`, "{broken");
    const dialogue = new LearningDialogue(store, () => v1.listResult());
    const turn = await dialogue.prepare({ source: record.source, conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: "解释极限" });
    expect(turn).toMatchObject({ completeness: "unavailable", canInvite: false });
    expect(dialogue.instructions(turn)).toContain('"learningCompleteness":"unavailable"');
    expect(await dialogue.apply(turn, { type: "invite", concept: "value-limit" }, new AbortController().signal)).toBe("");
    expect(await dialogue.apply(turn, { type: "none" }, new AbortController().signal)).toBe("");
    const snapshot = learningContext(combineRecordReadResults<LearningEpisode | EpisodeV2>([await v1.listResult(), await store.listResult()]), { source: "math.md" });
    expect(snapshot.summary).toContain("本次解释可继续");
    expect(JSON.stringify(snapshot.integrityIssues)).not.toContain("math.md");
  });
  it("invalidates an affected turn while another source's successful save does not invalidate it", async () => {
    const m = memory(), store = new LearningV2Store(m.io, "v2"), a = await store.save(makeV2("a.md"));
    const dialogue = new LearningDialogue(store, async () => []);
    const turn = await dialogue.prepare({ source: a.source, conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: "提示", episodeId: a.id });
    await store.save(makeV2("b.md"));
    expect(await dialogue.apply(turn, { type: "none" }, new AbortController().signal)).toBe("");
    const path = `v2/${a.id}.json`; m.files.set(path, JSON.stringify({ ...a, revision: a.revision + 1 }));
    await store.change(path);
    await expect(dialogue.apply(turn, { type: "none" }, new AbortController().signal)).rejects.toThrow("Learning context changed");
  });
  it("refuses to overwrite an externally replaced record even when its revision matches", async () => {
    const m = memory(), v1 = new LearningEpisodeStore(m.io, "v1"), v2 = new LearningV2Store(m.io, "v2");
    const a = await v1.save(makeV1()), b = await v2.save(makeV2());
    const otherA = JSON.stringify({ ...a, id: crypto.randomUUID() }), otherB = JSON.stringify({ ...b, id: crypto.randomUUID() });
    m.files.set(`v1/${a.id}.json`, otherA); m.files.set(`v2/${b.id}.json`, otherB);
    await expect(v1.save(a)).rejects.toThrow("identity-mismatch"); await expect(v2.save(b)).rejects.toThrow("identity-mismatch");
    expect(m.files.get(`v1/${a.id}.json`)).toBe(otherA); expect(m.files.get(`v2/${b.id}.json`)).toBe(otherB);
  });
  it("does not classify completed local saves or their sidecars as external changes", async () => {
    const m = memory(), store = new LearningV2Store(m.io, "v2");
    const record = await store.save(makeV2()), path = `v2/${record.id}.json`;
    await store.save({ ...record, status: "paused" });
    expect(await store.change(path)).toBeNull(); expect(await store.change(path + ".previous")).toBeNull();
    await store.remove(record.id);
    expect(await store.change(path)).toBeNull(); expect(await store.change(path + ".deleted")).toBeNull();
  });
  it("publishes successful local v1/v2 commits once and excludes the originating v2 request from cancellation",async()=>{
    const m=memory(),v1=new LearningEpisodeStore(m.io,"v1"),v2=new LearningV2Store(m.io,"v2"),readers=new LearningInvalidation();
    const own=new AbortController(),other=new AbortController(),unrelated=new AbortController();
    readers.track({source:"math.md"},()=>own.abort(),{requestId:"own"});
    readers.track({source:"math.md"},()=>other.abort(),{requestId:"other"});
    readers.track({source:"elsewhere.md"},()=>unrelated.abort());
    const commits:string[]=[];
    const stop=v2.subscribeCommits(change=>{commits.push(change.recordId);readers.changed(change);});
    const record=await v2.save(makeV2(),own.signal,"own");
    expect(own.signal.aborted).toBe(false);expect(other.signal.aborted).toBe(true);expect(unrelated.signal.aborted).toBe(false);
    expect(await v2.changed(`v2/${record.id}.json`)).toBe(false);expect(commits).toEqual([record.id]);
    stop();await v2.save({...record,status:"paused"});expect(commits).toHaveLength(1);
    v1.subscribeCommits(change=>readers.changed(change));await v1.save(makeV1());expect(own.signal.aborted).toBe(true);
  });
  it("publishes a backup restoration but does not publish a failed save",async()=>{
    const m=memory(),store=new LearningV2Store(m.io,"v2");
    const record=await store.save(makeV2()),path=`v2/${record.id}.json`;await store.save({...record,status:"paused"});
    const commits:string[]=[];store.subscribeCommits(change=>commits.push(change.recordId));
    m.files.set(path,"{broken");await store.listResult();await store.listResult();expect(commits).toEqual([record.id]);
    m.io.compareWrite=async()=>{throw new Error("full");};
    await expect(store.save({...record,status:"paused"})).rejects.toThrow("full");expect(commits).toEqual([record.id]);
  });
  it("invalidates evidence once its deletion barrier is durable even if the following save fails",async()=>{
    const m=memory(),store=new LearningV2Store(m.io,"v2"),record=await store.save(makeV2()),reader=new AbortController();
    const scopes=new LearningInvalidation();scopes.track({source:"math.md"},()=>reader.abort());
    store.subscribeCommits(change=>scopes.changed(change));
    const compare=m.io.compareWrite;m.io.compareWrite=async(path,previous,text)=>{if(path.endsWith(".previous"))throw new Error("full");await compare(path,previous,text);};
    await expect(store.save({...record,status:"deleted",evidence:[]})).rejects.toThrow("full");
    expect(reader.signal.aborted).toBe(true);expect(await store.list()).toEqual([]);
  });
});

describe("historical v2 evidence without deduplication receipts",()=>{
  async function legacyFixture(){
    const m=memory(),store=new LearningV2Store(m.io,"v2"),record=await store.save(makeV2()),path=`v2/${record.id}.json`;
    // The old verify-natural-expert.mjs fixture appended evidence and called save
    // without adding its requestId to requests. The old v2 schema allowed this.
    const evidence:EpisodeV2["evidence"][number]={id:crypto.randomUUID(),requestId:crypto.randomUUID(),at:new Date().toISOString(),questionId:record.currentQuestionId,
      answer:"合成旧证据",help:{hints:0,answerShown:false},kind:"explanation",evaluator:"learner",outcome:"unreviewed",feedback:"待核对的合成判断"};
    const legacy={...record,evidence:[evidence]};m.files.set(path,JSON.stringify(legacy));
    return {...m,store,path,legacy,evidence};
  }
  it("reads the old schema-valid save without changing bytes or inventing a receipt",async()=>{
    const f=await legacyFixture(),raw=f.files.get(f.path);
    const result=await f.store.listResult();
    expect(result).toMatchObject({completeness:"complete",integrityIssues:[],records:[{id:f.legacy.id,evidence:[f.evidence]}]});
    expect(f.files.get(f.path)).toBe(raw);expect(result.records[0]!.requests).toEqual(f.legacy.requests);
  });
  it("continues with the full legacy evidence unchanged while recording valid new evidence separately",async()=>{
    const f=await legacyFixture(),newRequest=crypto.randomUUID(),nextEvidence={...f.evidence,id:crypto.randomUUID(),requestId:newRequest,answer:"新的合成作答"};
    const saved=await f.store.save({...f.legacy,status:"paused",requests:[...f.legacy.requests,newRequest],evidence:[f.evidence,nextEvidence]});
    expect(saved.evidence[0]).toEqual(f.evidence);expect(saved.requests).not.toContain(f.evidence.requestId);
    expect((await f.store.listResult()).completeness).toBe("complete");
  });
  it("allows removing old evidence without backfilling historical receipts",async()=>{
    const f=await legacyFixture(),saved=await f.store.save({...f.legacy,evidence:[]});
    expect(saved.evidence).toEqual([]);expect(saved.requests).toEqual(f.legacy.requests);
  });
  it.each(["answer","outcome","feedback","help","at"] as const)("rejects a change to the old evidence's %s",async field=>{
    const f=await legacyFixture(),altered=structuredClone(f.evidence),raw=f.files.get(f.path);
    if(field==="answer")altered.answer="替换答案";
    if(field==="outcome")altered.outcome="correct";
    if(field==="feedback")altered.feedback="替换判断";
    if(field==="help")altered.help.hints++;
    if(field==="at")altered.at="2000-01-01T00:00:00.000Z";
    await expect(f.store.save({...f.legacy,evidence:[altered]})).rejects.toThrow("legacy-evidence-changed");
    expect(f.files.get(f.path)).toBe(raw);
  });
  it("does not permit manufacturing a missing receipt to bypass the legacy evidence guard",async()=>{
    const f=await legacyFixture();
    await expect(f.store.save({...f.legacy,requests:[...f.legacy.requests,f.evidence.requestId]})).rejects.toThrow("legacy-receipt-backfill");
    await expect(f.store.save({...f.legacy,requests:[...f.legacy.requests,f.evidence.requestId],evidence:[{...f.evidence,answer:"替换答案"}]})).rejects.toThrow("legacy-evidence-changed");
  });
  it("rejects newly introduced evidence without a receipt on existing and newly created records",async()=>{
    const f=await legacyFixture(),additional={...f.evidence,id:crypto.randomUUID(),requestId:crypto.randomUUID()};
    await expect(f.store.save({...f.legacy,evidence:[f.evidence,additional]})).rejects.toThrow("evidence-request-missing");
    const fresh=makeV2();
    await expect(f.store.save({...fresh,evidence:[{...additional,questionId:fresh.currentQuestionId}]})).rejects.toThrow("evidence-request-missing");
    expect(f.files.has(`v2/${fresh.id}.json`)).toBe(false);
  });
  it("cannot remove a valid receipt and reclassify unchanged evidence as historical",async()=>{
    const f=await legacyFixture(),newRequest=crypto.randomUUID(),normal={...f.evidence,id:crypto.randomUUID(),requestId:newRequest};
    const saved=await f.store.save({...f.legacy,requests:[...f.legacy.requests,newRequest],evidence:[f.evidence,normal]}),raw=f.files.get(f.path);
    await expect(f.store.save({...saved,requests:saved.requests.filter(id=>id!==newRequest)})).rejects.toThrow("evidence-request-missing");
    expect(f.files.get(f.path)).toBe(raw);
  });
  it("compares the complete legacy evidence against the current serialized disk read",async()=>{
    const f=await legacyFixture(),originalRead=f.io.read;
    let started!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    let wait=true;
    f.io.read=async path=>{if(path===f.path&&wait){wait=false;started();await gate;}return originalRead(path);};
    const pending=f.store.save({...f.legacy,status:"paused"});await entered;
    const externallyUpdated={...f.legacy,evidence:[{...f.evidence,feedback:"外部更新的合成判断"}]};
    f.files.set(f.path,JSON.stringify(externallyUpdated));release();
    await expect(pending).rejects.toThrow("legacy-evidence-changed");
    expect(JSON.parse(f.files.get(f.path)!).evidence).toEqual(externallyUpdated.evidence);
  });
  it("still isolates a historical record with an invalid question or correction reference",async()=>{
    const f=await legacyFixture();
    for(const evidence of [{...f.evidence,questionId:crypto.randomUUID()},{...f.evidence,corrects:crypto.randomUUID()}]){
      f.files.set(f.path,JSON.stringify({...f.legacy,evidence:[evidence]}));
      expect(await f.store.listResult()).toMatchObject({records:[],integrityIssues:[{category:"cross-reference"}]});
    }
  });
});
