import type { App, Editor, TFile, View } from "obsidian";
import { contextVersion } from "./teaching-policy.js";

/** Runtime capability only. The token may cross a UI clone, but neither the
 * underlying view nor the editor is serialized or selected again by file path. */
export type StudySourceView = View & { file?: TFile | null; getMode?: () => string; getViewData?: () => string; editor?: Editor };
type Host = { app: App };
type Binding = { file: TFile; source: string; view?: StudySourceView; editor?: Editor; invalid?: boolean };
const registries = new WeakMap<Host, Map<string, Binding>>();
function registry(host: Host): Map<string, Binding> {
  let value = registries.get(host);
  if (!value) { value = new Map(); registries.set(host, value); }
  return value;
}
function unavailable(): never { throw new DOMException("Learning source view changed or ambiguous", "AbortError"); }
function valid(host: Host, entry: Binding): boolean {
  if (entry.invalid || host.app.vault.getAbstractFileByPath(entry.source) !== entry.file || entry.file.path !== entry.source) return false;
  if (!entry.view) return true;
  return entry.view.file === entry.file && entry.view.containerEl.isConnected && host.app.workspace.getLeavesOfType(entry.view.getViewType()).some(leaf => leaf.view === entry.view);
}
function buffer(view: StudySourceView): string | undefined {
  if (view.getMode?.() === "source") return view.editor?.getValue();
  // MarkdownView's public reader reflects its buffer, including unsaved mode switches.
  return view.getViewData?.();
}
export function captureStudySource(host: Host, source: string, explicitView?: StudySourceView): string {
  const file = host.app.vault.getAbstractFileByPath(source) as TFile | null;
  if (!file || !file.extension) return unavailable();
  let view = explicitView;
  if (!view) {
    const candidates = host.app.workspace.getLeavesOfType(file.extension === "md" ? "markdown" : "pdf")
      .map(leaf => leaf.view as StudySourceView).filter(view => view.file === file && view.containerEl.isConnected);
    const editors = candidates.filter(view => view.getMode?.() === "source");
    if (new Set(editors.map(view => buffer(view))).size > 1) return unavailable();
    // A path-only request cannot distinguish different reading buffers either.
    const readers = editors.length ? editors : candidates;
    if (new Set(readers.map(view => buffer(view)).filter(value => value !== undefined)).size > 1) return unavailable();
    view = readers[0];
  }
  const entry: Binding = { file, source, view, editor: view?.getMode?.() === "source" ? view.editor : undefined };
  if (!valid(host, entry)) return unavailable();
  const entries = registry(host);
  // Reuse a live view capability; the observation separately pins its text version.
  for (const [token, previous] of entries) {
    if (!valid(host, previous)) { previous.invalid = true; entries.delete(token); continue; }
    if (previous.file === file && previous.view === view && previous.editor === entry.editor) return token;
  }
  // Bound memory without invalidating an in-flight, otherwise valid capability.
  if (entries.size >= 4096) return unavailable();
  const token = crypto.randomUUID(); entries.set(token, entry); return token;
}
export function studySourceView(host: Host, source: string, token: string): StudySourceView | undefined {
  const entry = registry(host).get(token);
  if (!entry || entry.source !== source || !valid(host, entry)) { if (entry) entry.invalid = true; return unavailable(); }
  return entry.view;
}
export async function readStudySource(host: Host, source: string, token?: string): Promise<{sourceBinding: string; text: string; revision: string}> {
  const sourceBinding = token ?? captureStudySource(host, source);
  const entry = registry(host).get(sourceBinding);
  if (!entry || entry.source !== source || !valid(host, entry)) { if (entry) entry.invalid = true; return unavailable(); }
  if (entry.view?.getMode?.() === "source") {
    if (entry.editor && entry.editor !== entry.view.editor) { entry.invalid = true; return unavailable(); }
    entry.editor ??= entry.view.editor;
  }
  const text = entry.file.extension === "md" ? (entry.view ? buffer(entry.view) : undefined) ?? await host.app.vault.cachedRead(entry.file) : "";
  if (!valid(host, entry)) { entry.invalid = true; return unavailable(); }
  return { sourceBinding, text, revision: entry.file.extension === "md" ? contextVersion(text) : `${entry.file.stat.mtime}:${entry.file.stat.size}` };
}
