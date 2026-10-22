import type { Annotation, AnnotationReplySnapshot, IndexRecord } from "./model.js";
import { sha256 } from "./markdown/proposal-file.js";

export type AnnotationReplyTarget =
  | { kind: "review" }
  | { kind: "dialogue"; turnId?: string; turnIndex?: number; index?: number };

export class AnnotationContextError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AnnotationContextError";
  }
}

export function isRootAnnotation(annotation: Pick<Annotation, "branch"> | Pick<IndexRecord, "branch">): boolean {
  return !annotation.branch;
}

export function replySnapshot(annotation: Annotation, target: AnnotationReplyTarget): AnnotationReplySnapshot {
  const question = annotation.userNote;
  const fingerprint = (prefix: unknown): string => sha256(JSON.stringify({ sourceFile: annotation.sourceFile, anchor: annotation.anchor, question, prefix }));
  if (target.kind === "review") {
    const text = annotation.reviewText?.trim();
    if (!text) throw new AnnotationContextError("annotation-parent-reply-missing");
    return { id: "review", kind: "review", text, version: sha256(text), question, contextVersion: fingerprint(text) };
  }
  const turn = target.turnId
    ? annotation.dialogue?.find(item => item.id === target.turnId)
    : annotation.dialogue?.[target.turnIndex ?? target.index ?? -1];
  if (!turn || turn.role !== "agent" || !turn.id || !turn.text.trim()) {
    throw new AnnotationContextError("annotation-parent-reply-missing");
  }
  const end = annotation.dialogue!.indexOf(turn);
  return { id: turn.id, kind: "dialogue", text: turn.text, version: sha256(turn.text), question,
    contextVersion: fingerprint({ review: annotation.reviewText, dialogue: annotation.dialogue!.slice(0, end + 1) }),
    history: [...(annotation.reviewText ? [{ role: "assistant" as const, content: annotation.reviewText }] : []),
      ...annotation.dialogue!.slice(0, end + 1).map(item => ({ role: item.role === "agent" ? "assistant" as const : "user" as const, content: item.text }))] };
}

export type AnnotationConversationContext = {
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  annotationIds: string[];
  sourceVersion: string;
};

/** Resolve the exact parent chain from files, never sibling records or index summaries. */
export async function assembleAnnotationContext(
  annotationId: string,
  load: (id: string) => Promise<Annotation | null>,
  options: { sourceText: string; maxAncestorChars?: number; includeCurrentCard?: boolean }
): Promise<AnnotationConversationContext> {
  const reverse: Annotation[] = [];
  const seen = new Set<string>();
  let id: string | undefined = annotationId;
  while (id) {
    if (seen.has(id)) throw new AnnotationContextError("annotation-branch-cycle");
    seen.add(id);
    const current = await load(id);
    if (!current) throw new AnnotationContextError("annotation-parent-missing");
    reverse.push(current);
    id = current.branch?.parentAnnotationId;
  }
  const chain = reverse.reverse();
  const root = chain[0]!;
  const target = chain.at(-1)!;
  const sourceVersion = sha256(options.sourceText);
  for (let index = 1; index < chain.length; index += 1) {
    const child = chain[index]!, parent = chain[index - 1]!, branch = child.branch!;
    if (branch.rootAnnotationId !== root.id || child.sourceFile !== root.sourceFile
      || JSON.stringify(child.anchor) !== JSON.stringify(target.anchor)) throw new AnnotationContextError("annotation-branch-invalid");
    if (sha256(branch.parentReply.text) !== branch.parentReply.version) throw new AnnotationContextError("annotation-parent-reply-changed");
    // A completed ancestor is historical evidence: its pinned snapshot survives
    // later edits to the live parent. Only the active edge must still match.
    if (index !== chain.length - 1 || target.request?.status === "completed") continue;
    const current = replySnapshot(parent, branch.parentReply.kind === "review"
      ? { kind: "review" } : { kind: "dialogue", turnId: branch.parentReply.id });
    if (current.id !== branch.parentReply.id || current.version !== branch.parentReply.version
      || branch.parentReply.contextVersion && current.contextVersion !== branch.parentReply.contextVersion
      || branch.parentReply.question !== undefined && current.question !== branch.parentReply.question) {
      throw new AnnotationContextError("annotation-parent-reply-changed");
    }
    if (branch.sourceVersion !== sourceVersion) throw new AnnotationContextError("annotation-source-changed");
  }

  const history: AnnotationConversationContext["history"] = [];
  const limit = options.maxAncestorChars ?? 16_000;
  if (!target.branch) {
    if (root.userNote.trim()) history.push({ role: "user", content: root.userNote });
    if (root.reviewText?.trim()) history.push({ role: "assistant", content: root.reviewText });
    for (const turn of root.dialogue ?? []) history.push({ role: turn.role === "agent" ? "assistant" : "user", content: turn.text });
  } else {
    // Reserve the exact direct parent reply. Only older context is abbreviated.
    for (let index = 0; index < chain.length - 1; index += 1) {
      const ancestor = chain[index]!, edge = chain[index + 1]!.branch!;
      const question = edge.parentReply.question ?? ancestor.userNote;
      if (question.trim()) history.push({ role: "user", content: question });
      if (edge.parentReply.kind === "dialogue") {
        if (edge.parentReply.history) history.push(...edge.parentReply.history.map(item => ({ ...item })));
        else history.push({ role: "assistant", content: edge.parentReply.text });
      } else history.push({ role: "assistant", content: edge.parentReply.text });
    }
  }
  if (target.branch && options.includeCurrentCard) {
    if (target.userNote.trim()) history.push({ role: "user", content: target.userNote });
    if (target.reviewText?.trim()) history.push({ role: "assistant", content: target.reviewText });
    for (const turn of target.dialogue ?? []) history.push({ role: turn.role === "agent" ? "assistant" : "user", content: turn.text });
  }
  // The last user/assistant pair is the direct parent context and is never cut.
  let remaining = limit, omitted = 0;
  const reservedCount = options.includeCurrentCard ? Math.max(2, (target.dialogue?.length ?? 0) + 2 + (target.branch ? 2 : 0)) : 2;
  const reserved = history.slice(-reservedCount), older = history.slice(0, -reservedCount), kept: typeof history = [];
  for (let index = older.length - 1; index >= 0; index -= 1) {
    const entry = older[index]!;
    if (remaining <= 0) { omitted += 1; continue; }
    kept.unshift(entry.content.length <= remaining ? entry
      : { ...entry, content: `${entry.content.slice(-remaining)}\n[Earlier ancestor excerpt; abbreviated explicitly.]` });
    remaining -= entry.content.length;
  }
  if (omitted) kept.unshift({ role: "user", content: `[${omitted} earlier ancestor messages omitted within the context budget.]` });
  history.splice(0, history.length, ...kept, ...reserved);
  const sourceLimit = 6_000;
  const selectionOffset = options.sourceText.indexOf(target.anchor.selectedText);
  const excerptStart = Math.max(0, selectionOffset - 2_000);
  const sourceExcerpt = options.sourceText.length > sourceLimit
    ? `${options.sourceText.slice(excerptStart, excerptStart + sourceLimit)}\n[Source excerpt around selection; full document version retained for validation.]`
    : options.sourceText;
  return {
    system: [
      "This is a continuation of the exact annotation path below. Answer the current question using its prior review; do not start an unrelated conversation.",
      "Earlier completed ancestor edges are pinned historical versions, not claims about the current contents of edited parent cards.",
      `Annotation path: ${chain.map(item => item.id).join(" -> ")}`,
      `Source file: ${root.sourceFile}`,
      `Selected text:\n${target.anchor.selectedText}`,
      `Original learner annotation:\n${chain[1]?.branch?.parentReply.question ?? root.userNote}`,
      `Source document:\n${sourceExcerpt}`
    ].join("\n\n"),
    history, annotationIds: chain.map(item => item.id), sourceVersion
  };
}
