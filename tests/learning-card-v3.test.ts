import { describe, expect, it, vi } from "vitest";
import { LearningCardV3, type LearningCardActionScope } from "../src/learning-card-v3.js";
import { LearningCommandsV3, type LearningCommandResult } from "../src/learning-commands-v3.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { createEpisode } from "../src/learning-episode.js";
import { completeRecordReadResult } from "../src/learning-record-read.js";
import { createEpisodeV2 } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import { renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { protectionFixture } from "./learning-protection-fixture.js";

function barrier() {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { reached(); await ready; } };
}
async function rig(start = true) {
  const f = protectionFixture(), authority = localLearnerAuthority(), conversationId = crypto.randomUUID(), source = { path: "Synthetic/math.md", version: "v1" };
  const now = { value: new Date("2026-10-09T12:00:00Z") }, commands = new LearningCommandsV3(f.store, () => now.value);
  const legacy = [createEpisode(source, "value-limit"), createEpisodeV2(source, instantiateQuestion("value-limit", "practice", 0),
    { at: now.value.toISOString(), requestId: crypto.randomUUID(), conversationId })];
  const card = new LearningCardV3(commands, { readLegacy: async () => completeRecordReadResult(legacy), minutes: () => 20 });
  const shown: string[] = [], commits: LearningCommandResult[] = [];
  const scope = (overrides: Partial<LearningCardActionScope> = {}): LearningCardActionScope => ({ authority, conversationId, source,
    requestId: crypto.randomUUID(), signal: new AbortController().signal, ensureCurrent: async () => {},
    present: delta => { shown.push(delta); return true; }, ownCommit: result => { commits.push(result); }, ...overrides });
  await card.load();
  if (start) await card.start(scope(), "value-limit");
  const episode = (): EpisodeV3 => { const selection = card.snapshot.selected; if (selection?.kind !== "v3") throw new Error("v3 required"); return selection.episode; };
  const stored = () => JSON.parse(f.files.get(`${f.root}/${episode().id}.json`)!) as EpisodeV3;
  const question = () => { const e = episode(); return renderQuestionV3(e.questions.find(q => q.id === e.currentQuestionId)!); };
  shown.length = 0; commits.length = 0;
  return { ...f, authority, conversationId, source, now, commands, legacy, card, scope, shown, commits, episode, stored, question };
}

describe("local learning card v3 facade", () => {
  it("coalesces display loads, then rereads once for changes received during a running load", async () => {
    const r = await rig(false), b = barrier(), original = r.store.readEffectiveResult.bind(r.store);
    const read = vi.spyOn(r.store, "readEffectiveResult").mockImplementationOnce(async () => { await b.wait(); return original(); });
    const first = r.card.load(); await b.entered;
    const pending = Array.from({ length: 10 }, () => r.card.load());
    expect(read).toHaveBeenCalledOnce(); b.release();
    await Promise.all([first, ...pending]); expect(read).toHaveBeenCalledTimes(2);
    read.mockClear();
    await Promise.all(Array.from({ length: 10 }, () => r.card.load())); expect(read).toHaveBeenCalledOnce();
  });

  it("does not publish a late display load or start its dirty follow-up after disposal", async () => {
    const r = await rig(false), b = barrier(), original = r.store.readEffectiveResult.bind(r.store);
    const read = vi.spyOn(r.store, "readEffectiveResult").mockImplementationOnce(async () => { await b.wait(); return original(); });
    const first = r.card.load(); await b.entered;
    const next = r.card.load(); r.card.dispose();
    const listener = vi.fn(); r.card.subscribe(listener); b.release();
    await Promise.all([first, next]); expect(read).toHaveBeenCalledOnce(); expect(listener).not.toHaveBeenCalled();
    await r.card.load(); expect(read).toHaveBeenCalledOnce();
  });

  it("does not lose a refresh arriving in the completion microtask window", async () => {
    const r = await rig(false), read = vi.spyOn(r.store, "readEffectiveResult");
    let subsequent: Promise<unknown> | undefined;
    const stop = r.card.subscribe(() => {
      stop();
      queueMicrotask(() => queueMicrotask(() => { subsequent = r.card.load(); }));
    });
    await r.card.load();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await subsequent;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("loads v1/v2 history read-only and starts only v3 after the explicit click", async () => {
    const r = await rig(false), original = structuredClone(r.legacy);
    expect(r.files.size).toBe(0); expect(r.card.snapshot.selected).toBeUndefined();
    for (const entry of r.card.snapshot.entries) {
      r.card.select(entry.key); expect(r.card.snapshot.selected?.kind).toBe("legacy-readonly");
      await expect(r.card.answer(r.scope(), "4")).rejects.toThrow("legacy-readonly");
      await expect(r.card.hint(r.scope())).rejects.toThrow("legacy-readonly");
      await expect(r.card.undo(r.scope())).rejects.toThrow("legacy-readonly");
    }
    expect(r.files.size).toBe(0);
    await r.card.start(r.scope(), "value-limit");
    expect(r.episode()).toMatchObject({ format: 3, status: "active", evidence: [], help: [] });
    expect([...r.files.keys()].every(path => path.startsWith("learning/v3/"))).toBe(true);
    expect(r.legacy).toEqual(original); expect(r.card.snapshot.entries).toHaveLength(3);
  });

  it("exposes only the unassisted question in its snapshot and protects internal state from mutation", async () => {
    const r = await rig(), selected = r.card.snapshot.selected!;
    if (selected.kind !== "v3") throw new Error();
    expect(Object.keys(selected.question).sort()).toEqual(["goal", "id", "pool", "prompt"]);
    expect(selected.question).not.toHaveProperty("answer"); expect(selected.question).not.toHaveProperty("hint"); expect(selected.question).not.toHaveProperty("explanation");
    selected.episode.status = "deleted"; selected.question.prompt = "MUTATED";
    expect(r.episode().status).toBe("active"); expect(r.card.snapshot.selected).not.toEqual(selected);
  });

  it("deduplicates a Start click and retries a completely failed first guard write with its original invitation", async () => {
    const r = await rig(false), scope = r.scope(), compare = r.io.compareWrite;
    let fail = true;
    vi.spyOn(r.io, "compareWrite").mockImplementation(async (path, before, next) => { if (path.includes("/protection/") && fail) throw new Error("first-write-failed"); await compare(path, before, next); });
    await expect(r.card.start(scope, "value-limit")).rejects.toThrow("first-write-failed"); expect(r.files.size).toBe(0);
    fail = false; await r.card.start(scope, "value-limit"); const id = r.episode().id;
    await r.card.start(scope, "value-limit"); expect(r.episode().id).toBe(id); expect(await r.store.list()).toHaveLength(1);
    await expect(r.card.start(scope, "jump")).rejects.toThrow("request-reused");
  });

  it.each(["authority", "pre-abort", "lease"])("refuses %s before Start writes or presents anything", async kind => {
    const r = await rig(false), controller = new AbortController(); if (kind === "pre-abort") controller.abort();
    const scope = r.scope({ signal: controller.signal, ...(kind === "authority" ? { authority: {} as never } : {}),
      ...(kind === "lease" ? { ensureCurrent: async () => { throw new Error("source-changed"); } } : {}) });
    await expect(r.card.start(scope, "value-limit")).rejects.toThrow(); expect(r.files.size).toBe(0); expect(r.shown).toEqual([]);
  });

  it("uses the shared answer parser/feedback/progress and replays without regrading the next question", async () => {
    const r = await rig(), q = r.question(), scope = r.scope();
    const first = await r.card.answer(scope, q.answer), after = new Map(r.files);
    expect(first.text).toContain(q.explanation); expect(r.episode().questions[1]?.pool).toBe("transfer");
    expect(r.episode().evidence[0]).toMatchObject({ type: "answer", outcome: "correct", independence: "no-plugin-help" });
    expect(r.episode().help[0]).toMatchObject({ questionId: q.id, state: "presented" });
    const second = await r.card.answer(scope, q.answer); expect(second.text).toBe(first.text); expect(r.files).toEqual(after);
    expect(r.commits.every(commit => typeof commit.protectionRevision === "string")).toBe(true);
  });

  it("clarifies private prose without writing answer, feedback or personal text", async () => {
    const r = await rig(), before = new Map(r.files);
    const result = await r.card.answer(r.scope(), "我最近很焦虑，PRIVATE_DISCLOSURE，也许是4");
    expect(result.text).toContain("本轮没有记成错误"); expect(r.files).toEqual(before); expect([...r.files.values()].join("")).not.toContain("PRIVATE_DISCLOSURE");
  });

  it.each(["hint", "solution", "explanation"] as const)("persists %s and protection before actual card presentation", async action => {
    const r = await rig(), q = r.question();
    const result = await r.card[action](r.scope({ present: text => {
      expect(r.stored().help[0]).toMatchObject({ state: "prepared", questionId: q.id });
      expect(r.files.has(r.store.protection.path(r.episode().id))).toBe(true); r.shown.push(text); return true;
    } }));
    expect(result.text).toContain(action === "hint" ? q.hint : q.explanation);
    expect(r.episode().help[0]).toMatchObject({ state: "presented", kind: action === "explanation" ? "related-discussion" : action });
    expect(r.episode().evidence).toEqual([]);
    await r.card.answer(r.scope(), q.answer);
    const selected = r.card.snapshot.selected!; if (selected.kind !== "v3") throw new Error();
    expect(selected.effective.answers[0]?.independence).toBe(action === "explanation" ? "unknown" : "helped");
    expect(selected.effective.progressAnswers).toEqual([]);
  });

  it("does not show an explanation when its help save fails", async () => {
    const r = await rig(), path = `${r.root}/${r.episode().id}.json`, compare = r.io.compareWrite;
    vi.spyOn(r.io, "compareWrite").mockImplementation(async (target, before, next) => { if (target === path) throw new Error("write-failed"); await compare(target, before, next); });
    await expect(r.card.explanation(r.scope())).rejects.toThrow("preparation-not-confirmed"); expect(r.shown).toEqual([]);
    expect(r.episode().help).toEqual([]);
    expect((await r.store.protection.read(r.episode().id)).questions.get(r.question().id)?.blockedFromSequence).toBe(1);
  });

  it("records unknown when presentation is deferred, and only confirms after an actual display", async () => {
    const r = await rig(), result = await r.card.hint(r.scope({ present: () => {} }));
    expect(r.episode().help[0]?.state).toBe("unknown");
    await result.confirmProvided(); await r.card.load(); expect(r.episode().help[0]?.state).toBe("presented");
  });

  it("undo appends a correction, retains help and later facts, and does not restore the old question", async () => {
    const r = await rig(); await r.card.answer(r.scope(), r.question().answer);
    const before = r.episode(), answer = before.evidence[0]!, current = before.currentQuestionId;
    await r.card.undo(r.scope()); const after = r.episode();
    expect(after.currentQuestionId).toBe(current); expect(after.evidence[0]).toEqual(answer);
    expect(after.evidence[1]).toMatchObject({ type: "correction", corrects: answer.id, questionId: answer.questionId });
    expect(after.help).toEqual(before.help);
    const selection = r.card.snapshot.selected!; if (selection.kind !== "v3") throw new Error();
    expect(selection.effective.answers).toEqual([]);
    await expect(r.card.undo(r.scope())).rejects.toThrow("evidence-unavailable");
  });

  it("corrects the selected original evidence, without storing a free-text reason", async () => {
    const r = await rig(); await r.card.answer(r.scope(), r.question().answer); const original = r.episode().evidence[0]!;
    await r.card.answer(r.scope(), r.question().answer); const later = r.episode().evidence[1]!;
    await r.card.correct(r.scope(), original.id);
    expect(r.episode().evidence).toContainEqual(later);
    expect(r.episode().evidence.at(-1)).toMatchObject({ type: "correction", corrects: original.id });
  });

  it("pauses, protects explanation without reactivating, and resumes through the shared command", async () => {
    const r = await rig(); await r.card.pause(r.scope()); expect(r.episode().status).toBe("paused");
    await r.card.explanation(r.scope()); expect(r.episode().status).toBe("paused"); expect(r.episode().help[0]?.state).toBe("presented");
    await expect(r.card.answer(r.scope(), r.question().answer)).rejects.toThrow("question-inactive");
    await r.card.resume(r.scope()); expect(r.episode().status).toBe("active");
  });

  it("waits for the actual due instant before consuming a delayed task and uses a new delayed question", async () => {
    const r = await rig(); await r.card.answer(r.scope(), r.question().answer); await r.card.answer(r.scope(), r.question().answer);
    expect(r.episode().status).toBe("completed"); const task = r.episode().reviewTasks.find(task => task.state === "scheduled")!;
    r.now.value = new Date(Date.parse(task.dueAt) - 1); await r.card.resume(r.scope()); expect(r.episode().status).toBe("completed");
    r.now.value = new Date(task.dueAt); await r.card.resume(r.scope()); expect(r.episode().status).toBe("active");
    expect(r.question().pool).toBe("delayed"); expect(r.episode().reviewTasks.find(t => t.id === task.id)?.state).toBe("active");
  });

  it("rejects a stale displayed question instead of silently using newly persisted state", async () => {
    const r = await rig(), e = r.episode(), q = r.question();
    await r.commands.next({ authority: r.authority, requestId: crypto.randomUUID(), episodeId: e.id, questionId: q.id, expectedRevision: e.revision, source: e.source });
    const before = new Map(r.files); await expect(r.card.answer(r.scope(), q.answer)).rejects.toThrow("stale-selection");
    expect(r.files).toEqual(before); expect(r.shown).toEqual([]);
  });

  it("cancels a pending action when history selection changes, while retaining committed unknown help", async () => {
    const r = await rig(), b = barrier(), id = r.episode().id;
    const pending = r.card.hint(r.scope({ ownCommit: async () => b.wait() })), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await b.entered; r.card.select(`v1:${r.legacy[0]!.id}`); b.release(); await rejected;
    expect(r.card.snapshot.selected?.kind).toBe("legacy-readonly"); expect(r.shown).toEqual([]);
    const stored = JSON.parse(r.files.get(`${r.root}/${id}.json`)!) as EpisodeV3; expect(stored.help[0]?.state).toBe("unknown");
  });

  it("acknowledges a durable Start even when cancellation wins after its primary CAS", async () => {
    const r = await rig(false), controller = new AbortController(), compare = r.io.compareWrite;
    vi.spyOn(r.io, "compareWrite").mockImplementation(async (path, before, next) => { await compare(path, before, next); if (/\/episodes\/[^/]+\.json$/.test(path)) controller.abort(); });
    await expect(r.card.start(r.scope({ signal: controller.signal }), "value-limit")).rejects.toMatchObject({ name: "AbortError" });
    expect(r.commits).toHaveLength(1); expect(r.commits[0]?.episode.format).toBe(3); expect(await r.store.list()).toHaveLength(1); expect(r.shown).toEqual([]);
  });

  it("retains history visibility with an unavailable read and does not recreate a removed selected record", async () => {
    const r = await rig(), id = r.episode().id; await r.store.remove(id); await r.card.load();
    expect(r.card.snapshot.selected).toBeUndefined(); expect(r.card.snapshot.entries).toHaveLength(2);
    await expect(r.card.hint(r.scope())).rejects.toThrow(); expect(await r.store.list()).toEqual([]);
    vi.spyOn(r.store, "readEffectiveResult").mockRejectedValue(new Error("unavailable"));
    await r.card.load(); expect(r.card.snapshot.completeness).toBe("unavailable"); expect(r.card.snapshot.entries).toHaveLength(2);
  });

  it("keeps a real Start result when a history reader throws synchronously during refresh", async () => {
    const r = await rig(false), card = new LearningCardV3(r.commands, { readLegacy: () => { throw new Error("legacy-reader-unavailable"); } });
    const result = await card.start(r.scope(), "value-limit");
    expect(result.text).not.toBe(""); expect(card.snapshot.selected?.kind).toBe("v3");
    expect(card.snapshot.completeness).toBe("unavailable"); expect(await r.store.list()).toHaveLength(1);
  });
});
