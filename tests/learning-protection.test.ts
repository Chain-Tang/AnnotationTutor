import { describe, expect, it } from "vitest";
import { episodeProtectionSchema, freshQuestionToken, LEARNING_PROTECTION_MAX_BYTES, questionIndependence, questionProtectionDigest, questionContentDigest, type HostNewQuestionToken } from "../src/learning-protection.js";
import { questionRefV3 } from "../src/learning-v3.js";
import { addProtectedAnswer, addProtectedHelp, protectionFixture } from "./learning-protection-fixture.js";

describe("durable question protection", () => {
  it("creates only bounded, strict references and survives reopening", async () => {
    const f = protectionFixture(), e = await f.store.save(addProtectedAnswer(f.episode));
    const raw = f.files.get(f.guardPath)!;
    expect(Buffer.byteLength(raw)).toBeLessThan(LEARNING_PROTECTION_MAX_BYTES);
    expect(episodeProtectionSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    for (const text of ["Synthetic", "prompt", "answer", "explanation", "feedback"]) expect(raw).not.toContain(text);
    const read = await f.reopen().readEffectiveResult(), p = read.protectionByEpisode.get(e.id)!;
    expect(read.completeness).toBe("complete"); expect(p.status).toBe("valid");
    expect(questionIndependence(e, e.currentQuestionId, 1, p)).toBe("no-plugin-help");
    expect(questionIndependence(e, e.currentQuestionId, 1)).toBe("unknown");
  });

  it("does not retroactively mark an earlier answer as helped by its later feedback", async () => {
    const f = protectionFixture(), e = await f.store.save(addProtectedHelp(addProtectedAnswer(f.episode)));
    const p = await f.store.protection.read(e.id);
    expect(p.questions.get(e.currentQuestionId)?.blockedFromSequence).toBe(2);
    expect(questionIndependence(e, e.currentQuestionId, 1, p)).toBe("no-plugin-help");
    expect(questionIndependence(e, e.currentQuestionId, 3, p)).toBe("unknown");
    e.help[0]!.state = "presented";
    const presented = await f.store.save(e);
    expect(questionIndependence(presented, e.currentQuestionId, 3, await f.store.protection.read(e.id))).toBe("helped");
  });

  it("merges concurrent floors and reasons without stale rollback", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), other = f.reopen().protection;
    await Promise.all([
      f.store.protection.block({ episodeId: e.id, questions: [{ ref: e.questions[0]!, fromSequence: 8 }], reason: "help-prepared" }),
      other.block({ episodeId: e.id, questions: [{ ref: e.questions[0]!, fromSequence: 2 }], reason: "external-uncertainty" }),
    ]);
    const before = await other.read(e.id);
    expect(before.questions.get(e.currentQuestionId)).toMatchObject({ blockedFromSequence: 2, reasons: ["external-uncertainty", "help-prepared"] });
    await other.block({ episodeId: e.id, questions: [{ ref: e.questions[0]!, fromSequence: 9 }], reason: "help-prepared" });
    expect((await other.read(e.id)).revision).toBe(before.revision);
  });

  it.each(["missing", "corrupt", "unsupported", "identity-mismatch"] as const)("projects %s protection as unknown and partial without overwriting it", async status => {
    const f = protectionFixture(), e = await f.store.save(addProtectedAnswer(f.episode));
    const good = JSON.parse(f.files.get(f.guardPath)!);
    if (status === "missing") f.files.delete(f.guardPath);
    if (status === "corrupt") f.files.set(f.guardPath, "{broken");
    if (status === "unsupported") f.files.set(f.guardPath, JSON.stringify({ ...good, version: 2 }));
    if (status === "identity-mismatch") f.files.set(f.guardPath, JSON.stringify({ ...good, episodeId: crypto.randomUUID() }));
    const before = new Map(f.files), result = await f.reopen().readEffectiveResult(), p = result.protectionByEpisode.get(e.id)!;
    expect(p.status).toBe(status); expect(result.completeness).toBe("partial"); expect(f.files).toEqual(before);
    expect(questionIndependence(e, e.currentQuestionId, 1, p)).toBe("unknown");
  });

  it("rebuilds an existing question with floor one and rejects a new unsupported no-help claim", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode); f.files.delete(f.guardPath);
    await expect(f.reopen().save(addProtectedAnswer(e))).rejects.toThrow("independence-unverified");
    const p = await f.store.protection.read(e.id);
    expect(p.questions.get(e.currentQuestionId)).toMatchObject({ blockedFromSequence: 1, reasons: ["protection-rebuilt"] });
    expect(JSON.parse(f.files.get(f.path)!).evidence).toHaveLength(0);
    const candidate = addProtectedAnswer(structuredClone(JSON.parse(f.files.get(f.path)!)), "unknown");
    expect((await f.reopen().save(candidate)).evidence).toHaveLength(1);
  });

  it("cannot manufacture fresh authority from explicit IDs, serialized tokens or a mutated generated reference", async () => {
    const f = protectionFixture(), original = f.episode.questions[0]!, explicit = questionRefV3(original.concept, original.pool, original.seed, original.id);
    expect(freshQuestionToken(explicit)).toBeUndefined(); expect(freshQuestionToken(structuredClone(original))).toBeUndefined();
    const token = freshQuestionToken(original)!;
    await expect(f.store.protection.registerFreshQuestion({ episodeId: f.episode.id, question: original, token: {} as HostNewQuestionToken })).rejects.toThrow("capability-required");
    original.id = crypto.randomUUID(); expect(freshQuestionToken(original)).toBeUndefined();
    await expect(f.store.protection.registerFreshQuestion({ episodeId: f.episode.id, question: original, token })).rejects.toThrow("capability-required");
    expect(f.files.size).toBe(0);
  });

  it("cannot reuse a consumed in-memory token to clean a removed protection file", async () => {
    const f = protectionFixture(), q = f.episode.questions[0]!, token = freshQuestionToken(q)!;
    await f.store.save(f.episode); f.files.delete(f.guardPath); f.files.delete(f.path);
    await expect(f.store.protection.registerFreshQuestion({ episodeId: f.episode.id, question: q, token })).rejects.toThrow("capability-consumed");
    expect(f.files.has(f.guardPath)).toBe(false);
  });

  it("retries the same unconfirmed capability only after a provably unchanged failed CAS", async () => {
    const f = protectionFixture(), compare = f.io.compareWrite;
    f.io.compareWrite = async () => { throw new Error("before-write"); };
    await expect(f.store.save(f.episode)).rejects.toThrow("before-write"); expect(f.files.size).toBe(0);
    f.io.compareWrite = compare;
    const saved = await f.store.save(f.episode), p = await f.store.protection.read(saved.id);
    expect(p.questions.get(saved.currentQuestionId)?.blockedFromSequence).toBeNull();
    expect((await f.store.list()).map(e=>e.id)).toEqual([saved.id]);
  });

  it.each(["", ".previous", ".deleted"])("does not retry an unconfirmed fresh registration after a %s record appears", async suffix => {
    const f = protectionFixture(), compare = f.io.compareWrite, question = f.episode.questions[0]!, token = freshQuestionToken(question)!;
    f.io.compareWrite = async () => { throw new Error("before-write"); };
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow("before-write");
    f.io.compareWrite = compare; f.files.set(f.path+suffix, suffix===".deleted"?"deleted":JSON.stringify(f.episode));
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow();
    expect(f.files.has(f.guardPath)).toBe(false);
  });

  it("retains a blocked guard after write-then-throw and never reopens fresh when it is later lost", async () => {
    const f = protectionFixture(), compare = f.io.compareWrite, question = f.episode.questions[0]!, token = freshQuestionToken(question)!;
    f.io.compareWrite = async (path,before,after) => {
      await compare(path,before,after);
      if(path===f.guardPath){const guard=JSON.parse(f.files.get(path)!);guard.questions[0].blockedFromSequence=1;guard.questions[0].reasons=["external-uncertainty"];f.files.set(path,JSON.stringify(guard));throw new Error("after-write");}
    };
    const p = await f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token});
    expect(p.questions.get(question.id)?.blockedFromSequence).toBe(1);
    f.files.delete(f.guardPath); f.io.compareWrite=compare;
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow("capability-consumed");
    expect(f.files.has(f.guardPath)).toBe(false);
  });

  it("an eligible retry preserves a newly blocked matching guard", async () => {
    const f=protectionFixture(), compare=f.io.compareWrite, question=f.episode.questions[0]!, token=freshQuestionToken(question)!;
    f.io.compareWrite=async()=>{throw new Error("before-write");};
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow("before-write");
    f.io.compareWrite=compare;
    const blocked=await f.store.protection.block({episodeId:f.episode.id,questions:[{ref:question,fromSequence:1}],reason:"external-uncertainty"});
    const retried=await f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token});
    expect(retried.revision).toBe(blocked.revision);expect(retried.questions.get(question.id)?.blockedFromSequence).toBe(1);
  });

  it("does not treat an unreadable write outcome as permission to register fresh again", async () => {
    const f=protectionFixture(), read=f.io.read, compare=f.io.compareWrite, question=f.episode.questions[0]!, token=freshQuestionToken(question)!;
    let failed=false;
    f.io.compareWrite=async()=>{failed=true;throw new Error("uncertain-write");};
    f.io.read=async path=>{if(failed&&path===f.guardPath)throw new Error("unreadable-outcome");return read(path);};
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow("unreadable-outcome");
    f.io.read=read;f.io.compareWrite=compare;
    await expect(f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token})).rejects.toThrow("capability-consumed");
    expect(f.files.size).toBe(0);
  });

  it("binds a fresh capability before concurrent registration in a second episode", async () => {
    const f=protectionFixture(), question=f.episode.questions[0]!, token=freshQuestionToken(question)!;
    const first=f.store.protection.registerFreshQuestion({episodeId:f.episode.id,question,token});
    await expect(f.store.protection.registerFreshQuestion({episodeId:crypto.randomUUID(),question,token})).rejects.toThrow("capability-required");
    await first;expect(f.files.size).toBe(1);
  });

  it("cannot mint fresh authority for a question found in .previous", async () => {
    const f = protectionFixture(); f.files.set(f.path + ".previous", JSON.stringify(f.episode));
    await expect(f.store.save(f.episode)).rejects.toThrow("question-is-not-new");
    expect(f.files.has(f.path)).toBe(false); expect(f.files.has(f.guardPath)).toBe(false);
  });

  it.each([0,75])("cannot rename an existing authored question into a fresh UUID with seed %i", async seed => {
    const f = protectionFixture(), e = await f.store.save(f.episode), q = questionRefV3(e.concept, "practice", seed);
    e.questions.push(q); e.currentQuestionId = q.id;
    await expect(f.store.save(e)).rejects.toThrow("question-is-not-new");
    expect((await f.store.protection.read(e.id)).questions.has(q.id)).toBe(false);
  });

  it("preserves unknown or corrupt protection when an attempted write is rejected", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode); f.files.set(f.guardPath, '{"version":99}');
    const before = new Map(f.files); await expect(f.reopen().save(addProtectedHelp(e))).rejects.toThrow("unsupported"); expect(f.files).toEqual(before);
  });

  it("validates duplicate entries, reason ordering, unknown fields and capacity", () => {
    const f = protectionFixture(), q = { questionId: f.episode.currentQuestionId, questionDigest: questionProtectionDigest(f.episode.questions[0]!), contentDigest: questionContentDigest(f.episode.questions[0]!), blockedFromSequence: null, reasons: [] };
    const guard = { format: "learning-protection", version: 1, episodeId: f.episode.id, revision: 0, questions: [q] };
    expect(episodeProtectionSchema.safeParse(guard).success).toBe(true);
    for (const bad of [{ ...guard, questions: [q, q] }, { ...guard, notes: "PRIVATE_PROSE" }, { ...guard, questions: [{ ...q, blockedFromSequence: 1, reasons: ["record-recovered", "help-prepared"] }] }, { ...guard, questions: Array.from({ length: 257 }, () => ({ ...q, questionId: crypto.randomUUID() })) }]) expect(episodeProtectionSchema.safeParse(bad).success).toBe(false);
  });

  it("bounds corrupt oversized protection reads", async () => {
    const f = protectionFixture(); f.files.set(f.guardPath, "x".repeat(LEARNING_PROTECTION_MAX_BYTES + 1));
    expect((await f.store.protection.read(f.episode.id)).status).toBe("corrupt");
  });

  it("isolates protection and final deletion-check read failures per record", async () => {
    const f = protectionFixture(), first = await f.store.save(f.episode), secondFixture = protectionFixture();
    const second = await f.store.save(secondFixture.episode), read = f.io.read;
    f.io.read = async path => { if(path === f.guardPath) throw new Error("guard-unavailable"); return read(path); };
    let result = await f.reopen().readEffectiveResult();
    expect(result.records).toHaveLength(2); expect(result.completeness).toBe("partial");
    expect(result.protectionByEpisode.get(first.id)?.status).toBe("read-failed");
    let barrierReads = 0;
    f.io.read = async path => { if(path === f.path + ".deleted" && ++barrierReads > 1) throw new Error("barrier-unavailable"); return read(path); };
    result = await f.reopen().readEffectiveResult();
    expect(result.records.map(e=>e.id)).toEqual([second.id]); expect(result.completeness).toBe("partial");
    expect(result.integrityIssues).toContainEqual(expect.objectContaining({recordId:first.id,category:"read-failed"}));
  });

  it("scopes sidecar invalidation and suppresses its own delayed watch event", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode);
    expect(await f.store.change(f.guardPath)).toBeNull();
    const before = (await f.store.readEffectiveResult()).revision;
    await f.reopen().protection.block({ episodeId: e.id, questions: [{ ref: e.questions[0]!, fromSequence: 1 }], reason: "external-uncertainty" });
    // A reader may discover the new bytes before the host delivers its watch event.
    await f.store.readEffectiveResult();
    expect(await f.store.change(f.guardPath)).toMatchObject({ recordId: e.id, sources: ["Synthetic/math.md"], unknownScope: false });
    expect((await f.store.readEffectiveResult()).revision).not.toBe(before);
    expect(await f.store.change("unrelated/file.json")).toBeNull();
  });

  it("keeps related discussion and an explicitly uncertain answer unknown", async () => {
    const f = protectionFixture(), e = addProtectedHelp(f.episode, "presented");
    e.help[0]!.kind = "related-discussion";
    const saved = await f.store.save(e), p = await f.store.protection.read(e.id);
    expect(questionIndependence(saved, e.currentQuestionId, 2, p)).toBe("unknown");
    const clean = protectionFixture(), uncertain = await clean.store.save(addProtectedAnswer(clean.episode, "unknown"));
    expect(questionIndependence(uncertain, uncertain.currentQuestionId, 1, await clean.store.protection.read(uncertain.id))).toBe("unknown");
  });

  it("reports failed primary writes that already changed effective protection", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), requestId = crypto.randomUUID(), commits: unknown[] = [];
    f.store.subscribeCommits(change => commits.push(change));
    const compare = f.io.compareWrite; f.io.compareWrite = async (path, before, after) => { if (path === f.path) throw new Error("primary-failed"); await compare(path, before, after); };
    await expect(f.store.save(addProtectedHelp(e), undefined, requestId)).rejects.toThrow("primary-failed");
    expect(commits).toEqual([expect.objectContaining({ recordId: e.id, requestId, sources: [e.source.path] })]);
    expect(questionIndependence(e, e.currentQuestionId, 2, await f.store.protection.read(e.id))).toBe("unknown");
  });
});
