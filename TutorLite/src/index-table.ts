// The rebuildable index (spec §7.4 / §10). Pure: it operates on data only, so
// file I/O (reading annotation files, persisting index.json) lives in the
// Obsidian layer (store.ts) while this stays unit-testable.

import {
  type Annotation,
  type AnnotationStatus,
  type IndexFile,
  type IndexRecord,
  caretId
} from "./model.js";
import { parseAnnotationFile } from "./markdown/annotation-file.js";
import { truncate } from "./markdown/blocks.js";

export type IndexQuery = {
  text?: string;
  status?: AnnotationStatus | "";
  sourceFile?: string;
  concept?: string;
  reviewState?: "reviewed" | "unreviewed" | "";
  withinDays?: number;
};

export function recordFromAnnotation(
  annotation: Annotation,
  memoryFile: string
): IndexRecord {
  const reviewSummary = annotation.review?.summary
    ? truncate(annotation.review.summary)
    : annotation.reviewText
      ? truncate(annotation.reviewText)
      : undefined;
  return {
    annotationId: annotation.id,
    memoryFile,
    sourceFile: annotation.sourceFile,
    anchor: caretId(annotation.anchor.blockId),
    anchorOrigin: annotation.anchorOrigin ?? "legacy",
    selectedText: annotation.anchor.selectedText,
    status: annotation.status,
    concepts: annotation.concepts,
    relatedMemoryCells: annotation.relatedMemoryCells,
    reviewSummary,
    reviewText: annotation.reviewText,
    userNoteSummary: annotation.userNote
      ? truncate(annotation.userNote)
      : undefined,
    userNote: annotation.userNote,
    ...(annotation.dialogue && annotation.dialogue.length > 0
      ? { dialogue: annotation.dialogue }
      : {}),
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt
  };
}

/** Parse a set of annotation files into index records, collecting unreadable paths. */
export function buildRecords(
  files: { path: string; content: string }[]
): { records: IndexRecord[]; errors: string[] } {
  const records: IndexRecord[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const annotation = parseAnnotationFile(file.content);
    if (!annotation) {
      errors.push(file.path);
      continue;
    }
    records.push(recordFromAnnotation(annotation, file.path));
  }
  return { records, errors };
}

function hasReview(status: AnnotationStatus): boolean {
  return status === "reviewed" || status === "reviewed_unstructured";
}

export class IndexTable {
  private readonly records = new Map<string, IndexRecord>();

  public constructor(records: IndexRecord[] = []) {
    this.replaceAll(records);
  }

  public static fromJson(text: string): IndexTable {
    try {
      const parsed = JSON.parse(text) as Partial<IndexFile>;
      const rows = Array.isArray(parsed.records) ? parsed.records : [];
      return new IndexTable(rows.filter(isRecord));
    } catch {
      return new IndexTable();
    }
  }

  public toJson(): string {
    const file: IndexFile = { version: 1, records: this.all() };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  public all(): IndexRecord[] {
    return [...this.records.values()];
  }

  public ids(): string[] {
    return [...this.records.keys()];
  }

  public get(annotationId: string): IndexRecord | undefined {
    return this.records.get(annotationId);
  }

  public upsert(record: IndexRecord): void {
    this.records.set(record.annotationId, record);
  }

  public remove(annotationId: string): void {
    this.records.delete(annotationId);
  }

  public replaceAll(records: IndexRecord[]): void {
    this.records.clear();
    for (const record of records) this.records.set(record.annotationId, record);
  }

  public sources(): string[] {
    return [...new Set(this.all().map((record) => record.sourceFile))].sort();
  }

  public concepts(): string[] {
    return [
      ...new Set(this.all().flatMap((record) => record.concepts))
    ].sort();
  }

  public query(filter: IndexQuery = {}): IndexRecord[] {
    const text = filter.text?.toLowerCase().trim();
    const cutoff = filter.withinDays
      ? Date.now() - filter.withinDays * 86_400_000
      : undefined;
    return this.all()
      .filter((record) => {
        if (text) {
          const haystack = [
            record.annotationId,
            record.sourceFile,
            record.userNoteSummary ?? "",
            record.reviewSummary ?? "",
            ...record.concepts
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        if (filter.status && record.status !== filter.status) return false;
        if (filter.sourceFile && record.sourceFile !== filter.sourceFile) {
          return false;
        }
        if (filter.concept && !record.concepts.includes(filter.concept)) {
          return false;
        }
        if (filter.reviewState === "reviewed" && !hasReview(record.status)) {
          return false;
        }
        if (filter.reviewState === "unreviewed" && hasReview(record.status)) {
          return false;
        }
        if (cutoff !== undefined) {
          const created = Date.parse(record.createdAt);
          if (Number.isFinite(created) && created < cutoff) return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

function isRecord(value: unknown): value is IndexRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IndexRecord).annotationId === "string"
  );
}
