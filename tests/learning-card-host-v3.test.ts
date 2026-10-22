import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { LearningCardV3, type LearningCardActionScope } from "../src/learning-card-v3.js";
import { LearningCommandsV3, type LearningCommandResult } from "../src/learning-commands-v3.js";
import { LearningDialogueV3 } from "../src/learning-dialogue-v3.js";
import { LearningV3Store, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { LearningV2Store, createEpisodeV2 } from "../src/learning-v2.js";
import { LearningEpisodeStore } from "../src/learning-episode-store.js";
import { LearningFlow } from "../src/learning-flow.js";
import { createEpisode } from "../src/learning-episode.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { LearningInvalidation, LearningSessionReferences, type LearningScopeChange } from "../src/learning-invalidation.js";
import { learningContext, type LearningContextQuery, type LearningContextRecord, type LearningContextSnapshot } from "../src/learning-context.js";
import { combineRecordReadResults, type LearningIO, type RecordReadResult } from "../src/learning-record-read.js";
import { hasLocalLearnerAuthority, localLearnerAuthority, permitsLearningControl } from "../src/learning-control-v3.js";
import { runLearningTurnV3, type LearningRunResultV3 } from "../src/learning-runner-v3.js";
import { questionIndependence, type EpisodeProtectionV1, type ProtectionSnapshot } from "../src/learning-protection.js";
import { normalizeMemoryRoot } from "../src/settings-config.js";
import { contextVersion } from "../src/teaching-policy.js";

class TFile { constructor(public path: string) {} extension = "md"; stat = { mtime: 1, size: 4 }; }
class TFolder { children: unknown[] = []; }
// Execute main's actual methods, replacing only unrelated Obsidian services.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
function methods(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("Card host fixture needs updated method boundaries");
  return source.slice(from, to);
}
const dependencies = { LearningCardV3, LearningCommandsV3, LearningDialogueV3, LearningV3Store, LearningV2Store, LearningEpisodeStore,
  LearningFlow, learningContext, combineRecordReadResults, localLearnerAuthority, hasLocalLearnerAuthority, permitsLearningControl,
  runLearningTurnV3, contextVersion, normalizeMemoryRoot, TFile, TFolder, normalizePath: (path: string) => path,
  // Buffer selection itself is covered by learning-source-version-host; these
  // tests vary the source revision while exercising real card/evidence writes.
  readStudySource:(host:{tutorContext:(path:string)=>Promise<unknown>},path:string)=>host.tutorContext(path),
  learningVaultIO: (app: { learningIO: LearningIO }) => app.learningIO,
  TutorJournal: class { async flush() {} }, emptyLibrarySnapshot: () => ({}), t: (key: string) => key };
const module = { exports: {} };
new Function("module", ...Object.keys(dependencies), transformSync(`class Host {
  private readonly requestingAgents = new Set<string>();
  private readonly runningAgents = new Set<string>();
  private indexRefresh: Promise<void> = Promise.resolve();
  ${methods("  private sharedTutorSettingsKey()", "\n  /** Coalesce the rapid geometry writes")}
  ${methods("  public async changeMemoryRoot(", "\n  public onSettingsChanged()")}
  ${methods("  public async learningSource(", "\n  public async learningHelp(")}
}; module.exports=Host;`, { loader: "ts", format: "cjs" }).code)(module, ...Object.values(dependencies));
type CardAction = (card: LearningCardV3, scope: LearningCardActionScope) => Promise<LearningRunResultV3>;
type CardOptions = { newRecord?: boolean; source?: EpisodeV3["source"] };
type Host = {
  settings: { memoryRoot: string }; upgrading: boolean; learningInputsPaused: boolean;
  learningCard: LearningCardV3; learningDialogue: LearningDialogueV3; learningV3: LearningV3Store; learningV2: LearningV2Store; learning: LearningFlow;
  learningRuns: Map<AbortController, Promise<void>>;
  initializeLearningDialogue(): void; stopLearningRuns(): Promise<void>;
  runLearningCard(action: CardAction, present: (text: string) => boolean, options?: CardOptions): Promise<LearningRunResultV3>;
  invalidateLearningReaders(change: LearningScopeChange): void;
  learningReadState(query: LearningContextQuery): Promise<{ read: RecordReadResult<LearningContextRecord>; protection: ReadonlyMap<string, ProtectionSnapshot>; snapshot: LearningContextSnapshot }>;
  changeMemoryRoot(path: string): Promise<{ ok: true } | { ok: false; message: string }>;
};
const Host = module.exports as new () => Host;
function barrier() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, wait: async () => { entered(); await ready; } };
}
async function fixture(start = true) {
  const host = new Host(), files = new Map<string, string>(), note = new TFile("Synthetic/math.md"), other = new TFile("Synthetic/other.md");
  const state = { revision: "v1", observed: "v1", source: note.path, missing: false };
  const io: LearningIO = { read: async path => files.get(path) ?? null, list: async root => [...files.keys()].filter(path => path.startsWith(root + "/")),
    write: async (path, text) => { files.set(path, text); }, compareWrite: async (path, before, next) => { if ((files.get(path) ?? null) !== before) throw new Error("write-conflict"); files.set(path, next); } };
  const boards = { changeRoot: vi.fn(async () => {}), rootChanged: vi.fn() };
  Object.assign(host, { settings: { memoryRoot: "learning", learningDailyMinutes: 20, learningExpertsEnabled: false }, upgrading: false, learningInputsPaused: false,
    app: { learningIO: io, vault: { adapter: {}, getAbstractFileByPath: (path: string) => state.missing ? undefined : [note, other].find(file => file.path === path) } },
    tutorContext: vi.fn(async (path: string) => ({ source: path, text: "note", revision: path === note.path ? state.revision : "other-v1" })),
    captureLearningSource:vi.fn(()=>"fixture-source-lease"),
    chatContext: vi.fn(async () => ({ notePath: state.source, content: "note", observation: { version: state.observed } })),
    learning: new LearningFlow(new LearningEpisodeStore(io, "learning/learning/v1/episodes")), learningRuns: new Map(), learningCommitSubscriptions: [],
    learningCardConversationId: crypto.randomUUID(), learningReaders: new LearningInvalidation(), tutorLearningReferences: new LearningSessionReferences(),
    tutorConversation: { cancel: vi.fn(), flush: vi.fn(async () => {}), reset: vi.fn(), tasks: { cancelAll: vi.fn() } },
    stopBoardMcp: vi.fn(async () => {}), stopTutorCommunication: vi.fn(async () => {}),
    tutorSessionGeneration: 0, tutorSession: null, expertWrites: new Set(), boards,
    initializeLearningInsights: vi.fn(async () => {}), initializeTutorResults: vi.fn(async () => {}), persistSettings: vi.fn(async () => {}), store: { ensureScaffold: vi.fn(async () => {}) }, rebuildIndex: vi.fn(async () => {}), refreshChatViews: vi.fn() });
  host.initializeLearningDialogue(); await host.learningCard.load();
  const shown: string[] = [], present = (text: string) => { shown.push(text); return true; };
  const run = (action: CardAction, options?: CardOptions, presenter = present) => host.runLearningCard(action, presenter, options);
  if (start) await run((card, scope) => card.start(scope, "value-limit"), { newRecord: true });
  const episode = () => { const selected = host.learningCard.snapshot.selected; if (selected?.kind !== "v3") throw new Error("v3 selection required"); return selected.episode; };
  const question = () => { const e = episode(); return renderQuestionV3(e.questions.find(q => q.id === e.currentQuestionId)!); };
  shown.length = 0;
  return { host, io, files, state, note, other, boards, shown, present, run, episode, question };
}

describe("main local card v3 host boundary", () => {
  it("shares commands with dialogue and executes start, answer, explanation and append-only undo", async () => {
    const r = await fixture(false), scopes: LearningCardActionScope[] = [];
    expect(r.host.learningCard.commands).toBe(r.host.learningDialogue.commands);
    const run = (action: CardAction, options?: { newRecord?: boolean }) => r.run((card, scope) => { scopes.push(scope); return action(card, scope); }, options);
    await run((card, scope) => card.start(scope, "value-limit"), { newRecord: true }); const id = r.episode().id, q = r.question();
    await run((card, scope) => card.answer(scope, q.answer)); const answer = r.episode().evidence[0]!;
    await run((card, scope) => card.explanation(scope)); const help = r.episode().help;
    await run((card, scope) => card.undo(scope));
    expect(r.episode().id).toBe(id); expect(r.episode().questions[1]?.pool).toBe("transfer");
    expect(r.episode().evidence).toHaveLength(2); expect(r.episode().evidence[1]).toMatchObject({ type: "correction", corrects: answer.id });
    expect(r.episode().help).toEqual(help); expect(help.every(item => item.state === "presented")).toBe(true);
    expect(scopes.every(scope => hasLocalLearnerAuthority(scope.authority))).toBe(true);
    expect(new Set(scopes.map(scope => scope.requestId)).size).toBe(4); expect(new Set(scopes.map(scope => scope.conversationId)).size).toBe(1);
    expect(await r.host.learning.store.list()).toEqual([]); expect(await r.host.learningV2.list()).toEqual([]); expect(r.host.learningRuns.size).toBe(0);
  });

  it.each(["upgrading", "learningInputsPaused"] as const)("does not invoke a card action while %s", async flag => {
    const r = await fixture(false), action = vi.fn(); r.host[flag] = true;
    await expect(r.run(action, { newRecord: true })).rejects.toThrow("temporarily paused");
    expect(action).not.toHaveBeenCalled(); expect(r.files.size).toBe(0); expect(r.shown).toEqual([]);
  });

  it("does not accept a forged authority substituted by the adapter", async () => {
    const r = await fixture(false);
    await expect(r.run((card, scope) => card.start({ ...scope, authority: {} as never }, "value-limit"), { newRecord: true })).rejects.toThrow("local-learner-required");
    expect(r.files.size).toBe(0); expect(r.host.learningRuns.size).toBe(0);
  });

  it.each(["missing", "stale"] as const)("rejects a %s new-record source before creating consent", async kind => {
    const r = await fixture(false), action = vi.fn(); if (kind === "missing") r.state.missing = true; else r.state.observed = "older";
    await expect(r.run(action, { newRecord: true })).rejects.toThrow(); expect(action).not.toHaveBeenCalled(); expect(r.files.size).toBe(0);
  });

  it("binds a selected record's source instead of the currently focused other note", async () => {
    const r = await fixture(); r.state.source = r.other.path; r.state.observed = "other-v1"; r.state.revision = "edited-v2";
    let captured: LearningCardActionScope | undefined;
    await r.run((card, scope) => { captured = scope; return card.hint(scope); });
    expect(captured!.source).toEqual({ path: r.note.path, version: "edited-v2" });
    expect(r.episode().source).toEqual({ path: r.note.path, version: "v1" }); expect(r.episode().help[0]?.state).toBe("presented");
  });

  it("uses the explicitly captured local annotation source for Start despite later focus changes", async () => {
    const r = await fixture(false), source = { path: r.note.path, version: "v1", annotationId: "synthetic-annotation" };
    r.state.source = r.other.path; r.state.observed = "other-v1";
    await r.run((card, scope) => card.start(scope, "value-limit"), { newRecord: true, source });
    expect(r.episode().source).toEqual(source);
    const before = new Map(r.files);
    await expect(r.run((card, scope) => card.start(scope, "value-limit"), { newRecord: true, source: { ...source, version: "stale" } })).rejects.toThrow();
    expect(r.files).toEqual(before);
  });

  it("rechecks the source lease before answer writes when the note changes during the action", async () => {
    const r = await fixture(), before = new Map(r.files), q = r.question();
    await expect(r.run((card, scope) => { r.state.revision = "changed"; return card.answer(scope, q.answer); })).rejects.toMatchObject({ name: "AbortError" });
    expect(r.files).toEqual(before); expect(r.shown).toEqual([]); expect(r.host.learningRuns.size).toBe(0);
  });

  it("keeps old records read-only and starts a distinct v3 when Start is explicitly requested", async () => {
    const r = await fixture(false), source = { path: r.note.path, version: "v1" };
    const old = await r.host.learning.store.save(createEpisode(source, "value-limit"));
    const v2 = await r.host.learningV2.save(createEpisodeV2(source, instantiateQuestion("value-limit", "practice", 0), { at: new Date().toISOString(), requestId: crypto.randomUUID(), conversationId: crypto.randomUUID() }));
    await r.host.learningCard.load(); const before = new Map(r.files);
    for (const record of [old, v2]) {
      r.host.learningCard.select(`v${record.format}:${record.id}`); const action = vi.fn();
      await expect(r.run(action)).rejects.toThrow("source-unavailable"); expect(action).not.toHaveBeenCalled();
    }
    expect(r.files).toEqual(before);
    await r.run((card, scope) => card.start(scope, "value-limit"), { newRecord: true });
    expect(r.episode().id).not.toBe(old.id); expect(r.episode().id).not.toBe(v2.id);
    for (const [path, raw] of before) expect(r.files.get(path)).toBe(raw);
  });

  it("accepts only the exact protection revision acknowledged by its own command", async () => {
    const r = await fixture(), commands = r.host.learningCard.commands, prepare = commands.prepareHelp.bind(commands);
    vi.spyOn(commands, "prepareHelp").mockImplementation(async (...args) => {
      const saved = await prepare(...args), path = r.host.learningV3.protection.path(saved.episode.id);
      const guard = JSON.parse(r.files.get(path)!) as EpisodeProtectionV1;
      guard.revision++; guard.questions[0]!.reasons = [...new Set([...guard.questions[0]!.reasons, "external-uncertainty" as const])].sort();
      r.files.set(path, JSON.stringify(guard)); return saved;
    });
    await expect(r.run((card, scope) => card.hint(scope))).rejects.toThrow(/protection changed|reply-cancelled/);
    expect(r.shown).toEqual([]); expect(r.episode().help).toHaveLength(1); expect(["prepared", "unknown"]).toContain(r.episode().help[0]?.state);
    expect(questionIndependence(r.episode(), r.question().id, 2, await r.host.learningV3.protection.read(r.episode().id))).toBe("unknown");
    expect(r.host.learningRuns.size).toBe(0);
  });

  it("rejects a missing own-commit acknowledgement without displaying a saved hint", async () => {
    const r = await fixture(), commands = r.host.learningCard.commands, prepare = commands.prepareHelp.bind(commands);
    vi.spyOn(commands, "prepareHelp").mockImplementation(async (...args) => { const result = await prepare(...args); return { ...result, protectionRevision: undefined }; });
    await expect(r.run((card, scope) => card.hint(scope))).rejects.toThrow(/protection changed|reply-cancelled/);
    expect(r.shown).toEqual([]); expect(r.episode().help[0]?.state).toBe("unknown");
  });

  it("does not absorb a foreign primary-record update into its own commit baseline", async () => {
    const r = await fixture(), commands = r.host.learningCard.commands, prepare = commands.prepareHelp.bind(commands);
    vi.spyOn(commands, "prepareHelp").mockImplementation(async (...args) => {
      const result = await prepare(...args), path = `${r.host.learningV3.root}/${result.episode.id}.json`;
      const external = JSON.parse(r.files.get(path)!) as EpisodeV3; external.revision++; external.status = "paused";
      r.files.set(path, JSON.stringify(external)); return result;
    });
    await expect(r.run((card, scope) => card.hint(scope))).rejects.toThrow();
    expect(r.shown).toEqual([]); expect(r.episode().status).toBe("paused"); expect(r.episode().help[0]?.state).not.toBe("presented");
  });

  it.each(["source", "unknown"] as const)("cancels for a foreign %s invalidation, without presenting a late hint", async kind => {
    const r = await fixture(), b = barrier(), before = new Map(r.files);
    const running = r.run(async (card, scope) => { await b.wait(); return card.hint(scope); }), rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await b.reached; r.host.invalidateLearningReaders({ sources: kind === "source" ? [r.note.path] : [], unknownScope: kind === "unknown" });
    b.release(); await rejected; expect(r.files).toEqual(before); expect(r.shown).toEqual([]); expect(r.host.learningRuns.size).toBe(0);
  });

  it("does not interrupt a selected card for a different source's change", async () => {
    const r = await fixture(), b = barrier();
    const running = r.run(async (card, scope) => { await b.wait(); return card.hint(scope); });
    await b.reached; r.host.invalidateLearningReaders({ sources: [r.other.path], unknownScope: false }); b.release();
    await running; expect(r.episode().help[0]?.state).toBe("presented"); expect(r.shown.length).toBeGreaterThan(0);
  });

  it("does not grade a newly selected same-source record when selection changes during host preparation", async () => {
    const r = await fixture(), first = r.episode(), answer = r.question().answer;
    await r.run((card, scope) => card.start(scope, "value-limit"), { newRecord: true }); const second = r.episode();
    r.host.learningCard.select(`v3:${first.id}`); r.shown.length = 0;
    const before = new Map(r.files), b = barrier(), read = r.host.learningReadState.bind(r.host); let once = true;
    vi.spyOn(r.host, "learningReadState").mockImplementation(async query => { const result = await read(query); if (once) { once = false; await b.wait(); } return result; });
    const running = r.run((card, scope) => card.answer(scope, answer)); const rejected = expect(running).rejects.toThrow();
    await b.reached; r.host.learningCard.select(`v3:${second.id}`); b.release(); await rejected;
    expect(r.files).toEqual(before); expect(r.shown).toEqual([]);
  });

  it("does not grade a replacement question when the same selected record advances before the host baseline read", async () => {
    const r = await fixture(), selected = r.episode(), answer = r.question().answer, b = barrier(), read = r.host.learningReadState.bind(r.host); let once = true;
    vi.spyOn(r.host, "learningReadState").mockImplementation(async query => { if (once) { once = false; await b.wait(); } return read(query); });
    const running = r.run((card, scope) => card.answer(scope, answer)), rejected = expect(running).rejects.toThrow();
    await b.reached;
    await r.host.learningDialogue.commands.next({ authority: localLearnerAuthority(), requestId: crypto.randomUUID(), episodeId: selected.id,
      questionId: selected.currentQuestionId, expectedRevision: selected.revision, source: selected.source });
    await r.host.learningCard.load(); const before = new Map(r.files);
    b.release(); await rejected; expect(r.files).toEqual(before); expect(r.shown).toEqual([]);
  });

  it("stops and drains in-flight card writes before replacing the memory root and card instance", async () => {
    const r = await fixture(), oldCard = r.host.learningCard, b = barrier(), id = r.episode().id, root = r.host.learningV3.root;
    const commands = oldCard.commands, prepare = commands.prepareHelp.bind(commands);
    vi.spyOn(commands, "prepareHelp").mockImplementation(async (...args) => { const result = await prepare(...args); await b.wait(); return result; });
    const running = r.run((card, scope) => card.hint(scope)), rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await b.reached; const changing = r.host.changeMemoryRoot("new-learning");
    await vi.waitFor(() => expect(r.host.learningInputsPaused).toBe(true)); expect(r.boards.changeRoot).not.toHaveBeenCalled();
    b.release(); await rejected; await expect(changing).resolves.toEqual({ ok: true });
    expect(r.host.learningCard).not.toBe(oldCard); expect(r.host.settings.memoryRoot).toBe("new-learning");
    expect(r.host.learningRuns.size).toBe(0); expect(r.shown).toEqual([]); expect(await r.host.learningV3.list()).toEqual([]);
    expect((JSON.parse(r.files.get(`${root}/${id}.json`)!) as EpisodeV3).help[0]?.state).toBe("unknown");
    await expect(oldCard.hint({} as LearningCardActionScope)).rejects.toThrow("disposed");
  });

  it("records a post-CAS cancellation as a real commit while suppressing late feedback", async () => {
    const r = await fixture(), q = r.question(), commands = r.host.learningCard.commands, answer = commands.answer.bind(commands), saved: LearningCommandResult[] = [];
    vi.spyOn(commands, "answer").mockImplementation(async (...args) => { const result = await answer(...args); saved.push(result); for (const controller of r.host.learningRuns.keys()) controller.abort(); return result; });
    await expect(r.run((card, scope) => card.answer(scope, q.answer))).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).toHaveLength(1); expect(saved[0]?.protectionRevision).toBeTypeOf("string");
    expect(r.episode().evidence[0]).toMatchObject({ type: "answer", outcome: "correct" }); expect(r.episode().help[0]?.state).toBe("unknown");
    expect(r.shown).toEqual([]); expect(r.host.learningRuns.size).toBe(0);
  });
});
