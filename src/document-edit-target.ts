import { padBlockInsertion } from "./edit-parse.js";
import { captureTextTarget, resolveTextTarget, type TextTarget } from "./text-target.js";

type Position = { line: number; ch: number };
export type DocumentFile = { path: string; stat: { mtime: number; size: number } };
export type DocumentEditor = {
  getValue(): string;
  offsetToPos(offset: number): Position;
  replaceRange(text: string, from: Position, to?: Position): void;
};
export type DocumentBuffer = { file: DocumentFile; editor: DocumentEditor };
export type DocumentEditReceipt = {
  requestId: string;
  targetId: string;
  path: string;
  baseRevision: string;
  appliedRevision: string;
  durability: "applied-not-durable";
};
export type DocumentEditTarget = {
  vault: object;
  file: DocumentFile;
  editor: DocumentEditor;
  documentId: string;
  requestId: string;
  pathAtCapture: string;
  bufferRevision: string;
  diskRevision: string;
  text: TextTarget;
  insertion: TextTarget;
  hasSelection: boolean;
  original: string;
  /** Shared by insertion variants so a proposal can only be applied once. */
  application: { receipt?: DocumentEditReceipt; replacement?: string; hasSelection?: boolean; pending?: boolean; uncertain?: boolean };
};
type EditHost = { vault: object; fileAt(path: string): unknown; buffers: DocumentBuffer[] };
type EditResult = { ok: true; receipt: DocumentEditReceipt; editor?: DocumentEditor }
  | { ok: false; reason: "identity" | "closed" | "buffers" | "disk" | "range" | "already-applied" | "outcome-unknown" };

// File object identities belong to this plugin session. A rename preserves the
// object and updates its path; deletion/recreation produces a different object.
const documentIds = new WeakMap<object, string>();
let nextDocument = 0;
let nextRequest = 0;
function revision(text: string): string {
  let hash = 2166136261;
  for (let i=0;i<text.length;i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619);
  return `${text.length}:${(hash>>>0).toString(16)}`;
}
function diskRevision(file: DocumentFile): string {
  return `${file.stat.mtime}:${file.stat.size}`;
}
function matchingBuffers(host: EditHost, file: DocumentFile): DocumentBuffer[] {
  return host.buffers.filter(buffer => buffer.file === file);
}

export function captureDocumentEditTarget(host: EditHost, file: DocumentFile, editor: DocumentEditor, start: number, end: number): DocumentEditTarget | null {
  if (host.fileAt(file.path) !== file) return null;
  const buffers = matchingBuffers(host,file), content = editor.getValue();
  if (!buffers.some(buffer => buffer.editor === editor) || buffers.some(buffer => buffer.editor.getValue() !== content)) return null;
  const text = captureTextTarget(content,start,end);
  if (!resolveTextTarget(text,content,true)) return null;
  let documentId = documentIds.get(file);
  if (!documentId) { documentId = `document-${++nextDocument}`; documentIds.set(file,documentId); }
  return { vault:host.vault,file,editor,documentId,requestId:`document-edit-${++nextRequest}`,
    pathAtCapture:file.path,bufferRevision:revision(content),diskRevision:diskRevision(file),
    text,insertion:captureTextTarget(content,start,start),hasSelection:start!==end,original:text.original,application:{} };
}

/** One editor transaction, with no disk write or persistence claim. */
export function applyDocumentEdit(target: DocumentEditTarget, replacement: string, host: EditHost): EditResult {
  const applied = target.application;
  if (applied.receipt) {
    return applied.replacement === replacement && applied.hasSelection === target.hasSelection
      ? {ok:true,receipt:applied.receipt} : {ok:false,reason:"already-applied"};
  }
  if (applied.pending || applied.uncertain) return {ok:false,reason:"outcome-unknown"};
  if (host.vault !== target.vault || host.fileAt(target.file.path) !== target.file) return {ok:false,reason:"identity"};
  const buffers = matchingBuffers(host,target.file);
  if (!buffers.length) return {ok:false,reason:"closed"};
  const editor = buffers.find(buffer => buffer.editor === target.editor)?.editor ?? buffers[0]!.editor;
  const content = editor.getValue();
  if (buffers.some(buffer => buffer.editor.getValue() !== content) || host.buffers.some(buffer => buffer.editor === editor && buffer.file !== target.file)) return {ok:false,reason:"buffers"};
  // Unknown disk changes can leave an open editor stale. Never overwrite them
  // through that buffer; a fresh request can capture a confirmed new baseline.
  if (diskRevision(target.file) !== target.diskRevision) return {ok:false,reason:"disk"};
  const range = resolveTextTarget(target.hasSelection ? target.text : target.insertion,content,!target.hasSelection);
  if (!range) return {ok:false,reason:"range"};
  const text = target.hasSelection ? replacement : padBlockInsertion(content.slice(0,range.start),content.slice(range.end),replacement);
  applied.pending=true;
  try {
    editor.replaceRange(text,editor.offsetToPos(range.start),editor.offsetToPos(range.end));
    const current=editor.getValue();
    if (current !== content.slice(0,range.start)+text+content.slice(range.end)) {
      applied.uncertain=true;
      return {ok:false,reason:"outcome-unknown"};
    }
    const receipt: DocumentEditReceipt = {requestId:target.requestId,targetId:target.documentId,path:target.file.path,
      baseRevision:target.bufferRevision,appliedRevision:revision(current),durability:"applied-not-durable"};
    applied.receipt=receipt; applied.replacement=replacement; applied.hasSelection=target.hasSelection;
    return {ok:true,receipt,editor};
  } catch {
    // A host exception may happen after mutation. Do not retry an unknown
    // outcome or silently claim that no change reached the buffer.
    applied.uncertain=true;
    return {ok:false,reason:"outcome-unknown"};
  } finally {
    applied.pending=false;
  }
}
