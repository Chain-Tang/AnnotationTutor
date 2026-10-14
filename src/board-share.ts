import { boardLayoutSchema, type BoardLayoutManifest } from "./board-layout.js";
import {builtInBoardAssets} from "./board-characters.js";
import { strToU8, zipSync, type Zippable } from "fflate";
import { validateBoardDocument, validateBoardInk, tutorCharacterProfileSchema } from "./board-model.js";
import { sha256Hex } from "./board-brush-pack.js";
import type {
  TutorCharacterProfile,
  BoardDocument,
  BoardInk,
  BoardShareProvider,
  BoardShareRequest,
  BoardShareResult,
} from "./board-types.js";

type ArchiveFile = { path: string; bytes: Uint8Array };

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function genericSource(document: BoardDocument): string {
  return document.sourceType === "pdf" ? "shared.pdf" : document.sourceType === "markdown" ? "shared.md" : "shared.tutorboard";
}

/** Removes host paths, recognition providers and invisible artwork from public payloads. */
export function sanitizeBoardForPublicShare(
  input: BoardDocument,
  options: { includeHidden?: boolean; includePrivateMetadata?: boolean } = {},
): BoardDocument {
  const document = structuredClone(input);
  if (!options.includePrivateMetadata) {
    document.sourceFile = genericSource(document);
    document.sourceRevision = "";
    document.semanticGroups = (document.semanticGroups ?? []).map(group => {
      const { recognition: _recognition, ...safe } = group;
      return safe;
    });
  }
  if (!options.includeHidden && document.layers?.length) {
    const layerById = new Map(document.layers.map(layer => [layer.id, layer]));
    const visible = (id: string): boolean => {
      let layer = layerById.get(id);
      const seen = new Set<string>();
      while (layer) {
        if (!layer.visible || seen.has(layer.id)) return false;
        seen.add(layer.id);
        layer = layer.parentId ? layerById.get(layer.parentId) : undefined;
      }
      return true;
    };
    const visibleIds = new Set(document.layers.filter(layer => visible(layer.id)).map(layer => layer.id));
    document.layers = document.layers.filter(layer => visibleIds.has(layer.id));
    document.objects = document.objects.filter(object => !object.layerId || visibleIds.has(object.layerId));
    const usedVectors = new Set(document.objects.flatMap(object => object.kind === "vector" && object.vectorAssetId && object.vectorAssetVersion
      ? [`${object.vectorAssetId}:${object.vectorAssetVersion}`] : []));
    const usedDefinitions = new Set(document.objects.flatMap(object => object.characterRecipe
      ? [`${object.characterRecipe.definitionId}:${object.characterRecipe.definitionVersion}`] : []));
    document.characterDefinitions = (document.characterDefinitions ?? []).filter(definition => usedDefinitions.has(`${definition.id}:${definition.version}`));
    for (const definition of document.characterDefinitions)
      usedVectors.add(`${definition.vectorAssetId}:${definition.vectorAssetVersion}`);
    document.vectorAssets = (document.vectorAssets ?? []).filter(asset => usedVectors.has(`${asset.id}:${asset.version}`));
    document.paintOperations = (document.paintOperations ?? []).filter(operation => visibleIds.has(operation.layerId));
    if (document.tileManifest)
      document.tileManifest.tiles = document.tileManifest.tiles.filter(tile => visibleIds.has(tile.layerId));
    const objectIds = new Set(document.objects.map(object => object.id));
    document.semanticGroups = (document.semanticGroups ?? []).map(group => ({
      ...group,
      objectIds: group.objectIds.filter(id => objectIds.has(id)),
      replacementObjectIds: group.replacementObjectIds?.filter(id => objectIds.has(id)),
    })).filter(group => group.objectIds.length > 0);
  }
  return validateBoardDocument(document);
}

async function checksumManifest(files: readonly ArchiveFile[]): Promise<Uint8Array> {
  const entries = await Promise.all(files.map(async file => ({
    path: file.path,
    bytes: file.bytes.byteLength,
    sha256: await sha256Hex(file.bytes),
  })));
  return strToU8(JSON.stringify({ format: "tutorboard-checksums-v1", files: entries }, null, 2));
}

export async function buildTutorBoardArchive(input: {
  document: BoardDocument;
  ink: BoardInk;
  layout?:BoardLayoutManifest;
  previewPng?: Uint8Array;
  profiles?: readonly TutorCharacterProfile[];
  imageAssets?: ReadonlyMap<string, Uint8Array>;
  paintAssets?: ReadonlyMap<string, Uint8Array>;
  brushAssets?: ReadonlyMap<string, Uint8Array>;
  includeHidden?: boolean;
  includePrivateMetadata?: boolean;
}): Promise<Uint8Array> {
  const document = sanitizeBoardForPublicShare(input.document, input);
  const usedInkIds = new Set([
    ...document.objects.flatMap(object => object.inkId ? [object.inkId] : []),
    ...(document.paintOperations ?? []).flatMap(operation => operation.inkId ? [operation.inkId] : []),
  ]);
  const ink = Object.fromEntries(Object.entries(input.ink).filter(([id]) => usedInkIds.has(id)));
  validateBoardInk(document, ink);
  const files: ArchiveFile[] = [
    { path: "board.json", bytes: strToU8(JSON.stringify(document, null, 2)) },
    { path: "ink/ink.json", bytes: strToU8(JSON.stringify(ink)) },
  ];
  if(input.layout){const layout=boardLayoutSchema.parse(structuredClone(input.layout));
    if(layout.boardId!==document.id)throw Error("layout-board-mismatch");
    const ids=new Set(document.objects.map(o=>o.id));layout.slots=layout.slots.map(slot=>({...slot,bindings:slot.bindings.filter(b=>ids.has(b.objectId))})).filter(slot=>slot.bindings.length);
    files.push({path:"layout.json",bytes:strToU8(JSON.stringify(layout))});
  }
  for (const asset of document.vectorAssets ?? [])
    files.push({ path: `vectors/${asset.id}-v${asset.version}.json`, bytes: strToU8(JSON.stringify(asset)) });
  for (const definition of document.characterDefinitions ?? [])
    files.push({ path: `characters/${definition.id}-v${definition.version}.json`, bytes: strToU8(JSON.stringify(definition)) });
  const references = new Set(document.objects.flatMap(object => object.assetId ? [`${object.assetId}:${object.assetVersion}`] : object.characterId ? [`${object.characterId}:${object.characterVersion}`] : []));
  const exported = new Set<string>();
  const includeProfile = (key: string, depth = 0): void => {
    if (exported.has(key)) return;
    if (depth > 8) throw new Error("asset-dependency-depth");
    const source = input.profiles?.find(profile => `${profile.id}:${profile.version}` === key);
    if (!source) {if(builtInBoardAssets().some(profile=>`${profile.id}:${profile.version}`===key))return;throw new Error(`Missing character profile: ${key}`);}
    if(source.origin === "builtin") return;
    exported.add(key);
    const profile = tutorCharacterProfileSchema.parse(structuredClone(source));
    if (profile.assetPath) {
      const bytes = input.imageAssets?.get(profile.assetPath);
      if (!bytes) throw new Error(`Missing image asset for ${profile.id}`);
      const extension = profile.assetPath.split(".").pop()?.toLowerCase();
      if (!extension || !["png", "jpg", "jpeg", "webp"].includes(extension)) throw new Error("invalid-image-extension");
      profile.assetPath = `images/${profile.id}-v${profile.version}.${extension}`;
      files.push({ path: profile.assetPath, bytes });
    }
    for (const object of profile.objects ?? []) {
      const id = object.assetId ?? object.characterId, version = object.assetVersion ?? object.characterVersion;
      if (id) includeProfile(`${id}:${version}`, depth + 1);
    }
    files.push({ path: `profiles/${profile.id}-v${profile.version}.json`, bytes: strToU8(JSON.stringify(profile)) });
  };
  for (const key of references) includeProfile(key);
  if (input.previewPng) files.push({ path: "preview.png", bytes: input.previewPng });
  const usedPaintAssets = new Set((document.paintOperations ?? []).flatMap(operation => operation.maskAssetHash ? [operation.maskAssetHash] : []));
  const usedBrushAssets = new Set([
    ...(document.brushDefinitions ?? []).flatMap(brush => [brush.tip?.hash, brush.grain?.hash, brush.paper?.hash].filter((hash): hash is string => !!hash)),
    ...(document.paintOperations ?? []).flatMap(operation => operation.brush?.resourceHashes ?? []),
  ]);
  for(const hash of usedPaintAssets)if(!input.paintAssets?.has(hash))throw new Error(`Missing paint asset: ${hash}`);
  for(const hash of usedBrushAssets){
    const bytes=input.brushAssets?.get(hash);
    if(!bytes)throw new Error(`Missing brush asset: ${hash}`);
    if(await sha256Hex(bytes)!==hash.toLowerCase())throw new Error(`Brush asset checksum mismatch: ${hash}`);
  }
  for (const [hash, bytes] of input.paintAssets ?? []) if (usedPaintAssets.has(hash)) files.push({ path: `paint/${hash}.mask.deflate`, bytes });
  for (const [hash, bytes] of input.brushAssets ?? []) if (usedBrushAssets.has(hash)) files.push({ path: `brushes/${hash}.bin`, bytes });
  files.push({ path: "checksums.json", bytes: await checksumManifest(files) });
  const archive: Record<string, Uint8Array> = {};
  for (const file of files) archive[file.path] = file.bytes;
  return zipSync(archive, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

export type OpenRasterLayer = {
  name: string;
  png: Uint8Array;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
};

const oraBlend: Record<string, string> = {
  normal: "svg:src-over", multiply: "svg:multiply", screen: "svg:screen",
  overlay: "svg:overlay", darken: "svg:darken", lighten: "svg:lighten",
  "soft-light": "svg:soft-light", "hard-light": "svg:hard-light",
};

export function buildOpenRasterArchive(input: {
  width: number;
  height: number;
  layers: readonly OpenRasterLayer[];
  mergedPng: Uint8Array;
  thumbnailPng?: Uint8Array;
}): Uint8Array {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1)
    throw new Error("OpenRaster requires positive integer dimensions");
  const layerNodes = input.layers.map((layer, index) =>
    `<layer name="${xml(layer.name)}" src="data/layer-${String(index).padStart(4, "0")}.png" opacity="${Math.max(0, Math.min(1, layer.opacity ?? 1))}" visibility="${layer.visible === false ? "hidden" : "visible"}" composite-op="${oraBlend[layer.blendMode ?? "normal"] ?? "svg:src-over"}"/>`,
  ).join("");
  const archive: Zippable = {
    mimetype: [strToU8("image/openraster"), { level: 0 }],
    "stack.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><image version="0.0.1" w="${input.width}" h="${input.height}"><stack>${layerNodes}</stack></image>`),
    "mergedimage.png": input.mergedPng,
    "Thumbnails/thumbnail.png": input.thumbnailPng ?? input.mergedPng,
  };
  input.layers.forEach((layer, index) => { archive[`data/layer-${String(index).padStart(4, "0")}.png`] = layer.png; });
  return zipSync(archive, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

export function boardGalleryMarkdown(input: {
  title: string;
  previewPath: string;
  sourcePath: string;
  author?: string;
  license?: string;
}): string {
  const yaml = ["---", "type: tutor-artwork", `title: ${JSON.stringify(input.title)}`];
  if (input.author) yaml.push(`author: ${JSON.stringify(input.author)}`);
  if (input.license) yaml.push(`license: ${JSON.stringify(input.license)}`);
  yaml.push("---", "", `# ${input.title}`, "", `![[${input.previewPath.replace(/[\]\r\n|]/g, "") }]]`, "", `[可编辑源文件](${input.sourcePath.replace(/[)\r\n]/g, "")})`, "");
  return yaml.join("\n");
}

export type BoardShareEncoder = (request: BoardShareRequest) => Promise<{ bytes: Uint8Array; extension: string; mimeType: string }>;

export class VaultFileBoardShareProvider implements BoardShareProvider {
  public readonly id = "vault-file";
  public constructor(
    private readonly write: (path: string, bytes: Uint8Array) => Promise<void>,
    private readonly encode: BoardShareEncoder,
    private readonly destination: (request: BoardShareRequest, extension: string) => string,
  ) {}
  public async availability(): Promise<{ available: boolean }> { return { available: true }; }
  public async share(request: BoardShareRequest): Promise<BoardShareResult> {
    const encoded = await this.encode(request);
    const path = this.destination(request, encoded.extension);
    await this.write(path, encoded.bytes);
    return { provider: this.id, format: request.format, path, shared: true };
  }
}

export class SystemBoardShareProvider implements BoardShareProvider {
  public readonly id = "system-share";
  public constructor(private readonly encode: BoardShareEncoder) {}
  public async availability(): Promise<{ available: boolean; reason?: string }> {
    return typeof navigator !== "undefined" && typeof navigator.share === "function"
      ? { available: true }
      : { available: false, reason: "Web Share API is unavailable" };
  }
  public async share(request: BoardShareRequest): Promise<BoardShareResult> {
    if (!(await this.availability()).available) return { provider: this.id, format: request.format, shared: false };
    const encoded = await this.encode(request);
    const name = `${request.title?.trim() || "Tutor artwork"}.${encoded.extension}`;
    const file = new File([encoded.bytes.slice().buffer], name, { type: encoded.mimeType });
    await navigator.share({ title: request.title, files: [file] });
    return { provider: this.id, format: request.format, shared: true };
  }
}
