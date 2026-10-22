import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { Annotation } from "../src/model.js";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import type { TutorRunnerInput } from "../src/tutor-conversation.js";
import type { DialogueReplyResult } from "../src/margin-card.js";
import { createMockApp } from "./helpers/obsidian-mock.js";
import { AnnotationContextError, assembleAnnotationContext } from "../src/annotation-branches.js";
import { recordFromAnnotation } from "../src/index-table.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { classifyIntent } from "../src/intent.js";
import { beginTutorActivity } from "../src/interaction-activity.js";
import { contextVersion } from "../src/teaching-policy.js";
import { annotationReplyFailureCode, annotationReplyFailureMessage } from "../src/annotation-reply-status.js";
import { ConversationTransportError } from "../src/conversation-diagnostics.js";
vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");

// Execute the real host branch and real Markdown store, replacing only model IO.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("  private async replyInAnnotationBranch("), end = source.indexOf("\n  public async replyInAnnotation(", start);
if (start < 0 || end < 0) throw new Error("Branch host method boundary changed");
const code = transformSync(`class Host {${source.slice(start, end)}};module.exports=Host;`, { loader: "ts", format: "cjs" }).code;
type Result = { text: string; confirmProvided?: () => Promise<void> };
type Host = { replyInAnnotationBranch(id: string, question: string, continuation?: boolean): Promise<DialogueReplyResult> };
const root: Annotation = { id: "ANN-root", sourceFile: "Notes/source.md", anchor: { blockId: "source-block", selectedText: "language" },
  userNote: "My original interpretation", reviewText: "The exact original Tutor review", status: "reviewed_unstructured", concepts: [], relatedMemoryCells: [],
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(run?: (input: TutorRunnerInput) => Promise<Result>) {
  const app = createMockApp(), store = new VaultStore(app as unknown as App, "tutor", () => ({ memoryRoot: "Agent Memory" } as AnnotationTutorLiteSettings));
  await app.vault.create(root.sourceFile, "Original source about language"); await store.createAnnotation(root);
  const child = await store.createConversationDraft(root.id, { kind: "review" });
  const module = { exports: {} };
  const dependencies = { AnnotationContextError, assembleAnnotationContext, recordFromAnnotation, localLearnerAuthority, classifyIntent, beginTutorActivity, contextVersion, annotationReplyFailureCode, annotationReplyFailureMessage };
  new Function("module", ...Object.keys(dependencies), code)(module, ...Object.values(dependencies));
  const Host = module.exports as { new(): Host }, host = new Host();
  const confirm = vi.fn(async () => {
    expect((await store.readAnnotation(child.id))?.request?.status).toBe("completed");
    expect((await store.readAnnotation(child.id))?.reviewText).toBe("Saved Tutor answer");
  });
  const runTutorConversation = vi.fn(run ?? (async () => ({ text: "Saved Tutor answer", confirmProvided: confirm })));
  const publish = vi.fn();
  Object.assign(host, { store, app, annotationLearningBusy: new Set(), annotationLearningSessions: new Map(), learningRuns: new Map(),
    captureLearningSource: () => "bound-source", learningSourceRevision: async () => contextVersion("Original source about language"), settings: {}, indexTable: { upsert: vi.fn() },
    notifyAnnotationGraph: vi.fn(), publishAnnotationInsight: publish, runTutorConversation, runIsolatedTutorTurn: vi.fn() });
  return { host, child, store, runTutorConversation, confirm, publish };
}

describe("real annotation branch host", () => {
  it.each(["parent","request"])("rejects a changed %s before sending an additional model call",async kind=>{
    const f=await fixture();
    f.runTutorConversation.mockImplementationOnce(async input=>{
      if(kind==="parent")await f.store.writeReview(root.id,"Changed parent reply");
      else await f.store.failConversationRequest(f.child.id,input.options.learningRequestId!,"cancelled","annotation-request-cancelled");
      await input.beforeAdditionalModelCall?.();
      return {text:"Must not be saved"};
    });
    expect((await f.host.replyInAnnotationBranch(f.child.id,"Keep this question")).ok).toBe(false);
    expect((await f.store.readAnnotation(f.child.id))?.reviewText).toBeUndefined();expect(f.confirm).not.toHaveBeenCalled();
  });
  it("blocks unsaved source buffers before calling the model and retains the question", async () => {
    const f=await fixture();
    Object.assign(f.host,{learningSourceRevision:async()=>contextVersion("Unsaved changed source")});
    expect(await f.host.replyInAnnotationBranch(f.child.id,"Keep this question")).toMatchObject({ok:false,errorCode:"annotation-source-unsaved"});
    expect(f.runTutorConversation).not.toHaveBeenCalled();
    expect((await f.store.readAnnotation(f.child.id))?.request).toMatchObject({status:"failed",question:"Keep this question"});
  });
  it("includes the original review and confirms help only after the child answer is durable", async () => {
    const f = await fixture();
    const result = await f.host.replyInAnnotationBranch(f.child.id, "How does language divide a subject?");
    expect(result).toMatchObject({ ok: true, agentText: "Saved Tutor answer" });
    expect(f.runTutorConversation.mock.calls[0]![0].history).toEqual([
      { role: "user", content: root.userNote }, { role: "assistant", content: root.reviewText }
    ]);
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledTimes(2);
    expect((await f.store.readAnnotation(f.child.id))?.userNote).toBe("How does language divide a subject?");
    expect((await f.store.readAnnotation(root.id))?.reviewText).toBe(root.reviewText);
  });
  it("retains a failed question, retries the same child with a new request identity and never confirms failure", async () => {
    const f = await fixture();
    f.runTutorConversation.mockRejectedValueOnce(new Error("teaching-reply-string-required"));
    const started = vi.spyOn(f.store, "beginConversationRequest");
    const first = await f.host.replyInAnnotationBranch(f.child.id, "Retain my question");
    expect(first.ok).toBe(false); expect(first.error).not.toContain("teaching-reply-string-required");
    expect((await f.store.readAnnotation(f.child.id))?.request).toMatchObject({ status: "failed", question: "Retain my question" });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.publish.mock.calls.every(([saved]) => !saved.reviewText && !saved.dialogue?.length)).toBe(true);
    expect((await f.host.replyInAnnotationBranch(f.child.id, "Retain my question")).ok).toBe(true);
    expect(started.mock.calls.map(args => args[0])).toEqual([f.child.id, f.child.id]);
    expect(started.mock.calls[0]![2]).not.toBe(started.mock.calls[1]![2]);
    expect((await f.store.listAnnotationFiles())).toHaveLength(2);
    expect(f.confirm).toHaveBeenCalledOnce();
  });
  it("discards a late reply after the parent changes and preserves the question for explicit refresh", async () => {
    const f = await fixture();
    f.runTutorConversation.mockImplementationOnce(async () => {
      await f.store.writeReview(root.id, "New parent answer");
      return { text: "Unusable late response", confirmProvided: f.confirm };
    });
    const result = await f.host.replyInAnnotationBranch(f.child.id, "Question about the old parent");
    expect(result).toMatchObject({ ok: false, errorCode: "annotation-parent-reply-changed" });
    const saved = await f.store.readAnnotation(f.child.id);
    expect(saved?.reviewText).toBeUndefined();
    expect(saved?.request).toMatchObject({ status: "failed", question: "Question about the old parent" });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.publish.mock.calls.every(([saved]) => !saved.reviewText && !saved.dialogue?.length)).toBe(true);
    await f.store.refreshConversationParent(f.child.id);
    expect((await f.host.replyInAnnotationBranch(f.child.id, "Question about the old parent")).ok).toBe(true);
  });
  it("rejects a second send while the same child is generating", async () => {
    const pending = deferred<Result>(), f = await fixture(async () => pending.promise);
    const running = f.host.replyInAnnotationBranch(f.child.id, "One question");
    await vi.waitFor(() => expect(f.runTutorConversation).toHaveBeenCalledOnce());
    expect((await f.host.replyInAnnotationBranch(f.child.id, "Duplicate question")).ok).toBe(false);
    expect(f.runTutorConversation).toHaveBeenCalledOnce();
    pending.resolve({ text: "Saved Tutor answer", confirmProvided: f.confirm });
    expect((await running).ok).toBe(true);
    expect((await f.store.readAnnotation(f.child.id))?.userNote).toBe("One question");
  });
  it("runs root depth through the durable strict teaching pipeline and preserves original Q+A", async () => {
    const f = await fixture();
    f.runTutorConversation.mockImplementationOnce(async input => {
      expect((await f.store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "generating", question: "Root depth question" });
      expect(input.history).toEqual([{ role: "user", content: root.userNote }, { role: "assistant", content: root.reviewText }]);
      return { text: "Deeper root answer" };
    });
    expect(await f.host.replyInAnnotationBranch(root.id, "Root depth question", true)).toMatchObject({ ok: true, agentText: "Deeper root answer" });
    const saved = await f.store.readAnnotation(root.id);
    expect(saved?.reviewText).toBe(root.reviewText); expect(saved?.userNote).toBe(root.userNote);
    expect(saved?.dialogueRequest?.status).toBe("completed");
    expect(saved?.dialogue?.map(item => [item.role, item.text])).toEqual([["user", "Root depth question"], ["agent", "Deeper root answer"]]);
    expect(saved?.dialogue?.every(item => !!item.id)).toBe(true);
  });

  it("deepens a completed branch with exact pinned ancestors, initial Q+A and own prior dialogue", async () => {
    const f = await fixture();
    await f.host.replyInAnnotationBranch(f.child.id, "Initial child question");
    f.runTutorConversation.mockImplementationOnce(async () => ({ text: "First depth answer" }));
    await f.host.replyInAnnotationBranch(f.child.id, "First depth question", true);
    f.runTutorConversation.mockImplementationOnce(async input => {
      expect(input.history.map(item => item.content)).toEqual([root.userNote, root.reviewText,
        "Initial child question", "Saved Tutor answer", "First depth question", "First depth answer"]);
      return { text: "Second depth answer" };
    });
    expect((await f.host.replyInAnnotationBranch(f.child.id, "Second depth question", true)).ok).toBe(true);
    const saved = await f.store.readAnnotation(f.child.id);
    expect(saved?.reviewText).toBe("Saved Tutor answer"); expect(saved?.userNote).toBe("Initial child question");
    expect(saved?.request?.status).toBe("completed"); expect(saved?.dialogue).toHaveLength(4);
    expect(await f.store.listAnnotationFiles()).toHaveLength(2);
  });

  it("keeps failed depth questions durable for same-card retry and omits malformed output from teaching history", async () => {
    const f = await fixture();
    f.runTutorConversation.mockRejectedValueOnce(new Error("teaching-reply-string-required"));
    expect(await f.host.replyInAnnotationBranch(root.id, "Retry this depth question", true)).toMatchObject({ ok: false });
    const failed = await f.store.readAnnotation(root.id);
    expect(failed?.dialogueRequest).toMatchObject({ status: "failed", question: "Retry this depth question" });
    expect(failed?.dialogue).toBeUndefined();
    f.runTutorConversation.mockImplementationOnce(async () => ({ text: "Valid depth answer" }));
    expect((await f.host.replyInAnnotationBranch(root.id, "Retry this depth question", true)).ok).toBe(true);
    expect((await f.store.readAnnotation(root.id))?.dialogue).toHaveLength(2);
    expect(f.publish).toHaveBeenCalledTimes(4);
  });

  it("blocks depth while an original review owns the same card", async () => {
    const f = await fixture();
    Object.assign(f.host, { runningAgents: new Map([[root.id, {}]]), requestingAgents: new Set() });
    expect((await f.host.replyInAnnotationBranch(root.id, "Overlap", true)).ok).toBe(false);
    expect(f.runTutorConversation).not.toHaveBeenCalled();
    expect((await f.store.readAnnotation(root.id))?.dialogueRequest).toBeUndefined();
  });

  it.each([
    [new Error("teaching-reply-string-required"), "annotation-reply-protocol", "回复格式"],
    [new Error("api-secure-connection-failed"), "annotation-reply-connection", "连接中断"],
    [new Error("api-request-timeout"), "annotation-reply-timeout", "回复超时"],
    [new ConversationTransportError({ok:false,text:"",status:403,error:"PRIVATE_PROVIDER_TEXT"}), "annotation-reply-access", "拒绝访问"]
  ])("persists a bounded failure cause and leaves the same question retryable: %#", async (error, code, label) => {
    const f = await fixture(); f.runTutorConversation.mockRejectedValueOnce(error);
    const result = await f.host.replyInAnnotationBranch(root.id, "Saved question", true);
    expect(result).toMatchObject({ok:false,errorCode:code}); expect(result.error).toContain(label);
    const saved=await f.store.readAnnotation(root.id);
    expect(saved?.dialogueRequest).toMatchObject({status:"failed",question:"Saved question",errorCode:code});
    expect(saved?.dialogue).toBeUndefined(); expect(JSON.stringify(saved)).not.toContain("PRIVATE_PROVIDER_TEXT");
  });

});
