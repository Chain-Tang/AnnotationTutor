import { boardVectorAssetSchema } from "./board-model.js";
import type {
  BoardMatrix,
  BoardPathCommand,
  BoardVectorAsset,
  BoardVectorNode,
  BoardVectorPaint,
  BoardVectorStroke,
} from "./board-types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const COLOR = /^(?:#[\da-f]{3,8}|[A-Za-z]{1,24})$/i;
const SUPPORTED = new Set([
  "svg", "g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "lineargradient", "radialgradient", "stop", "clippath", "use",
]);
const FORBIDDEN = new Set([
  "script", "foreignobject", "style", "filter", "animate", "animatemotion", "animatetransform",
  "set", "iframe", "audio", "video", "canvas", "object", "embed", "image",
]);

export type SafeSvgImportResult = { asset: BoardVectorAsset; warnings: string[] };
type SvgStyle = { fill: BoardVectorPaint; stroke?: BoardVectorStroke; opacity: number; fillRule: "nonzero" | "evenodd" };

function finite(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
function safeId(value: string | null | undefined, fallback: string): string {
  return value && ID.test(value) ? value : fallback;
}
function multiply(a: BoardMatrix, b: BoardMatrix): BoardMatrix {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function parseSvgTransform(input: string | null | undefined): BoardMatrix {
  let result: BoardMatrix = [1, 0, 0, 1, 0, 0];
  const pattern = /([a-z]+)\s*\(([^)]*)\)/gi;
  for (const match of input?.matchAll(pattern) ?? []) {
    const values = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (values.some(value => !Number.isFinite(value))) throw new Error("SVG transform contains an invalid number");
    let next: BoardMatrix;
    switch (match[1]!.toLowerCase()) {
      case "matrix":
        if (values.length !== 6) throw new Error("SVG matrix requires six values");
        next = values as BoardMatrix;
        break;
      case "translate":
        next = [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
        break;
      case "scale":
        next = [values[0] ?? 1, 0, 0, values[1] ?? values[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const angle = (values[0] ?? 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
        const rotation: BoardMatrix = [cos, sin, -sin, cos, 0, 0];
        const cx = values[1] ?? 0, cy = values[2] ?? 0;
        next = cx || cy
          ? multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy])
          : rotation;
        break;
      }
      case "skewx": {
        next = [1, 0, Math.tan((values[0] ?? 0) * Math.PI / 180), 1, 0, 0];
        break;
      }
      case "skewy": {
        next = [1, Math.tan((values[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
        break;
      }
      default: throw new Error(`Unsupported SVG transform: ${match[1]}`);
    }
    result = multiply(result, next);
  }
  return result;
}

const PATH_TOKEN = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
export function parseSvgPathData(data: string): BoardPathCommand[] {
  const tokens = data.match(PATH_TOKEN) ?? [];
  const commands: BoardPathCommand[] = [];
  let index = 0, active = "", x = 0, y = 0, startX = 0, startY = 0;
  let lastCubic: [number, number] | undefined, lastQuadratic: [number, number] | undefined;
  const isCommand = (token: string | undefined): boolean => !!token && /^[A-Za-z]$/.test(token);
  const read = (): number => {
    const token = tokens[index++];
    if (token === undefined || isCommand(token)) throw new Error("Malformed SVG path data");
    const value = Number(token);
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error("SVG path number is invalid or out of range");
    return value;
  };
  while (index < tokens.length) {
    const explicitCommand = isCommand(tokens[index]);
    if (explicitCommand) active = tokens[index++]!;
    if (!active) throw new Error("SVG path must begin with a command");
    const upper = active.toUpperCase(), relative = active !== upper;
    const arity = ARITY[upper];
    if (arity === undefined) throw new Error(`Unsupported SVG path command: ${active}`);
    if (upper === "Z") {
      commands.push({ op: "Z" }); x = startX; y = startY; active = ""; lastCubic = lastQuadratic = undefined; continue;
    }
    if (index + arity > tokens.length) throw new Error("Incomplete SVG path command");
    const relX = (value: number): number => relative ? x + value : value;
    const relY = (value: number): number => relative ? y + value : value;
    if (upper === "M" || upper === "L" || upper === "T") {
      const nx = relX(read()), ny = relY(read());
      if (upper === "T") {
        const qx = lastQuadratic ? 2 * x - lastQuadratic[0] : x, qy = lastQuadratic ? 2 * y - lastQuadratic[1] : y;
        commands.push({ op: "Q", x1: qx, y1: qy, x: nx, y: ny }); lastQuadratic = [qx, qy];
      } else {
        const op = upper === "M" && explicitCommand ? "M" : "L";
        commands.push({ op, x: nx, y: ny });
        if (upper === "M") { startX = nx; startY = ny; active = relative ? "l" : "L"; }
        lastQuadratic = undefined;
      }
      x = nx; y = ny; lastCubic = undefined;
    } else if (upper === "H") {
      x = relX(read()); commands.push({ op: "L", x, y }); lastCubic = lastQuadratic = undefined;
    } else if (upper === "V") {
      y = relY(read()); commands.push({ op: "L", x, y }); lastCubic = lastQuadratic = undefined;
    } else if (upper === "Q") {
      const x1 = relX(read()), y1 = relY(read()), nx = relX(read()), ny = relY(read());
      commands.push({ op: "Q", x1, y1, x: nx, y: ny }); x = nx; y = ny; lastQuadratic = [x1, y1]; lastCubic = undefined;
    } else if (upper === "C") {
      const x1 = relX(read()), y1 = relY(read()), x2 = relX(read()), y2 = relY(read()), nx = relX(read()), ny = relY(read());
      commands.push({ op: "C", x1, y1, x2, y2, x: nx, y: ny }); x = nx; y = ny; lastCubic = [x2, y2]; lastQuadratic = undefined;
    } else if (upper === "S") {
      const x1 = lastCubic ? 2 * x - lastCubic[0] : x, y1 = lastCubic ? 2 * y - lastCubic[1] : y;
      const x2 = relX(read()), y2 = relY(read()), nx = relX(read()), ny = relY(read());
      commands.push({ op: "C", x1, y1, x2, y2, x: nx, y: ny }); x = nx; y = ny; lastCubic = [x2, y2]; lastQuadratic = undefined;
    } else if (upper === "A") {
      const rx = Math.abs(read()), ry = Math.abs(read()), rotation = read(), largeArc = read() !== 0, sweep = read() !== 0;
      const nx = relX(read()), ny = relY(read());
      if (rx === 0 || ry === 0) commands.push({ op: "L", x: nx, y: ny });
      else commands.push({ op: "A", rx, ry, rotation, largeArc, sweep, x: nx, y: ny });
      x = nx; y = ny; lastCubic = lastQuadratic = undefined;
    }
    if (commands.length > 50_000) throw new Error("SVG path exceeds 50,000 commands");
  }
  if (!commands.length || commands[0]?.op !== "M") throw new Error("SVG path must start with M");
  return commands;
}

export function svgPathData(commands: readonly BoardPathCommand[]): string {
  const number = (value: number): string => String(Math.round(value * 10_000) / 10_000);
  return commands.map(command => {
    switch (command.op) {
      case "M": case "L": return `${command.op}${number(command.x)} ${number(command.y)}`;
      case "Q": return `Q${number(command.x1)} ${number(command.y1)} ${number(command.x)} ${number(command.y)}`;
      case "C": return `C${number(command.x1)} ${number(command.y1)} ${number(command.x2)} ${number(command.y2)} ${number(command.x)} ${number(command.y)}`;
      case "A": return `A${number(command.rx)} ${number(command.ry)} ${number(command.rotation)} ${command.largeArc ? 1 : 0} ${command.sweep ? 1 : 0} ${number(command.x)} ${number(command.y)}`;
      case "Z": return "Z";
    }
  }).join(" ");
}

function colorPaint(value: string | null, opacity = 1): BoardVectorPaint {
  if (!value || value === "none") return { kind: "none" };
  if (value.startsWith("url(")) throw new Error("Unresolved SVG paint reference");
  if (!COLOR.test(value)) throw new Error(`Unsupported SVG color: ${value}`);
  return { kind: "solid", color: value, opacity: clamp(opacity) };
}
function localName(element: Element): string { return element.localName.toLowerCase(); }

/** Parse only Tutor's non-executable SVG subset into a validated scene graph. */
export function importSafeSvg(svg: string, input: { id: string; version?: number; name?: string; parser?: DOMParser } ): SafeSvgImportResult {
  if (svg.length > 8_000_000) throw new Error("SVG exceeds the 8 MB import limit");
  const parser = input.parser ?? (typeof DOMParser !== "undefined" ? new DOMParser() : undefined);
  if (!parser) throw new Error("DOMParser is unavailable");
  const document = parser.parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("SVG XML is malformed");
  const root = document.documentElement;
  if (localName(root) !== "svg") throw new Error("Expected an SVG root element");
  const warnings: string[] = [];
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const name = localName(element);
    if (FORBIDDEN.has(name)) throw new Error(`Unsafe SVG element: ${name}`);
    if (!SUPPORTED.has(name)) throw new Error(`Unsupported SVG element: ${name}`);
    for (const attribute of Array.from(element.attributes)) {
      const attr = attribute.name.toLowerCase();
      if (attr.startsWith("on") || attr === "style") throw new Error(`Unsafe SVG attribute: ${attribute.name}`);
      if ((attr === "href" || attr === "xlink:href") && !attribute.value.startsWith("#"))
        throw new Error("External SVG references are not allowed");
    }
  }
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = viewBox?.length === 4 ? viewBox[2]! : finite(root.getAttribute("width"), 1024);
  const height = viewBox?.length === 4 ? viewBox[3]! : finite(root.getAttribute("height"), 1024);
  if (!(width > 0 && height > 0 && width <= 100_000 && height <= 100_000)) throw new Error("SVG dimensions are invalid");
  const gradients = new Map<string, BoardVectorPaint>();
  for (const element of Array.from(root.querySelectorAll("linearGradient, radialGradient"))) {
    const gradientId = safeId(element.getAttribute("id"), `gradient-${gradients.size + 1}`);
    const stops = Array.from(element.querySelectorAll(":scope > stop")).map(stop => ({
      offset: clamp(finite(stop.getAttribute("offset"), 0) / (stop.getAttribute("offset")?.includes("%") ? 100 : 1)),
      color: COLOR.test(stop.getAttribute("stop-color") ?? "") ? stop.getAttribute("stop-color")! : "#000000",
      opacity: clamp(finite(stop.getAttribute("stop-opacity"), 1)),
    }));
    if (stops.length < 2) { warnings.push(`Gradient ${gradientId} had fewer than two stops and was ignored`); continue; }
    gradients.set(gradientId, localName(element) === "lineargradient" ? {
      kind: "linear-gradient", id: gradientId,
      from: { x: finite(element.getAttribute("x1"), 0), y: finite(element.getAttribute("y1"), 0) },
      to: { x: finite(element.getAttribute("x2"), width), y: finite(element.getAttribute("y2"), 0) }, stops,
    } : {
      kind: "radial-gradient", id: gradientId,
      center: { x: finite(element.getAttribute("cx"), width / 2), y: finite(element.getAttribute("cy"), height / 2) },
      focal: { x: finite(element.getAttribute("fx"), finite(element.getAttribute("cx"), width / 2)), y: finite(element.getAttribute("fy"), finite(element.getAttribute("cy"), height / 2)) },
      radius: Math.max(0.001, finite(element.getAttribute("r"), Math.min(width, height) / 2)), stops,
    });
  }
  const nodes: BoardVectorNode[] = [], rootIds: string[] = [];
  const clipIds = new Map<string, string>();
  const used = new Set<string>();
  const uniqueId = (element: Element, prefix: string): string => {
    const base = safeId(element.getAttribute("id"), `${prefix}-${nodes.length + 1}`);
    let candidate = base, suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate); return candidate;
  };
  const paint = (element: Element, name: "fill" | "stroke", inherited: BoardVectorPaint): BoardVectorPaint => {
    const value = element.getAttribute(name);
    if (value === null) return inherited;
    const reference = value.match(/^url\(#([A-Za-z0-9_-]+)\)$/);
    if (reference) {
      const gradient = gradients.get(reference[1]!);
      if (!gradient) throw new Error(`Unknown SVG paint reference: ${reference[1]}`);
      return structuredClone(gradient);
    }
    return colorPaint(value, finite(element.getAttribute(`${name}-opacity`), 1));
  };
  const walk = (element: Element, parentId: string | undefined, inherited: SvgStyle, useStack = new Set<string>()): void => {
    const tag = localName(element);
    if (["defs", "lineargradient", "radialgradient", "stop", "clippath"].includes(tag)) return;
    if (tag === "use") {
      const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
      const refId = href.slice(1);
      if (!refId || useStack.has(refId)) throw new Error("Cyclic or invalid SVG use reference");
      const referenced = Array.from(root.querySelectorAll("[id]")).find(item => item.getAttribute("id") === refId);
      if (!referenced) throw new Error(`Unknown SVG use reference: ${refId}`);
      const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");
      wrapper.setAttribute("transform", `translate(${finite(element.getAttribute("x"))} ${finite(element.getAttribute("y"))}) ${element.getAttribute("transform") ?? ""}`);
      wrapper.append(referenced.cloneNode(true));
      walk(wrapper, parentId, inherited, new Set([...useStack, refId]));
      return;
    }
    const id = uniqueId(element, tag), fill = paint(element, "fill", inherited.fill);
    const strokePaint = paint(element, "stroke", inherited.stroke?.paint ?? { kind: "none" });
    const style: SvgStyle = {
      fill,
      stroke: strokePaint.kind === "none" ? undefined : {
        paint: strokePaint,
        width: Math.max(0.01, finite(element.getAttribute("stroke-width"), inherited.stroke?.width ?? 1)),
        lineCap: (element.getAttribute("stroke-linecap") as BoardVectorStroke["lineCap"] | null) ?? inherited.stroke?.lineCap ?? "butt",
        lineJoin: (element.getAttribute("stroke-linejoin") as BoardVectorStroke["lineJoin"] | null) ?? inherited.stroke?.lineJoin ?? "miter",
        dash: element.getAttribute("stroke-dasharray")?.split(/[\s,]+/).filter(Boolean).map(Number),
        dashOffset: finite(element.getAttribute("stroke-dashoffset"), 0),
      },
      opacity: clamp(finite(element.getAttribute("opacity"), inherited.opacity)),
      fillRule: element.getAttribute("fill-rule") === "evenodd" ? "evenodd" : inherited.fillRule,
    };
    const base = {
      id, name: element.getAttribute("data-name")?.slice(0, 160) || element.getAttribute("id")?.slice(0, 160) || id,
      parentId, semanticRole: element.getAttribute("data-tutor-role")?.slice(0, 160) || undefined,
      transform: parseSvgTransform(element.getAttribute("transform")), opacity: style.opacity,
      blendMode: (["normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"].includes(element.getAttribute("data-tutor-blend") ?? "")
        ? element.getAttribute("data-tutor-blend") : "normal") as BoardVectorNode["blendMode"],
      visible: element.getAttribute("display") !== "none", locked: false,
      clipPathId: (() => {
        const reference = element.getAttribute("clip-path")?.match(/^url\(#([A-Za-z0-9_-]+)\)$/);
        if (!reference) return undefined;
        const resolved = clipIds.get(reference[1]!);
        if (!resolved) throw new Error(`Unknown SVG clip path: ${reference[1]}`);
        return resolved;
      })(),
      fill: style.fill, stroke: style.stroke, fillRule: style.fillRule,
    };
    let node: BoardVectorNode;
    if (tag === "svg" || tag === "g") node = { ...base, kind: "group" };
    else if (tag === "path") node = { ...base, kind: "path", path: parseSvgPathData(element.getAttribute("d") ?? "") };
    else if (tag === "rect") node = { ...base, kind: "shape", shape: { kind: "rect", x: finite(element.getAttribute("x")), y: finite(element.getAttribute("y")), width: finite(element.getAttribute("width")), height: finite(element.getAttribute("height")), rx: finite(element.getAttribute("rx")) || undefined, ry: finite(element.getAttribute("ry")) || undefined } };
    else if (tag === "circle" || tag === "ellipse") node = { ...base, kind: "shape", shape: { kind: "ellipse", cx: finite(element.getAttribute("cx")), cy: finite(element.getAttribute("cy")), rx: finite(element.getAttribute(tag === "circle" ? "r" : "rx")), ry: finite(element.getAttribute(tag === "circle" ? "r" : "ry")) } };
    else if (tag === "line") node = { ...base, kind: "shape", shape: { kind: "line", x1: finite(element.getAttribute("x1")), y1: finite(element.getAttribute("y1")), x2: finite(element.getAttribute("x2")), y2: finite(element.getAttribute("y2")) } };
    else if (tag === "polyline" || tag === "polygon") {
      const values = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (values.length < 4 || values.length % 2 || values.some(value => !Number.isFinite(value))) throw new Error(`Invalid SVG ${tag} points`);
      const path: BoardPathCommand[] = [];
      for (let i = 0; i < values.length; i += 2) path.push({ op: i === 0 ? "M" : "L", x: values[i]!, y: values[i + 1]! });
      if (tag === "polygon") path.push({ op: "Z" });
      node = { ...base, kind: "path", path };
    } else if (tag === "text") node = { ...base, kind: "text", text: { value: element.textContent?.slice(0, 20_000) ?? "", x: finite(element.getAttribute("x")), y: finite(element.getAttribute("y")), style: { font: "sans", size: Math.max(1, finite(element.getAttribute("font-size"), 16)), align: element.getAttribute("text-anchor") === "middle" ? "center" : element.getAttribute("text-anchor") === "end" ? "right" : "left" } } };
    else return;
    nodes.push(node);
    if (!parentId) rootIds.push(id);
    for (const child of Array.from(element.children)) walk(child, id, style, useStack);
  };
  const initial: SvgStyle = { fill: { kind: "solid", color: "#000000", opacity: 1 }, opacity: 1, fillRule: "nonzero" };
  for (const [index, clip] of Array.from(root.querySelectorAll("clipPath")).entries()) {
    const sourceId = clip.getAttribute("id");
    if (!sourceId || !ID.test(sourceId)) throw new Error("SVG clip paths require safe IDs");
    const clipId = uniqueId(clip, `clip-${index + 1}`);
    clipIds.set(sourceId, clipId);
    nodes.push({ id: clipId, name: sourceId, kind: "group", semanticRole: "clip-path", transform: parseSvgTransform(clip.getAttribute("transform")), opacity: 1, blendMode: "normal", visible: true, locked: true });
  }
  for (const clip of Array.from(root.querySelectorAll("clipPath"))) {
    const clipId = clipIds.get(clip.getAttribute("id") ?? "");
    if (clipId) for (const child of Array.from(clip.children)) walk(child, clipId, initial);
  }
  for (const child of Array.from(root.children)) walk(child, undefined, initial);
  if (!nodes.length) throw new Error("SVG contains no supported visible nodes");
  if (nodes.length > 5000) throw new Error("SVG exceeds 5,000 nodes");
  const asset = boardVectorAssetSchema.parse({
    format: "board-vector-v1", id: input.id, version: input.version ?? 1, name: input.name ?? input.id,
    width, height, rootIds, nodes, createdAt: new Date().toISOString(),
  });
  return { asset, warnings };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function number(value: number): string { return String(Math.round(value * 10_000) / 10_000); }
function paintValue(paint: BoardVectorPaint | undefined, defs: Map<string, string>, prefix: string, components: ReadonlySet<string>): { value: string; opacity: number } {
  if (!paint || paint.kind === "none") return { value: "none", opacity: 1 };
  if (paint.kind === "solid") return { value: paint.color, opacity: paint.opacity };
  if (paint.kind === "pattern") {
    if (!components.has(paint.componentId)) return { value: "none", opacity: 1 };
    const id = `${prefix}-${paint.id}`;
    defs.set(id, `<pattern id="${id}" width="${number(paint.width)}" height="${number(paint.height)}" patternUnits="userSpaceOnUse"><use href="#${prefix}-component-${xml(paint.componentId)}"/></pattern>`);
    return { value: `url(#${id})`, opacity: 1 };
  }
  const id = `${prefix}-${paint.id}`;
  const stops = paint.stops.map(stop => `<stop offset="${number(stop.offset)}" stop-color="${xml(stop.color)}" stop-opacity="${number(stop.opacity)}"/>`).join("");
  if (paint.kind === "linear-gradient") defs.set(id, `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${number(paint.from.x)}" y1="${number(paint.from.y)}" x2="${number(paint.to.x)}" y2="${number(paint.to.y)}">${stops}</linearGradient>`);
  else defs.set(id, `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${number(paint.center.x)}" cy="${number(paint.center.y)}" r="${number(paint.radius)}"${paint.focal ? ` fx="${number(paint.focal.x)}" fy="${number(paint.focal.y)}"` : ""}>${stops}</radialGradient>`);
  return { value: `url(#${id})`, opacity: 1 };
}

/** Deterministic, sanitized SVG serialization of the internal vector scene. */
export function exportVectorAssetSvg(assetInput: BoardVectorAsset, size: { width?: number; height?: number } = {}): string {
  const asset = boardVectorAssetSchema.parse(assetInput), defs = new Map<string, string>(), nodeMap = new Map(asset.nodes.map(node => [node.id, node]));
  const componentMap = new Map((asset.components ?? []).map(component => [component.id, component]));
  const componentIds = new Set(componentMap.keys());
  const children = new Map<string | undefined, BoardVectorNode[]>();
  for (const node of asset.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const render = (node: BoardVectorNode, stack = new Set<string>()): string => {
    if (stack.has(node.id) || !node.visible) return "";
    const transform = `matrix(${node.transform.map(number).join(" ")})`;
    const fill = paintValue(node.fill, defs, asset.id, componentIds), stroke = paintValue(node.stroke?.paint, defs, asset.id, componentIds);
    const attrs = ` id="${xml(node.id)}" data-name="${xml(node.name)}"${node.semanticRole ? ` data-tutor-role="${xml(node.semanticRole)}"` : ""} data-tutor-blend="${node.blendMode}" transform="${transform}" opacity="${number(node.opacity)}"${node.clipPathId ? ` clip-path="url(#${xml(node.clipPathId)})"` : ""} fill="${xml(fill.value)}" fill-opacity="${number(fill.opacity)}" fill-rule="${node.fillRule ?? "nonzero"}" stroke="${xml(stroke.value)}" stroke-opacity="${number(stroke.opacity)}" stroke-width="${number(node.stroke?.width ?? 0)}" stroke-linecap="${node.stroke?.lineCap ?? "butt"}" stroke-linejoin="${node.stroke?.lineJoin ?? "miter"}"${node.stroke?.dash?.length ? ` stroke-dasharray="${node.stroke.dash.map(number).join(" ")}"` : ""}`;
    const nested = (children.get(node.id) ?? []).map(child => render(child, new Set([...stack, node.id]))).join("");
    if (node.kind === "group") return `<g${attrs}>${nested}</g>`;
    if (node.kind === "path") return `<path${attrs} d="${svgPathData(node.path ?? [])}"/>${nested}`;
    if (node.kind === "shape" && node.shape?.kind === "rect") return `<rect${attrs} x="${number(node.shape.x)}" y="${number(node.shape.y)}" width="${number(node.shape.width)}" height="${number(node.shape.height)}"${node.shape.rx ? ` rx="${number(node.shape.rx)}"` : ""}${node.shape.ry ? ` ry="${number(node.shape.ry)}"` : ""}/>${nested}`;
    if (node.kind === "shape" && node.shape?.kind === "ellipse") return `<ellipse${attrs} cx="${number(node.shape.cx)}" cy="${number(node.shape.cy)}" rx="${number(node.shape.rx)}" ry="${number(node.shape.ry)}"/>${nested}`;
    if (node.kind === "shape" && node.shape?.kind === "line") return `<line${attrs} x1="${number(node.shape.x1)}" y1="${number(node.shape.y1)}" x2="${number(node.shape.x2)}" y2="${number(node.shape.y2)}"/>${nested}`;
    if (node.kind === "text" && node.text) return `<text${attrs} x="${number(node.text.x)}" y="${number(node.text.y)}" font-family="sans-serif" font-size="${number(node.text.style.size)}" text-anchor="${node.text.style.align === "center" ? "middle" : node.text.style.align === "right" ? "end" : "start"}">${xml(node.text.value)}</text>${nested}`;
    if (node.kind === "component-instance" && node.componentId) {
      const component = componentMap.get(node.componentId);
      return component ? `<g${attrs}><use href="#${asset.id}-component-${xml(component.id)}"/>${nested}</g>` : nested;
    }
    return nested;
  };
  for (const component of asset.components ?? []) {
    const root = nodeMap.get(component.rootId);
    if (root) defs.set(`component-${component.id}`, `<g id="${asset.id}-component-${xml(component.id)}">${render(root, new Set([`component:${component.id}`]))}</g>`);
  }
  for (const clip of asset.nodes.filter(node => node.kind === "group" && node.semanticRole === "clip-path")) {
    const content = (children.get(clip.id) ?? []).map(node => render(node)).join("");
    defs.set(`clip-${clip.id}`, `<clipPath id="${xml(clip.id)}">${content}</clipPath>`);
  }
  const body = asset.rootIds.map(id => nodeMap.get(id)).filter((node): node is BoardVectorNode => !!node).map(node => render(node)).join("");
  const definitions = defs.size ? `<defs>${[...defs.values()].join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(size.width ?? asset.width)}" height="${number(size.height ?? asset.height)}" viewBox="0 0 ${number(asset.width)} ${number(asset.height)}">${definitions}${body}</svg>`;
}

function applyPath(context: CanvasRenderingContext2D, commands: readonly BoardPathCommand[]): void {
  let x = 0, y = 0;
  for (const command of commands) {
    if (command.op === "M") context.moveTo(command.x, command.y);
    else if (command.op === "L") context.lineTo(command.x, command.y);
    else if (command.op === "Q") context.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
    else if (command.op === "C") context.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
    else if (command.op === "A") canvasArc(context, x, y, command);
    else context.closePath();
    if (command.op !== "Z") { x = command.x; y = command.y; }
  }
}
function canvasArc(context: CanvasRenderingContext2D, x1: number, y1: number, command: Extract<BoardPathCommand, { op: "A" }>): void {
  const phi = command.rotation * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  let rx = Math.abs(command.rx), ry = Math.abs(command.ry);
  const dx = (x1 - command.x) / 2, dy = (y1 - command.y) / 2;
  const px = cos * dx + sin * dy, py = -sin * dx + cos * dy;
  const scale = Math.sqrt(px * px / (rx * rx) + py * py / (ry * ry));
  if (scale > 1) { rx *= scale; ry *= scale; }
  const sign = command.largeArc === command.sweep ? -1 : 1;
  const factor = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px) / (rx * rx * py * py + ry * ry * px * px || 1)));
  const cxp = factor * rx * py / ry, cyp = factor * -ry * px / rx;
  const cx = cos * cxp - sin * cyp + (x1 + command.x) / 2, cy = sin * cxp + cos * cyp + (y1 + command.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (px - cxp) / rx, uy = (py - cyp) / ry, vx = (-px - cxp) / rx, vy = (-py - cyp) / ry;
  const start = angle(1, 0, ux, uy), delta = angle(ux, uy, vx, vy);
  let end = start + delta;
  if (!command.sweep && delta > 0) end -= Math.PI * 2;
  if (command.sweep && delta < 0) end += Math.PI * 2;
  context.ellipse(cx, cy, rx, ry, phi, start, end, !command.sweep);
}
function canvasPaint(context: CanvasRenderingContext2D, paint: BoardVectorPaint | undefined): string | CanvasGradient | undefined {
  if (!paint || paint.kind === "none" || paint.kind === "pattern") return undefined;
  if (paint.kind === "solid") return paint.color;
  const gradient = paint.kind === "linear-gradient"
    ? context.createLinearGradient(paint.from.x, paint.from.y, paint.to.x, paint.to.y)
    : context.createRadialGradient(paint.focal?.x ?? paint.center.x, paint.focal?.y ?? paint.center.y, 0, paint.center.x, paint.center.y, paint.radius);
  for (const stop of paint.stops) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
}

export function renderVectorAssetCanvas(context: CanvasRenderingContext2D, assetInput: BoardVectorAsset, width = assetInput.width, height = assetInput.height): void {
  const asset = boardVectorAssetSchema.parse(assetInput), children = new Map<string | undefined, BoardVectorNode[]>();
  for (const node of asset.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const nodeMap = new Map(asset.nodes.map(node => [node.id, node]));
  const componentMap = new Map((asset.components ?? []).map(component => [component.id, component]));
  const appendGeometry = (node: BoardVectorNode): void => {
    if (node.kind === "path") applyPath(context, node.path ?? []);
    else if (node.kind === "shape" && node.shape?.kind === "rect") context.rect(node.shape.x, node.shape.y, node.shape.width, node.shape.height);
    else if (node.kind === "shape" && node.shape?.kind === "ellipse") context.ellipse(node.shape.cx, node.shape.cy, node.shape.rx, node.shape.ry, 0, 0, Math.PI * 2);
    else if (node.kind === "shape" && node.shape?.kind === "line") { context.moveTo(node.shape.x1, node.shape.y1); context.lineTo(node.shape.x2, node.shape.y2); }
  };
  const appendClip = (node: BoardVectorNode): void => {
    context.save(); context.transform(...node.transform); appendGeometry(node);
    for (const child of children.get(node.id) ?? []) appendClip(child);
    context.restore();
  };
  const draw = (node: BoardVectorNode, componentStack = new Set<string>()): void => {
    if (!node.visible) return;
    context.save();
    context.transform(...node.transform);
    context.globalAlpha *= node.opacity;
    context.globalCompositeOperation = node.blendMode === "normal" ? "source-over" : node.blendMode;
    if (node.clipPathId) {
      const clip = nodeMap.get(node.clipPathId);
      if (clip) { context.beginPath(); appendClip(clip); context.clip(node.fillRule ?? "nonzero"); }
    }
    context.beginPath();
    appendGeometry(node);
    const fill = canvasPaint(context, node.fill);
    if (fill) { context.fillStyle = fill; context.fill(node.fillRule ?? "nonzero"); }
    const stroke = canvasPaint(context, node.stroke?.paint);
    if (stroke && node.stroke) {
      context.strokeStyle = stroke; context.lineWidth = node.stroke.width; context.lineCap = node.stroke.lineCap; context.lineJoin = node.stroke.lineJoin;
      context.setLineDash(node.stroke.dash ?? []); context.lineDashOffset = node.stroke.dashOffset ?? 0; context.stroke();
    }
    if (node.kind === "text" && node.text) {
      context.font = `${node.text.style.size}px sans-serif`; context.textAlign = node.text.style.align; context.textBaseline = "alphabetic";
      context.fillStyle = fill ?? "#000000"; context.fillText(node.text.value, node.text.x, node.text.y);
    }
    if (node.kind === "component-instance" && node.componentId && !componentStack.has(node.componentId)) {
      const root = nodeMap.get(componentMap.get(node.componentId)?.rootId ?? "");
      if (root) draw(root, new Set([...componentStack, node.componentId]));
    }
    for (const child of children.get(node.id) ?? []) draw(child, componentStack);
    context.restore();
  };
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.scale(width / asset.width, height / asset.height);
  for (const root of children.get(undefined) ?? []) draw(root);
  context.restore();
}
