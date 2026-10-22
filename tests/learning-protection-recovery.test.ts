import { describe, expect, it } from "vitest";
import { questionIndependence } from "../src/learning-protection.js";
import { questionRefV3 } from "../src/learning-v3.js";
import { addProtectedAnswer, addProtectedHelp, protectionFixture } from "./learning-protection-fixture.js";

async function helpedWithEmptyBackup() {
  const f = protectionFixture(); let e = await f.store.save(f.episode);
  const empty = f.files.get(f.path)!;
  e = await f.store.save(addProtectedAnswer(e)); e = await f.store.save(addProtectedHelp(e));
  f.files.set(f.path + ".previous", empty); f.files.set(f.path, "{synthetic-corrupt");
  return { ...f, e, empty };
}

describe("protection across record recovery", () => {
  it("help seq2 -> empty backup -> answer seq1 never becomes independent, including after restart", async () => {
    const f = await helpedWithEmptyBackup();
    expect((await f.store.protection.read(f.e.id)).questions.get(f.e.currentQuestionId)?.blockedFromSequence).toBe(2);
    const recovered = await f.reopen().readEffectiveResult(), e = recovered.records[0]!;
    expect(e.evidence).toHaveLength(0); expect(e.help).toHaveLength(0);
    expect(recovered.integrityIssues).toEqual([expect.objectContaining({ category: "corrupt", recovered: true })]);
    expect(recovered.protectionByEpisode.get(e.id)?.questions.get(e.currentQuestionId)).toMatchObject({ blockedFromSequence: 1, reasons: ["help-prepared", "record-recovered"] });
    expect(questionIndependence(e, e.currentQuestionId, 1, recovered.protectionByEpisode.get(e.id))).toBe("unknown");
    await expect(f.reopen().save(addProtectedAnswer(structuredClone(e)))).rejects.toThrow("independence-unverified");
    const saved = await f.reopen().save(addProtectedAnswer(e, "unknown"));
    const final = await f.reopen().readEffectiveResult();
    expect(final.records[0]!.evidence[0]).toMatchObject({ sequence: 1, independence: "unknown" });
    expect(questionIndependence(saved, saved.currentQuestionId, 1, final.protectionByEpisode.get(saved.id))).toBe("unknown");
  });

  it("protects prepared help even when the primary prepared write fails", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), raw = f.files.get(f.path), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { if (path === f.path) throw new Error("interrupted-primary"); await compare(path, before, after); };
    await expect(f.store.save(addProtectedHelp(e))).rejects.toThrow("interrupted-primary");
    expect(f.files.get(f.path)).toBe(raw); f.io.compareWrite = compare;
    const read = await f.reopen().readEffectiveResult(), unchanged = read.records[0]!;
    expect(unchanged.help).toHaveLength(0);
    expect(questionIndependence(unchanged, unchanged.currentQuestionId, 1, read.protectionByEpisode.get(unchanged.id))).toBe("unknown");
  });

  it("a protection write failure never restores or exposes the old primary", async () => {
    const f = await helpedWithEmptyBackup(), raw = f.files.get(f.path), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { if (path === f.guardPath) throw new Error("protection-offline"); await compare(path, before, after); };
    const read = await f.reopen().readEffectiveResult();
    expect(read.records).toEqual([]); expect(read.completeness).toBe("partial"); expect(f.files.get(f.path)).toBe(raw);
    expect(read.integrityIssues.some(i => i.category === "recovery-failed")).toBe(true);
  });

  it("a crash after the protection write and before primary recovery stays blocked on restart", async () => {
    const f = await helpedWithEmptyBackup(), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { if (path === f.path) throw new Error("crash-before-primary"); await compare(path, before, after); };
    const failed = await f.reopen().readEffectiveResult(); expect(failed.records).toEqual([]);
    expect((await f.store.protection.read(f.e.id)).questions.get(f.e.currentQuestionId)?.blockedFromSequence).toBe(1);
    f.io.compareWrite = compare;
    const recovered = await f.reopen().readEffectiveResult(), e = recovered.records[0]!;
    expect(questionIndependence(e, e.currentQuestionId, 1, recovered.protectionByEpisode.get(e.id))).toBe("unknown");
  });

  it("an external valid repair wins primary CAS while retaining conservative protection", async () => {
    const f = await helpedWithEmptyBackup(), compare = f.io.compareWrite, external = JSON.stringify({ ...JSON.parse(f.empty), revision: 99, status: "paused" });
    f.io.compareWrite = async (path, before, after) => { if (path === f.path) f.files.set(path, external); await compare(path, before, after); };
    const read = await f.reopen().readEffectiveResult(), e = read.records[0]!;
    expect(f.files.get(f.path)).toBe(external); expect(e.revision).toBe(99);
    expect(read.integrityIssues).toEqual([expect.objectContaining({ category: "recovery-conflict", recovered: true })]);
    expect(questionIndependence(e, e.currentQuestionId, 1, read.protectionByEpisode.get(e.id))).toBe("unknown");
  });

  it("recovery also lowers orphan question entries absent from the old backup", async () => {
    const f = protectionFixture(); let e = await f.store.save(f.episode); const empty = f.files.get(f.path)!;
    e = await f.store.save(addProtectedAnswer(e));
    const laterQuestion = questionRefV3(e.concept, "practice", 1); e.questions.push(laterQuestion); e.currentQuestionId = laterQuestion.id;
    e = await f.store.save(addProtectedHelp(e));
    expect((await f.store.protection.read(e.id)).questions.get(laterQuestion.id)?.blockedFromSequence).toBe(2);
    f.files.set(f.path + ".previous", empty); f.files.set(f.path, "{broken");
    const read = await f.reopen().readEffectiveResult(), p = read.protectionByEpisode.get(e.id)!;
    expect(read.records[0]!.questions).toHaveLength(1);
    expect(p.questions.size).toBe(2); expect(p.questions.get(laterQuestion.id)?.blockedFromSequence).toBe(1);
    const restored = read.records[0]!, alias = questionRefV3(e.concept, "practice", 76);
    restored.questions.push(alias); restored.currentQuestionId = alias.id;
    await expect(f.reopen().save(restored)).rejects.toThrow("question-is-not-new");
    expect((await f.store.protection.read(e.id)).questions.has(alias.id)).toBe(false);
  });

  it("allows an explicitly allocated genuinely new question after recovery", async () => {
    const f = await helpedWithEmptyBackup(), store = f.reopen(), e = (await store.readEffectiveResult()).records[0]!;
    const q = questionRefV3(e.concept, "practice", 2); e.questions.push(q); e.currentQuestionId = q.id;
    const saved = await store.save(addProtectedAnswer(e));
    expect(questionIndependence(saved, q.id, 1, await store.protection.read(e.id))).toBe("no-plugin-help");
    expect(questionIndependence(saved, f.e.currentQuestionId, 1, await store.protection.read(e.id))).toBe("unknown");
  });

  it.each(["corrupt", "unsupported", "identity-mismatch"] as const)("%s protection does not use a fresh .previous protection fallback", async status => {
    const f = await helpedWithEmptyBackup(), good = f.files.get(f.guardPath)!, raw = f.files.get(f.path);
    f.files.set(f.guardPath + ".previous", good);
    const value = JSON.parse(good);
    f.files.set(f.guardPath, status === "corrupt" ? "{bad" : JSON.stringify({ ...value, ...(status === "unsupported" ? { version: 2 } : { episodeId: crypto.randomUUID() }) }));
    const guard = f.files.get(f.guardPath);
    const read = await f.reopen().readEffectiveResult(); expect(read.records).toEqual([]);
    expect(f.files.get(f.path)).toBe(raw); expect(f.files.get(f.guardPath)).toBe(guard); expect(f.files.get(f.guardPath + ".previous")).toBe(good);
  });

  it("missing protection is rebuilt at floor one before restoring the episode", async () => {
    const f = await helpedWithEmptyBackup(); f.files.delete(f.guardPath);
    const read = await f.reopen().readEffectiveResult(), e = read.records[0]!, p = read.protectionByEpisode.get(e.id)!;
    expect(p.questions.get(e.currentQuestionId)).toMatchObject({ blockedFromSequence: 1, reasons: ["protection-rebuilt", "record-recovered"] });
    expect(questionIndependence(e, e.currentQuestionId, 1, p)).toBe("unknown");
  });

  it("a tombstone at the protection CAS boundary prevents primary restore and returned evidence", async () => {
    const f = await helpedWithEmptyBackup(), raw = f.files.get(f.path), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { await compare(path, before, after); if (path === f.guardPath) f.files.set(f.path + ".deleted", "deleted"); };
    expect((await f.reopen().readEffectiveResult()).records).toEqual([]); expect(f.files.get(f.path)).toBe(raw);
    expect((await f.reopen().readEffectiveResult()).records).toEqual([]);
  });

  it("a tombstone after primary CAS rejects a late save even though its bytes landed", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { await compare(path, before, after); if (path === f.path) f.files.set(f.path + ".deleted", "deleted"); };
    await expect(f.store.save(addProtectedHelp(e))).rejects.toThrow("deleted");
    expect((await f.reopen().readEffectiveResult()).records).toEqual([]);
  });

  it("a primary failure after fresh registration leaves no accepted event and cannot be promoted by an old token", async () => {
    const f = protectionFixture(), compare = f.io.compareWrite;
    f.io.compareWrite = async (path, before, after) => { if (path === f.path) throw new Error("failed-create"); await compare(path, before, after); };
    await expect(f.store.save(f.episode)).rejects.toThrow("failed-create");
    expect(f.files.has(f.guardPath)).toBe(true); expect((await f.reopen().readEffectiveResult()).records).toEqual([]);
    f.io.compareWrite = compare;
    // A retry may reuse the existing stricter sidecar; it never clears it.
    await f.reopen().protection.block({ episodeId: f.episode.id, questions: [{ ref: f.episode.questions[0]!, fromSequence: 1 }], reason: "external-uncertainty" });
    await expect(f.reopen().save(addProtectedAnswer(f.episode))).rejects.toThrow("independence-unverified");
  });

  it("cancellation after primary CAS returns the durable record and notifies its subscribers", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), compare = f.io.compareWrite;
    const controller = new AbortController(), requestId = crypto.randomUUID(), commits: unknown[] = [];
    f.store.subscribeCommits(change => commits.push(change));
    f.io.compareWrite = async (path, before, after) => { await compare(path, before, after); if (path === f.path) controller.abort(); };
    const saved = await f.store.save(addProtectedHelp(e), controller.signal, requestId);
    expect(controller.signal.aborted).toBe(true);
    expect(saved.help).toHaveLength(1); expect(JSON.parse(f.files.get(f.path)!)).toEqual(saved);
    expect(commits).toEqual([expect.objectContaining({ recordId: saved.id, requestId })]);
  });

  it("does not misclassify concurrent external protection as the current request's own commit", async () => {
    const f = protectionFixture(), e = await f.store.save(f.episode), compare = f.io.compareWrite;
    const requestId = crypto.randomUUID(), commits: Array<{ requestId?: string }> = [];
    f.store.subscribeCommits(change => commits.push(change));
    f.io.compareWrite = async (path, before, after) => {
      await compare(path, before, after);
      if (path === f.path) {
        const guard = JSON.parse(f.files.get(f.guardPath)!); guard.revision++;
        guard.questions[0].blockedFromSequence = 1; guard.questions[0].reasons = ["external-uncertainty"];
        f.files.set(f.guardPath, JSON.stringify(guard));
        expect(await f.store.change(f.guardPath)).toBeNull(); // watch fired during own write
      }
    };
    const saved = await f.store.save(addProtectedAnswer(e), undefined, requestId);
    expect(commits.map(c => c.requestId)).toEqual([undefined, requestId]);
    expect(questionIndependence(saved, saved.currentQuestionId, 1, await f.store.protection.read(saved.id))).toBe("unknown");
    expect(await f.store.change(f.guardPath)).toBeNull(); // already invalidated explicitly
  });
});
