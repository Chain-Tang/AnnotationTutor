import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { boardBrushDefinitionSchema } from "./board-model.js";
import type { BoardBrushDefinition, BoardBrushResourceRef } from "./board-types.js";

export const TUTOR_BRUSH_MAX_BYTES = 16 * 1024 * 1024;

export type TutorBrushPack = {
  brush: BoardBrushDefinition;
  resources: Map<string, Uint8Array>;
};

type BrushPackManifest = {
  format: "tutorbrush";
  formatVersion: 1 | 2;
  brush: BoardBrushDefinition;
  resources: Array<BoardBrushResourceRef & { archivePath: string }>;
};

function refs(brush: BoardBrushDefinition): BoardBrushResourceRef[] {
  return [brush.tip, brush.grain, brush.paper].filter((resource): resource is BoardBrushResourceRef => !!resource);
}

function safeArchivePath(path: string): boolean {
  return /^assets\/[a-f\d]{64}\.(?:png|webp)$/i.test(path) && !path.includes("..") && !path.includes("\\");
}

function extension(mimeType: BoardBrushResourceRef["mimeType"]): string {
  return mimeType === "image/png" ? "png" : "webp";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function exportTutorBrush(pack: TutorBrushPack): Promise<Uint8Array> {
  const brush = boardBrushDefinitionSchema.parse(structuredClone(pack.brush));
  const files: Record<string, Uint8Array> = {};
  const resources: BrushPackManifest["resources"] = [];
  let total = 0;
  for (const resource of refs(brush)) {
    const bytes = pack.resources.get(resource.hash);
    if (!bytes) throw new Error(`Missing brush resource: ${resource.hash}`);
    if (await sha256Hex(bytes) !== resource.hash.toLowerCase()) throw new Error(`Brush resource checksum mismatch: ${resource.hash}`);
    const archivePath = `assets/${resource.hash.toLowerCase()}.${extension(resource.mimeType)}`;
    files[archivePath] = bytes;
    resources.push({ ...resource, hash: resource.hash.toLowerCase(), archivePath });
    total += bytes.byteLength;
  }
  const manifest: BrushPackManifest = { format: "tutorbrush", formatVersion: brush.formatVersion, brush, resources };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  total += files["manifest.json"]!.byteLength;
  if (total > TUTOR_BRUSH_MAX_BYTES) throw new Error("Tutor brush pack exceeds 16 MB");
  return zipSync(files, { level: 6, mtime: new Date("1980-02-01T00:00:00.000Z") });
}

export async function importTutorBrush(bytes: Uint8Array): Promise<TutorBrushPack> {
  if (bytes.byteLength > TUTOR_BRUSH_MAX_BYTES) throw new Error("Tutor brush pack exceeds 16 MB");
  let declared = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      if (file.name.includes("..") || file.name.includes("\\") || file.name.startsWith("/"))
        throw new Error("Unsafe path in Tutor brush pack");
      declared += file.originalSize;
      if (declared > TUTOR_BRUSH_MAX_BYTES) throw new Error("Expanded Tutor brush pack exceeds 16 MB");
      return file.name === "manifest.json" || safeArchivePath(file.name);
    },
  });
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Tutor brush manifest is missing");
  const candidate = JSON.parse(strFromU8(manifestBytes)) as Partial<BrushPackManifest>;
  if (candidate.format !== "tutorbrush" || ![1, 2].includes(candidate.formatVersion ?? 0) || !candidate.brush || !Array.isArray(candidate.resources))
    throw new Error("Unsupported Tutor brush format");
  const brush = boardBrushDefinitionSchema.parse(candidate.brush);
  if (brush.formatVersion !== candidate.formatVersion) throw new Error("Tutor brush manifest version mismatch");
  const expected = new Map(refs(brush).map(resource => [resource.hash.toLowerCase(), resource]));
  const resources = new Map<string, Uint8Array>();
  for (const entry of candidate.resources) {
    const resource = expected.get(entry.hash?.toLowerCase());
    if (!resource || !safeArchivePath(entry.archivePath)) throw new Error("Unexpected resource in Tutor brush pack");
    if (entry.mimeType !== resource.mimeType || entry.width !== resource.width || entry.height !== resource.height)
      throw new Error("Tutor brush resource metadata mismatch");
    const asset = files[entry.archivePath];
    if (!asset || await sha256Hex(asset) !== resource.hash.toLowerCase()) throw new Error(`Brush resource checksum mismatch: ${resource.hash}`);
    resources.set(resource.hash.toLowerCase(), asset);
  }
  if (resources.size !== expected.size) throw new Error("Tutor brush pack is incomplete");
  return { brush, resources };
}
