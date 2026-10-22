import { contextVersion } from "./teaching-policy.js";

export type LearningIO = {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  list(path: string): Promise<string[]>;
  compareWrite(path: string, previous: string | null, next: string): Promise<void>;
};
export type RecordCompleteness = "complete" | "partial" | "unavailable";
export type RecordIssueCategory = "corrupt" | "too-large" | "identity-mismatch" | "duplicate-id" |
  "cross-reference" | "unsupported-format" | "read-failed" | "directory-unreadable" |
  "backup-invalid" | "recovery-conflict" | "recovery-failed" | "protection-unavailable";
export type RecordScope = { source: string; annotationId?: string; concept?: string };
export type RecordIntegrityIssue = {
  issueId: string; recordId?: string; category: RecordIssueCategory; recovered: boolean;
  /** Host-only routing data. Never include this field in diagnostics or external summaries. */
  scope?: RecordScope;
};
export type RecordReadResult<T> = {
  records: T[]; integrityIssues: RecordIntegrityIssue[]; completeness: RecordCompleteness; revision: string;
};
export type LearningRecordChange = { recordId: string; sources: string[]; unknownScope: boolean; revision: string };
export type LearningRecordCommit = LearningRecordChange & { requestId?: string };
type StoredRecord = { id: string; source: { path: string; annotationId?: string }; concept: string; updatedAt: string };
type ReadOptions<T> = {
  format: number; maxBytes?:number; parse(value: unknown): T; validReferences(value: T): boolean;
  /** Must durably protect history before any old snapshot is restored or exposed. */
  beforeRecover?(input: { recordId: string; backup: T }): Promise<unknown>;
};
type Checked<T> = { record: T; category?: never; scope: RecordScope } | { category: RecordIssueCategory; record?: never; scope?: RecordScope };

/** Bound stored JSON independently of individual field limits; oversized files are preserved and isolated. */
export const MAX_LEARNING_RECORD_BYTES = 16 * 1024 * 1024;
export const learningRecordWithinLimit = (raw:string) => raw.length<=MAX_LEARNING_RECORD_BYTES && new TextEncoder().encode(raw).byteLength<=MAX_LEARNING_RECORD_BYTES;
const filename = /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.json$/i;
const scopeOf = (record: StoredRecord): RecordScope => ({ source: record.source.path, annotationId: record.source.annotationId, concept: record.concept });
function scopeHint(value: unknown): RecordScope | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as { source?: { path?: unknown; annotationId?: unknown }; concept?: unknown };
  if (typeof item.source?.path !== "string" || item.source.path.length > 1000) return;
  return { source: item.source.path, ...(typeof item.source.annotationId === "string" ? { annotationId: item.source.annotationId } : {}),
    ...(typeof item.concept === "string" ? { concept: item.concept } : {}) };
}

export function completeRecordReadResult<T>(records: readonly T[]): RecordReadResult<T> {
  return { records: [...records], integrityIssues: [], completeness: "complete", revision: contextVersion(JSON.stringify(records)) };
}
export function combineRecordReadResults<T>(results: readonly RecordReadResult<T>[]): RecordReadResult<T> {
  return { records: results.flatMap(result => result.records), integrityIssues: results.flatMap(result => result.integrityIssues),
    completeness: results.every(result => result.completeness === "complete") ? "complete" :
      results.every(result => result.completeness === "unavailable") ? "unavailable" : "partial",
    revision: contextVersion(JSON.stringify(results.map(result => result.revision))) };
}

/** Reads and quarantines each record independently. A read never invents evidence or overwrites a new format. */
export class LearningRecordReader<T extends StoredRecord> {
  private known = new Map<string, { raw: string | null; scope?: RecordScope }>();
  private repairing = new Set<string>();
  private archived = new Map<string, { raw: string; path: string }>();
  private reported = new Set<string>();
  private diagnostics: Array<{ issueId: string; category: RecordIssueCategory; recovered: boolean }> = [];
  constructor(private io: LearningIO, readonly root: string, private options: ReadOptions<T>) {}

  private recordPath(path: string): { path: string; id: string } | undefined {
    const base = path.replace(/\.(deleted|previous)$/, "");
    if (!base.startsWith(this.root + "/")) return;
    const match = filename.exec(base.slice(this.root.length + 1));
    return match ? { path: base, id: match[1]!.toLowerCase() } : undefined;
  }
  remember(path: string, raw: string | null, record?: T) {
    this.known.set(path, { raw, scope: record ? scopeOf(record) : this.known.get(path)?.scope });
  }
  /** Once per unique local problem; includes no paths, filenames, answers or raw exception messages. */
  takeIntegrityIssues() { return this.diagnostics.splice(0); }
  private issue(path: string, recordId: string | undefined, category: RecordIssueCategory, raw?: string | null, scope?: RecordScope): RecordIntegrityIssue {
    return { issueId: contextVersion(`${path}\n${category}\n${raw ?? ""}`), ...(recordId ? { recordId } : {}), category, recovered: false, ...(scope ? { scope } : {}) };
  }
  private check(raw: string, id: string): Checked<T> {
    if (!learningRecordWithinLimit(raw) || this.options.maxBytes!==undefined && new TextEncoder().encode(raw).byteLength>this.options.maxBytes) return { category: "too-large" };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { category: "corrupt" }; }
    const scope = scopeHint(value);
    if (value && typeof value === "object" && "format" in value && value.format !== this.options.format) return { category: "unsupported-format", scope };
    let record: T;
    try { record = this.options.parse(value); } catch { return { category: "corrupt", scope }; }
    if (record.id.toLowerCase() !== id) return { category: "identity-mismatch", scope };
    if (!this.options.validReferences(record)) return { category: "cross-reference", scope };
    return { record, scope: scopeOf(record) };
  }
  validate(raw:string,id:string):T {
    const checked=this.check(raw,id.toLowerCase());
    if(checked.category!==undefined)throw new Error(`learning-record-${checked.category}`);
    return checked.record;
  }
  async change(path: string): Promise<LearningRecordChange | null> {
    if(this.repairing.has(path))return null;
    const target = this.recordPath(path); if (!target) return null;
    const previous = this.known.get(target.path);
    let raw: string | null;
    try { raw = await this.io.read(path); } catch { raw = null; }
    if (this.known.has(path) && this.known.get(path)!.raw === raw) return null;
    const checked = path === target.path && raw !== null ? this.check(raw, target.id) : undefined;
    const scope = checked?.record ? checked.scope : previous?.scope ?? checked?.scope;
    this.known.set(path, { raw, scope });
    const sources = [...new Set([previous?.scope?.source, scope?.source].filter((source): source is string => source !== undefined))];
    return { recordId: target.id, sources, unknownScope: !sources.length, revision: contextVersion(`${path}\n${raw ?? ""}`) };
  }
  async read(): Promise<RecordReadResult<T>> {
    const records: T[] = [], integrityIssues: RecordIntegrityIssue[] = [];
    let paths: string[];
    try { paths = await this.io.list(this.root); }
    catch { return this.result(records, [this.issue(this.root, undefined, "directory-unreadable")], "unavailable"); }
    const pathSet = new Set(paths);
    const candidates = [...pathSet].map(path => this.recordPath(path)).filter((entry): entry is { path: string; id: string } => !!entry)
      .filter(entry => pathSet.has(entry.path));
    const unique = [...new Map(candidates.map(entry => [entry.path, entry])).values()];
    const counts = new Map<string, number>();
    for (const { id } of unique) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const { path, id } of unique.sort((a, b) => a.path.localeCompare(b.path))) {
      let raw: string | null = null, scope = this.known.get(path)?.scope;
      try {
        const deleted = await this.io.read(path + ".deleted"); this.known.set(path + ".deleted", { raw: deleted, scope });
        if (deleted !== null) continue;
        raw = await this.io.read(path);
        if (raw === null) continue;
        const checked = this.check(raw, id); scope = checked.record ? checked.scope : scope ?? checked.scope;
        this.known.set(path, { raw, scope });
        if ((counts.get(id) ?? 0) > 1) { integrityIssues.push(this.issue(path, id, "duplicate-id", raw, scope)); continue; }
        if (checked.category === undefined) { records.push(checked.record); continue; }
        const problem = this.issue(path, id, checked.category, raw, scope); integrityIssues.push(problem);
        // A future format may be valid for a newer application. Never downgrade it using .previous.
        if (checked.category === "unsupported-format") continue;
        const previous = await this.io.read(path + ".previous");
        if (previous === null) continue;
        const backup = this.check(previous, id);
        if (!backup.record) { integrityIssues.push(this.issue(path, id, "backup-invalid", previous, scope)); continue; }
        problem.scope ??= backup.scope; scope ??= backup.scope;
        if (await this.io.read(path + ".deleted") !== null) { integrityIssues.pop(); continue; }
        const archived=this.archived.get(path);
        if(archived?.raw!==raw || await this.io.read(archived.path)!==raw){
          const archivePath=`${path}.corrupt-${crypto.randomUUID()}`;
          await this.io.write(archivePath, raw);this.archived.set(path,{raw,path:archivePath});
        }
        if (await this.io.read(path + ".deleted") !== null) { integrityIssues.pop(); continue; }
        await this.options.beforeRecover?.({ recordId: id, backup: backup.record });
        if (await this.io.read(path + ".deleted") !== null) { integrityIssues.pop(); continue; }
        try {
          this.repairing.add(path);
          await this.io.compareWrite(path, raw, previous);
          if (await this.io.read(path + ".deleted") !== null) { integrityIssues.pop(); continue; }
          problem.recovered = true; records.push(backup.record); this.remember(path, previous, backup.record);
        } catch {
          // An external repair wins. Re-read it, so callers do not use the stale backup in memory either.
          const latest = await this.io.read(path);
          if (await this.io.read(path + ".deleted") !== null) { integrityIssues.pop(); continue; }
          const repaired = latest === null ? undefined : this.check(latest, id);
          problem.category = "recovery-conflict";
          if (repaired?.record) { problem.recovered = true; records.push(repaired.record); this.remember(path, latest, repaired.record); }
        } finally {this.repairing.delete(path);}
      } catch {
        integrityIssues.push(this.issue(path, id, raw === null ? "read-failed" : "recovery-failed", raw, scope));
      }
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return this.result(records, integrityIssues, integrityIssues.some(issue => !issue.recovered) ? "partial" : "complete");
  }
  private result(records: T[], integrityIssues: RecordIntegrityIssue[], completeness: RecordCompleteness): RecordReadResult<T> {
    for (const { issueId, category, recovered } of integrityIssues) if (!this.reported.has(issueId)) {
      this.reported.add(issueId); this.diagnostics.push({ issueId, category, recovered });
    }
    return { records, integrityIssues, completeness, revision: contextVersion(JSON.stringify({ records, issues: integrityIssues.filter(issue => !issue.recovered) })) };
  }
}

/** Validate references before an individual record can influence prompts or capability judgments. */
export function uniqueIds(items: readonly { id: string }[]): boolean { return new Set(items.map(item => item.id)).size === items.length; }
export function validCorrectionReferences(items: readonly { id: string; corrects?: string }[]): boolean {
  const seen = new Set<string>();
  for (const item of items) { if (item.corrects && !seen.has(item.corrects)) return false; seen.add(item.id); }
  return uniqueIds(items);
}
