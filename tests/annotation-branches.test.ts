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

const source = "Original source text about language.";
function root(): Annotation {
  return { id: "ANN-20261020-001", sourceFile: "Notes/source.md", anchor: { blockId: "original", selectedText: "language" },
    anchorOrigin: "generated", userNote: "My original interpretation", reviewText: "The original Tutor review", status: "reviewed_unstructured",
    concepts: [], relatedMemoryCells: [], createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" };
}
async function setup() {
  const app = createMockApp(), store = new VaultStore(app as unknown as App, "tutor", () => ({ memoryRoot: "Agent Memory" } as AnnotationTutorLiteSettings));
  await app.vault.create(root().sourceFile, source);
  await store.createAnnotation(root());
  return { app, store };
}

describe("annotation branch persistence", () => {
  it("serializes a real empty draft, its precise edge, request state, and cache projections", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    const markdown = serializeAnnotation(child);
    expect(markdown).toContain("schema: 3");
    expect(parseAnnotationFile(markdown)).toEqual(child);
    const updated = parseAnnotationFile(updateAnnotationMarkdown(markdown, { userNote: "Edited draft" })!)!;
    expect(updated.branch).toEqual(child.branch);
    const snapshot = buildLibrarySnapshot({ annotations: [{ path: store.annotationPath(child.id), content: markdown }], cells: [], scenes: [], profiles: [], proposals: [] });
    expect(parseLibraryCache(serializeLibraryCache(snapshot))).toEqual(snapshot);
    expect(parseLibraryCache(JSON.stringify(snapshot))).toBeNull();
    const table = new IndexTable([recordFromAnnotation(root(), "root.md"), recordFromAnnotation(child, "child.md")]);
    expect(table.generatedAnchors(root().sourceFile)).toEqual(["^original"]);
  });

  it("preserves full Markdown headings and fenced examples in Tutor replies", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    const reply = "## Explanation\n\nA full answer.\n\n```markdown\n## Dialogue\nquoted example\n```\n\n## Everyday example\n\nThe final paragraph.";
    await store.beginConversationRequest(child.id, "Question", "request");
    const completed = await store.completeConversationRequest(child.id, "request", reply);
    expect(completed?.reviewText).toBe(reply);
    expect((await store.readAnnotation(child.id))?.reviewText).toBe(reply);
    expect((await store.createConversationDraft(child.id, { kind: "review" })).branch?.parentReply.text).toBe(reply);
  });

  it("length-delimits canonical headings and literal section markers without corrupting adjacent sections", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    const reply = "## Dialogue\n\nPlain dialogue explanation.\n\n## User Note\n\nStill Tutor text.\n\n<!-- tutor-section:agent-review:end -->\n\n## Review History\n\nStill the same reply.\n\n## Selected Text\n\nFinal paragraph.";
    await store.beginConversationRequest(child.id, "Actual question", "request");
    const completed = await store.completeConversationRequest(child.id, "request", reply);
    expect(completed?.reviewText).toBe(reply);
    expect(completed?.dialogue).toBeUndefined();
    expect(completed?.userNote).toBe("Actual question");
    const updated = parseAnnotationFile(updateAnnotationMarkdown(serializeAnnotation(completed!), { concepts: ["language"] })!);
    expect(updated?.reviewText).toBe(reply);
    expect(updated?.anchor.selectedText).toBe(root().anchor.selectedText);
    await store.writeReview(child.id, "Replacement review");
    const history = await store.readAnnotation(child.id);
    expect(history?.reviewText).toBe("Replacement review");
    expect(history?.reviewHistory).toContain(reply);
    expect(history?.dialogue).toBeUndefined();
  });

  it("serializes rapid manual creation, saves before generation, and makes completion idempotent", async () => {
    const { store } = await setup();
    const [b, c] = await Promise.all([store.createConversationDraft(root().id, { kind: "review" }), store.createConversationDraft(root().id, { kind: "review" })]);
    expect(b.id).not.toBe(c.id);
    expect(b.anchor).toEqual(root().anchor);
    await store.saveConversationDraft(b.id, "Question B");
    expect((await store.readAnnotation(b.id))?.userNote).toBe("Question B");
    const started = await store.beginConversationRequest(b.id, "Question B", "request-b");
    expect(started?.request?.status).toBe("generating");
    expect(await store.beginConversationRequest(b.id, "Duplicate", "request-duplicate")).toBeNull();
    const completed = await store.completeConversationRequest(b.id, "request-b", "Answer B");
    expect(completed?.reviewText).toBe("Answer B");
    expect(completed?.request?.status).toBe("completed");
    expect(await store.completeConversationRequest(b.id, "request-b", "Overwrite")).toBeNull();
    expect((await store.readAnnotation(root().id))?.reviewText).toBe(root().reviewText);
  });

  it("drains queued creations and draft writes before upgrade without replaying handled historical failures", async () => {
    const { store } = await setup();
    const pending = store.createConversationDraft(root().id, { kind: "review" });
    await store.drainConversationWrites();
    const child = await pending;
    const first = store.saveConversationDraft(child.id, "First draft");
    const second = store.saveConversationDraft(child.id, "Newest draft");
    await store.drainConversationWrites();
    await Promise.all([first, second]);
    expect((await store.readAnnotation(child.id))?.userNote).toBe("Newest draft");
    const failure = store.createConversationDraft("missing", { kind: "review" });
    const handled = failure.catch(() => undefined);
    await expect(store.drainConversationWrites()).rejects.toMatchObject({ code: "annotation-parent-missing" });
    await handled;
    await expect(store.drainConversationWrites()).resolves.toBeUndefined();
  });

  it("persists private completion atomically and inherits excluded tracking to new branches", async () => {
    const { store } = await setup();
    await store.updateAnnotation(root().id, { tracking: "excluded" });
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    expect(child.tracking).toBe("excluded");
    await store.beginConversationRequest(child.id, "Private support question", "private-request");
    const completed = await store.completeConversationRequest(child.id, "private-request", "Private support reply", { tracking: "private" });
    expect(completed?.tracking).toBe("excluded");
    expect(recordFromAnnotation(completed!, "child.md").tracking).toBe("excluded");
    await store.updateAnnotation(root().id, { tracking: "ordinary" });
    const support = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(support.id, "Private question", "support");
    expect((await store.completeConversationRequest(support.id, "support", "Private answer", { tracking: "private" }))?.tracking).toBe("private");
  });

  it("keeps failed questions and isolates sibling branches while retaining ancestor context", async () => {
    const { store } = await setup();
    const b = await store.createConversationDraft(root().id, { kind: "review" });
    const c = await store.createConversationDraft(root().id, { kind: "review" });
    await store.saveConversationDraft(c.id, "Sibling question C");
    await store.beginConversationRequest(b.id, "Question B", "b-1");
    await store.failConversationRequest(b.id, "b-1", "failed", "teaching-reply-string-required");
    expect((await store.readAnnotation(b.id))?.request).toMatchObject({ question: "Question B", status: "failed" });
    await store.beginConversationRequest(b.id, "Question B", "b-2");
    expect(await store.completeConversationRequest(b.id, "b-1", "Stale response")).toBeNull();
    await store.completeConversationRequest(b.id, "b-2", "Answer B");
    const d = await store.createConversationDraft(b.id, { kind: "review" });
    const context = await assembleAnnotationContext(d.id, id => store.readAnnotation(id), { sourceText: source });
    expect(context.history.map(item => item.content)).toEqual([root().userNote, root().reviewText, "Question B", "Answer B"]);
    expect(JSON.stringify(context)).not.toContain("Sibling question C");
  });

  it("rejects stale parent versions before commit and preserves the question for explicit refresh", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(child.id, "Question", "request");
    await store.writeReview(root().id, "Changed parent answer");
    await expect(store.completeConversationRequest(child.id, "request", "Late answer")).rejects.toMatchObject({ code: "annotation-parent-reply-changed" });
    expect((await store.readAnnotation(child.id))?.request).toMatchObject({ status: "failed", question: "Question" });
    expect((await store.readAnnotation(child.id))?.reviewText).toBeUndefined();
    await store.refreshConversationParent(child.id);
    expect((await store.beginConversationRequest(child.id, "Question", "retry"))?.request?.status).toBe("generating");
  });

  it("assigns old dialogue IDs only on explicit derivation and pins the selected reply", async () => {
    const { store } = await setup();
    await store.appendDialogueTurns(root().id, [{ role: "user", text: "Earlier question", at: "now" }, { role: "agent", text: "Earlier answer", at: "then" }, { role: "user", text: "Later unrelated", at: "later" }]);
    expect((await store.readAnnotation(root().id))?.dialogue?.[1]?.id).toBeUndefined();
    const child = await store.createConversationDraft(root().id, { kind: "dialogue", turnIndex: 1 });
    expect(child.branch?.parentReply.id).toBeTruthy();
    const context = await assembleAnnotationContext(child.id, id => store.readAnnotation(id), { sourceText: source });
    expect(context.history.at(-1)?.content).toBe("Earlier answer");
    expect(JSON.stringify(context)).not.toContain("Later unrelated");
    expect((await store.readAnnotation(root().id))?.dialogue?.map(turn => turn.text)).toEqual(["Earlier question", "Earlier answer", "Later unrelated"]);
  });

  it("pins the parent question and selected dialogue prefix, not only the final answer", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(child.id, "Question", "request");
    await store.updateAnnotation(root().id, { userNote: "Different original interpretation" });
    await expect(store.completeConversationRequest(child.id, "request", "Late answer")).rejects.toMatchObject({ code: "annotation-parent-reply-changed" });
    expect((await store.readAnnotation(child.id))?.branch?.parentReply.question).toBe(root().userNote);
    await store.refreshConversationParent(child.id);
    expect((await store.readAnnotation(child.id))?.branch?.parentReply.question).toBe("Different original interpretation");
    await store.beginConversationRequest(child.id, "Question", "retry");
    expect((await store.completeConversationRequest(child.id, "retry", "Fresh answer"))?.reviewText).toBe("Fresh answer");
  });

  it("saves a new question even when validation fails and permits explicit source refresh", async () => {
    const { store, app } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    const file = app.vault.getAbstractFileByPath(root().sourceFile)!;
    await app.vault.modify(file as never, "Source changed before send");
    await expect(store.beginConversationRequest(child.id, "Preserve this question", "request")).rejects.toMatchObject({ code: "annotation-source-changed" });
    expect((await store.readAnnotation(child.id))?.request).toMatchObject({ question: "Preserve this question", status: "failed" });
    expect((await store.readAnnotation(child.id))?.userNote).toBe("Preserve this question");
    await store.refreshConversationParent(child.id);
    expect((await store.beginConversationRequest(child.id, "Preserve this question", "retry"))?.request?.status).toBe("generating");
  });

  it("guards a context change in the async validation to vault.process window", async () => {
    const { store, app } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(child.id, "Question", "request");
    const original = app.vault.process.bind(app.vault);
    let changed = false;
    vi.spyOn(app.vault, "process").mockImplementation(async (file, transform) => {
      if (file.path === store.annotationPath(child.id) && !changed) {
        changed = true;
        const newSource = "Changed during final commit";
        app.vault.files.set(root().sourceFile, newSource);
        store.markWritten(root().sourceFile, newSource);
      }
      return original(file, transform);
    });
    await expect(store.completeConversationRequest(child.id, "request", "Late answer")).rejects.toMatchObject({ code: "annotation-context-changed" });
    expect((await store.readAnnotation(child.id))?.reviewText).toBeUndefined();
    await store.failConversationRequest(child.id, "request", "failed", "annotation-context-changed");
    expect((await store.readAnnotation(child.id))?.request?.question).toBe("Question");
  });

  it("preserves completed historical edges and refreshes only the active source edge", async () => {
    const { store, app } = await setup();
    const b = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(b.id, "Question B", "b");
    await store.completeConversationRequest(b.id, "b", "Answer B");
    const before = serializeAnnotation((await store.readAnnotation(b.id))!);
    const d = await store.createConversationDraft(b.id, { kind: "review" });
    await store.writeReview(root().id, "A newly edited root review");
    await store.updateAnnotation(root().id, { userNote: "New root question" });
    const unchangedSource = await assembleAnnotationContext(d.id, id => store.readAnnotation(id), { sourceText: source });
    expect(unchangedSource.history.map(item => item.content)).toEqual([root().userNote, root().reviewText, "Question B", "Answer B"]);
    expect(unchangedSource.system).toContain(root().userNote);
    expect(unchangedSource.system).not.toContain("New root question");
    app.vault.files.set(root().sourceFile, "New source content");
    await expect(store.beginConversationRequest(d.id, "Question D", "d")).rejects.toMatchObject({ code: "annotation-source-changed" });
    await store.refreshConversationParent(d.id);
    expect((await store.beginConversationRequest(d.id, "Question D", "d-retry"))?.request?.status).toBe("generating");
    expect(serializeAnnotation((await store.readAnnotation(b.id))!)).toBe(before);
    // Completed parent B can produce a fresh branch after later root/source edits.
    expect((await store.createConversationDraft(b.id, { kind: "review" })).branch?.parentAnnotationId).toBe(b.id);
  });

  it("archives parents without deleting descendants and interrupts saved in-flight requests", async () => {
    const { store } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    await store.beginConversationRequest(child.id, "Question", "request");
    await store.deleteAnnotation(root().id);
    expect((await store.readAnnotation(root().id))?.status).toBe("archived");
    expect(await store.readAnnotation(child.id)).not.toBeNull();
    await store.interruptConversationRequests();
    expect((await store.readAnnotation(child.id))?.request).toMatchObject({ status: "interrupted", question: "Question" });
    expect(await store.completeConversationRequest(child.id, "request", "Late answer")).toBeNull();
  });

  it("rejects changed source, cycles and missing context instead of starting a new conversation", async () => {
    const { store, app } = await setup();
    const child = await store.createConversationDraft(root().id, { kind: "review" });
    await app.vault.modify(app.vault.getAbstractFileByPath(root().sourceFile) as never, "Changed source");
    await expect(store.beginConversationRequest(child.id, "Saved question", "request")).rejects.toMatchObject({ code: "annotation-source-changed" });
    const missing = { ...child, branch: { ...child.branch!, parentAnnotationId: "missing" } };
    await expect(assembleAnnotationContext(missing.id, async id => id === missing.id ? missing : null, { sourceText: source })).rejects.toMatchObject({ code: "annotation-parent-missing" });
    const cycle = { ...child, branch: { ...child.branch!, parentAnnotationId: child.id } };
    await expect(assembleAnnotationContext(cycle.id, async () => cycle, { sourceText: source })).rejects.toMatchObject({ code: "annotation-branch-cycle" });
  });

  it("bounds older history while keeping the direct parent reply exact and validates PDF selected text", async () => {
    const { store, app } = await setup();
    const a = await store.readAnnotation(root().id);
    await store.updateAnnotation(root().id, { userNote: "old".repeat(500) });
    const b = await store.createConversationDraft(a!.id, { kind: "review" });
    await store.beginConversationRequest(b.id, "Direct question", "request");
    await store.completeConversationRequest(b.id, "request", "Direct answer".repeat(500));
    const d = await store.createConversationDraft(b.id, { kind: "review" });
    const context = await assembleAnnotationContext(d.id, id => store.readAnnotation(id), { sourceText: source, maxAncestorChars: 10 });
    expect(context.history.at(-2)?.content).toBe("Direct question");
    expect(context.history.at(-1)?.content).toBe("Direct answer".repeat(500));
    expect(context.history[0]?.content).toContain("omitted");
    const pdf = { ...root(), id: "ANN-pdf", sourceFile: "document.pdf", anchor: { ...root().anchor, sourceType: "pdf" as const, page: 3 } };
    await app.vault.create(pdf.sourceFile, "PDF bytes are not read as text");
    await store.createAnnotation(pdf);
    const pdfChild = await store.createConversationDraft(pdf.id, { kind: "review" });
    expect((await store.beginConversationRequest(pdfChild.id, "PDF question", "pdf-request"))?.request?.status).toBe("generating");
  });
});
