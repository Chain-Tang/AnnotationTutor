import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { Annotation } from "../src/model.js";
import type { AnnotationTutorLiteSettings } from "../src/settings.js";
import { createMockApp } from "./helpers/obsidian-mock.js";
import { assembleAnnotationContext } from "../src/annotation-branches.js";
import { parseAnnotationFile, serializeAnnotation, updateAnnotationMarkdown } from "../src/markdown/annotation-file.js";
import { recordFromAnnotation, IndexTable } from "../src/index-table.js";
import { buildLibrarySnapshot, parseLibraryCache, serializeLibraryCache } from "../src/library-index.js";

vi.mock("obsidian", () => import("./helpers/obsidian-mock.js"));
const { VaultStore } = await import("../src/store.js");
const source = "Original source about language.";
const root: Annotation = { id: "ANN-root", sourceFile: "Notes/source.md", anchor: { blockId: "source-block", selectedText: "language" },
  userNote: "My original interpretation", reviewText: "The exact original Tutor review", status: "reviewed_unstructured", concepts: [], relatedMemoryCells: [],
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" };
async function fixture() {
  const app = createMockApp(), store = new VaultStore(app as unknown as App, "tutor", () => ({ memoryRoot: "Agent Memory" } as AnnotationTutorLiteSettings));
  await app.vault.create(root.sourceFile, source); await store.createAnnotation(root);
  return { app, store };
}

describe("same-card continuous annotation dialogue", () => {
  it("keeps the original Q+A, saves continuations, stable IDs, separate drafts and cache across cold reloads", async () => {
    const { store } = await fixture();
    await store.saveDialogueDraft(root.id, "Follow-up one");
    expect((await store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "draft", question: "Follow-up one" });
    await store.beginDialogueRequest(root.id, "Follow-up one", "depth-1");
    const first = await store.completeDialogueRequest(root.id, "depth-1", "First deepening answer");
    expect(first?.userNote).toBe(root.userNote); expect(first?.reviewText).toBe(root.reviewText);
    expect(first?.dialogue).toEqual([
      { id: "depth-1-user", role: "user", text: "Follow-up one", at: expect.any(String) },
      { id: "depth-1-agent", role: "agent", text: "First deepening answer", at: expect.any(String) }
    ]);
    await store.saveDialogueDraft(root.id, "Follow-up two");
    const current = (await store.readAnnotation(root.id))!;
    expect(current.dialogue).toEqual(first?.dialogue);
    expect(parseAnnotationFile(serializeAnnotation(current))).toEqual(current);
    expect(parseAnnotationFile(updateAnnotationMarkdown(serializeAnnotation(current), { concepts: ["language"] })!)?.dialogueRequest).toEqual(current.dialogueRequest);
    const table = IndexTable.fromJson(new IndexTable([recordFromAnnotation(current, "root.md")]).toJson());
    expect(table.get(root.id)?.dialogueRequest).toEqual(current.dialogueRequest);
    const snapshot = buildLibrarySnapshot({ annotations: [{ path: store.annotationPath(root.id), content: serializeAnnotation(current) }], cells: [], scenes: [], profiles: [], proposals: [] });
    expect(parseLibraryCache(serializeLibraryCache(snapshot))).toEqual(snapshot);
    await store.beginDialogueRequest(root.id, "Follow-up two", "depth-2");
    const second = await store.completeDialogueRequest(root.id, "depth-2", "Second deepening answer");
    expect(second?.dialogue).toHaveLength(4);
    expect(second?.reviewText).toBe(root.reviewText);
  });

  it("includes initial and previous own turns for completed branch depth and excludes siblings", async () => {
    const { store } = await fixture();
    const child = await store.createConversationDraft(root.id, { kind: "review" });
    const sibling = await store.createConversationDraft(root.id, { kind: "review" });
    await store.saveConversationDraft(sibling.id, "Unrelated sibling");
    expect(await store.saveDialogueDraft(child.id, "too soon")).toBeNull();
    await store.beginConversationRequest(child.id, "Breadth question", "breadth");
    await store.completeConversationRequest(child.id, "breadth", "Breadth answer");
    const initial = (await store.readAnnotation(child.id))!;
    await store.beginDialogueRequest(child.id, "Depth one", "depth");
    await store.completeDialogueRequest(child.id, "depth", "Depth answer");
    await store.beginDialogueRequest(child.id, "Depth two", "depth-2");
    const context = await assembleAnnotationContext(child.id, id => store.readAnnotation(id), { sourceText: source, includeCurrentCard: true });
    expect(context.history.map(item => item.content)).toEqual([root.userNote, root.reviewText, "Breadth question", "Breadth answer", "Depth one", "Depth answer"]);
    expect(JSON.stringify(context)).not.toContain("Unrelated sibling");
    const saved = (await store.readAnnotation(child.id))!;
    expect(saved.request).toEqual(initial.request); expect(saved.branch).toEqual(initial.branch);
    expect(saved.userNote).toBe("Breadth question"); expect(saved.reviewText).toBe("Breadth answer");
    const grandchild = await store.createConversationDraft(child.id, { kind: "dialogue", turnId: "depth-agent" });
    const breadthContext = await assembleAnnotationContext(grandchild.id, id => store.readAnnotation(id), { sourceText: source });
    expect(breadthContext.history.map(item => item.content)).toEqual(context.history.map(item => item.content));
  });

  it("prevents duplicate sends and late commits, retaining failed/cancelled/interrupted questions", async () => {
    const { store } = await fixture();
    await store.beginDialogueRequest(root.id, "Question", "first");
    expect(await store.beginDialogueRequest(root.id, "Duplicate", "duplicate")).toBeNull();
    expect(await store.saveDialogueDraft(root.id, "Override")).toBeNull();
    await store.failDialogueRequest(root.id, "first", "failed", "format-error");
    expect((await store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "failed", question: "Question" });
    await store.beginDialogueRequest(root.id, "Question", "retry");
    expect(await store.completeDialogueRequest(root.id, "first", "Late first reply")).toBeNull();
    await store.failDialogueRequest(root.id, "retry", "cancelled");
    await store.beginDialogueRequest(root.id, "Question", "restart");
    await store.interruptConversationRequests();
    expect((await store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "interrupted", question: "Question" });
    expect(await store.completeDialogueRequest(root.id, "restart", "Late reply")).toBeNull();
    await store.beginDialogueRequest(root.id, "Question", "final");
    expect((await store.completeDialogueRequest(root.id, "final", "Final answer"))?.dialogue).toHaveLength(2);
    expect(await store.completeDialogueRequest(root.id, "final", "Duplicate reply")).toBeNull();
    expect(await store.beginDialogueRequest(root.id, "Reused request ID", "final")).toBeNull();
    expect(await store.listAnnotationFiles()).toHaveLength(1);
  });

  it("saves before missing-context failure and rejects edited current card/source before committing", async () => {
    const { app, store } = await fixture();
    await store.beginDialogueRequest(root.id, "Keep my question", "content-edit");
    await store.writeReview(root.id, "Edited review");
    await expect(store.completeDialogueRequest(root.id, "content-edit", "Stale answer")).rejects.toMatchObject({ code: "annotation-context-changed" });
    expect((await store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "failed", question: "Keep my question" });
    await store.beginDialogueRequest(root.id, "Try again", "source-edit");
    await app.vault.modify(app.vault.getAbstractFileByPath(root.sourceFile) as never, "Edited source");
    await expect(store.completeDialogueRequest(root.id, "source-edit", "Stale source answer")).rejects.toMatchObject({ code: "annotation-source-changed" });
    await app.vault.delete(app.vault.getAbstractFileByPath(root.sourceFile) as never);
    await expect(store.beginDialogueRequest(root.id, "Question with missing source", "missing")).rejects.toMatchObject({ code: "annotation-source-missing" });
    expect((await store.readAnnotation(root.id))?.dialogueRequest).toMatchObject({ status: "failed", question: "Question with missing source" });
    expect((await store.readAnnotation(root.id))?.dialogue).toBeUndefined();
  });

  it("keeps completed branch ancestry pinned while new depth is independently version-guarded and private", async () => {
    const { store } = await fixture();
    const child = await store.createConversationDraft(root.id, { kind: "review" });
    await store.beginConversationRequest(child.id, "Branch Q", "branch");
    await store.completeConversationRequest(child.id, "branch", "Branch A");
    await store.writeReview(root.id, "Changed live ancestor review");
    await store.beginDialogueRequest(child.id, "Continue pinned branch", "depth");
    const context = await assembleAnnotationContext(child.id, id => store.readAnnotation(id), { sourceText: source, includeCurrentCard: true });
    expect(context.history[1]?.content).toBe(root.reviewText);
    const complete = await store.completeDialogueRequest(child.id, "depth", "Private follow-up", { tracking: "private" });
    expect(complete?.tracking).toBe("private"); expect(complete?.reviewText).toBe("Branch A");
  });
  it("blocks same-card sends while a root initial review is in progress or card is archived", async () => {
    const { store } = await fixture();
    const reviewing = { ...root, id: "ANN-reviewing", reviewText: undefined, status: "agent_requested" as const };
    await store.createAnnotation(reviewing);
    expect(await store.beginDialogueRequest(reviewing.id, "Overlapping question", "overlap")).toBeNull();
    expect(await store.saveDialogueDraft(reviewing.id, "Overlapping draft")).toBeNull();
    await store.updateAnnotation(root.id, { status: "archived" });
    expect(await store.beginDialogueRequest(root.id, "Archived question", "archived")).toBeNull();
    expect((await store.readAnnotation(root.id))?.dialogue).toBeUndefined();
  });

});
