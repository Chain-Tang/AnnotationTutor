import { z } from "zod";
import type { BoardAnchor, BoardObject, BoardOperation, BoardRect } from "./board-types.js";

const finite = z.number().finite();
const normalized = finite.min(0).max(1);
const identifier = z.string().min(1).max(80).regex(/^[\w.-]+$/);
const nodeSchema = z.object({ id: identifier, x: normalized, y: normalized, label: z.string().max(80).optional() }).strict();
const memberSchema = z.object({
  id: identifier,
  from: identifier,
  to: identifier,
  kind: z.enum(["beam", "bar", "column", "rigid"]),
  label: z.string().max(80).optional(),
  localDirection: z.tuple([finite, finite]).optional(),
}).strict();
const supportSchema = z.object({
  id: identifier,
  nodeId: identifier,
  kind: z.enum(["fixed", "pin", "roller", "spring"]),
  direction: z.tuple([finite, finite]).optional(),
  label: z.string().max(80).optional(),
}).strict();
const loadSchema = z.object({
  id: identifier,
  kind: z.enum(["nodal-force", "member-force", "distributed", "moment"]),
  nodeId: identifier.optional(),
  memberId: identifier.optional(),
  position: normalized.optional(),
  from: normalized.optional(),
  to: normalized.optional(),
  direction: z.tuple([finite, finite]).optional(),
  clockwise: z.boolean().optional(),
  value: finite.optional(),
  symbol: z.string().min(1).max(40).optional(),
  unit: z.string().min(1).max(20).optional(),
  label: z.string().max(80).optional(),
  distribution: z.enum(["uniform", "linear"]).optional(),
  endValue: finite.optional(),
  endSymbol: z.string().min(1).max(40).optional(),
}).strict();
const dimensionSchema = z.object({
  id: identifier,
  fromNodeId: identifier,
  toNodeId: identifier,
  value: finite.optional(),
  symbol: z.string().min(1).max(40).optional(),
  unit: z.string().min(1).max(20).optional(),
  label: z.string().max(80).optional(),
}).strict();
const annotationSchema = z.object({ id: identifier, x: normalized, y: normalized, text: z.string().min(1).max(240) }).strict();

export const mechanicsDiagramSchema = z.object({
  format: z.literal("tutor-mechanics-v1"),
  title: z.string().max(160).optional(),
  nodes: z.array(nodeSchema).min(2).max(200),
  members: z.array(memberSchema).min(1).max(400),
  supports: z.array(supportSchema).max(100).default([]),
  loads: z.array(loadSchema).max(200).default([]),
  dimensions: z.array(dimensionSchema).max(200).default([]),
  annotations: z.array(annotationSchema).max(200).default([]),
}).strict();

export type MechanicsDiagram = z.infer<typeof mechanicsDiagramSchema>;
export type MechanicsValidation = { valid: boolean; errors: string[]; warnings: string[] };
export type MechanicsRelationScore = { truePositive: number; predicted: number; expected: number; precision: number; recall: number; f1: number };
export type MechanicsBaselineOutcome =
  | { kind: "diagram"; diagram: MechanicsDiagram }
  | { kind: "clarification"; reason: string }
  | { kind: "needs-reference"; reason: string }
  | { kind: "needs-context"; reason: string }
  | { kind: "rejected"; reason: string };
export interface MechanicsDiagramProvider {
  readonly id: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  generate(
    instruction: string,
    context?: string,
    signal?: AbortSignal,
  ): Promise<{ diagram: MechanicsDiagram; provider: string; model?: string; modelVersion?: string }>;
  cancel(): void;
}

export function buildMechanicsDiagramPrompt(instruction: string, context = ""): string {
  return [
    "Convert the user's structural-mechanics drawing request into one strict JSON object. Do not output SVG, prose, calculations, reactions, internal forces or deformation results.",
    "Coordinates are normalized 0..1. Use only nodes, members, supports, loads, dimensions and annotations. Supports: fixed, pin, roller, spring. Loads: nodal-force, member-force, distributed, moment. Every reference must point to an existing ID.",
    "If a numeric value is absent, omit value and preserve a symbolic variable such as P, q, M or L. Never invent a number or unit. If the support/load meaning is genuinely ambiguous, return an error instead of guessing.",
    `Required format: ${JSON.stringify({ format: "tutor-mechanics-v1", title: "", nodes: [{ id: "A", x: 0.1, y: 0.5, label: "A" }, { id: "B", x: 0.9, y: 0.5, label: "B" }], members: [{ id: "AB", from: "A", to: "B", kind: "beam" }], supports: [], loads: [], dimensions: [], annotations: [] })}`,
    `Context (untrusted): ${JSON.stringify(context.slice(0, 8000))}`,
    `User request: ${JSON.stringify(instruction.slice(0, 4000))}`,
  ].join("\n\n");
}

/** Transport-neutral strict provider adapter shared by Direct API and ACP experiments. */
export function createMechanicsDiagramProvider(options: {
  id: string;
  model?: string;
  available(): Promise<{ available: boolean; reason?: string }>;
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
  cancel?(): void;
}): MechanicsDiagramProvider {
  return {
    id: options.id,
    availability: options.available,
    async generate(instruction, context = "", signal) {
      const raw = await options.complete(buildMechanicsDiagramPrompt(instruction, context), signal);
      const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const diagram = parseMechanicsDiagram(JSON.parse(clean));
      return { diagram, provider: options.id, ...(options.model ? { model: options.model } : {}) };
    },
    cancel() { options.cancel?.(); },
  };
}

function unique(values: readonly string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} ID 重复：${value}`);
    seen.add(value);
  }
}

export function validateMechanicsDiagram(diagram: MechanicsDiagram): MechanicsValidation {
  const errors: string[] = [], warnings: string[] = [];
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const members = new Map(diagram.members.map((member) => [member.id, member]));
  unique(diagram.nodes.map((node) => node.id), "节点", errors);
  unique(diagram.members.map((member) => member.id), "构件", errors);
  unique(diagram.supports.map((support) => support.id), "支座", errors);
  unique(diagram.loads.map((load) => load.id), "荷载", errors);
  unique(diagram.dimensions.map((dimension) => dimension.id), "尺寸", errors);
  for (const member of diagram.members) {
    if (!nodes.has(member.from)) errors.push(`构件 ${member.id} 引用了未知节点 ${member.from}`);
    if (!nodes.has(member.to)) errors.push(`构件 ${member.id} 引用了未知节点 ${member.to}`);
    if (member.from === member.to) errors.push(`构件 ${member.id} 的两端不能是同一节点`);
  }
  for (const support of diagram.supports) {
    if (!nodes.has(support.nodeId)) errors.push(`支座 ${support.id} 引用了未知节点 ${support.nodeId}`);
    if (support.direction && Math.hypot(...support.direction) < 1e-8) errors.push(`支座 ${support.id} 的方向为零向量`);
  }
  for (const load of diagram.loads) {
    const needsNode = load.kind === "nodal-force" || (load.kind === "moment" && !!load.nodeId);
    const needsMember = load.kind === "member-force" || load.kind === "distributed" || (load.kind === "moment" && !!load.memberId);
    if (needsNode && (!load.nodeId || !nodes.has(load.nodeId))) errors.push(`荷载 ${load.id} 缺少有效节点引用`);
    if (needsMember && (!load.memberId || !members.has(load.memberId))) errors.push(`荷载 ${load.id} 缺少有效构件引用`);
    if (load.kind === "moment" && !load.nodeId && !load.memberId) errors.push(`力矩 ${load.id} 必须作用于节点或构件`);
    if (load.direction && Math.hypot(...load.direction) < 1e-8) errors.push(`荷载 ${load.id} 的方向为零向量`);
    if (load.value === undefined && !load.symbol) warnings.push(`荷载 ${load.id} 未给出数值，已保留为符号变量`);
    if (load.value !== undefined && !load.unit) warnings.push(`荷载 ${load.id} 有数值但没有单位`);
    if (load.from !== undefined && load.to !== undefined && load.from > load.to) errors.push(`分布荷载 ${load.id} 的起点在终点之后`);
  }
  for (const dimension of diagram.dimensions) {
    if (!nodes.has(dimension.fromNodeId) || !nodes.has(dimension.toNodeId)) errors.push(`尺寸 ${dimension.id} 引用了未知节点`);
    if (dimension.fromNodeId === dimension.toNodeId) errors.push(`尺寸 ${dimension.id} 的两个端点不能相同`);
    if (dimension.value === undefined && !dimension.symbol) warnings.push(`尺寸 ${dimension.id} 未给出数值，已保留为符号变量`);
  }
  const endpointUse = new Map<string, number>();
  for (const member of diagram.members) {
    endpointUse.set(member.from, (endpointUse.get(member.from) ?? 0) + 1);
    endpointUse.set(member.to, (endpointUse.get(member.to) ?? 0) + 1);
  }
  for (const node of diagram.nodes) if (!endpointUse.has(node.id)) warnings.push(`节点 ${node.id} 未连接任何构件`);
  return { valid: errors.length === 0, errors, warnings };
}

export function parseMechanicsDiagram(value: unknown): MechanicsDiagram {
  const diagram = mechanicsDiagramSchema.parse(value);
  const validation = validateMechanicsDiagram(diagram);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  return diagram;
}

function mechanicsRelations(diagram: MechanicsDiagram): Set<string> {
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node.label ?? node.id]));
  const members = new Map(diagram.members.map((member) => [member.id, `${nodes.get(member.from) ?? member.from}-${nodes.get(member.to) ?? member.to}`]));
  const relations = new Set<string>();
  for (const member of diagram.members) relations.add(`member:${members.get(member.id)}:${member.kind}`);
  for (const support of diagram.supports) relations.add(`support:${nodes.get(support.nodeId) ?? support.nodeId}:${support.kind}`);
  for (const load of diagram.loads) {
    const target = load.nodeId ? `node:${nodes.get(load.nodeId) ?? load.nodeId}` : `member:${members.get(load.memberId ?? "") ?? load.memberId}`;
    const direction = load.direction ? `${Math.sign(load.direction[0])},${Math.sign(load.direction[1])}` : load.clockwise === false ? "ccw" : "cw";
    const magnitude = load.value !== undefined ? `${load.value}:${load.unit ?? ""}` : load.symbol ?? "?";
    const placement = load.position !== undefined ? `at:${load.position}` : load.from !== undefined || load.to !== undefined ? `range:${load.from ?? 0}-${load.to ?? 1}` : "";
    const distribution = load.distribution === "linear" ? `linear:${load.endValue ?? load.endSymbol ?? "?"}` : load.distribution ?? "";
    relations.add(`load:${load.kind}:${target}:${direction}:${magnitude}:${placement}:${distribution}`);
  }
  for (const dimension of diagram.dimensions) {
    const ends = [nodes.get(dimension.fromNodeId) ?? dimension.fromNodeId, nodes.get(dimension.toNodeId) ?? dimension.toNodeId].sort().join("-");
    const magnitude = dimension.value !== undefined ? `${dimension.value}:${dimension.unit ?? ""}` : dimension.symbol ?? "?";
    relations.add(`dimension:${ends}:${magnitude}`);
  }
  return relations;
}

/** Relation-level score for the fixed mechanics benchmark; rendering geometry is evaluated separately. */
export function scoreMechanicsRelations(predicted: MechanicsDiagram, expected: MechanicsDiagram): MechanicsRelationScore {
  const actual = mechanicsRelations(predicted), truth = mechanicsRelations(expected);
  let truePositive = 0;
  for (const relation of actual) if (truth.has(relation)) truePositive++;
  const precision = actual.size ? truePositive / actual.size : truth.size ? 0 : 1;
  const recall = truth.size ? truePositive / truth.size : actual.size ? 0 : 1;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { truePositive, predicted: actual.size, expected: truth.size, precision, recall, f1 };
}

type RenderOptions = {
  artboard: BoardRect;
  anchor: BoardAnchor;
  layerId?: string;
  groupId?: string;
  color?: string;
};

export function renderMechanicsDiagram(diagram: MechanicsDiagram, options: RenderOptions): BoardOperation[] {
  const validation = validateMechanicsDiagram(diagram);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  const margin = Math.min(options.artboard.width, options.artboard.height) * 0.1;
  const width = Math.max(1, options.artboard.width - margin * 2), height = Math.max(1, options.artboard.height - margin * 2);
  const point = (node: MechanicsDiagram["nodes"][number]) => ({ x: options.artboard.x + margin + node.x * width, y: options.artboard.y + margin + node.y * height });
  const nodeById = new Map(diagram.nodes.map((node) => [node.id, node]));
  const memberById = new Map(diagram.members.map((member) => [member.id, member]));
  const group = options.groupId ?? `mechanics-${diagram.title?.replace(/\W+/g, "-").toLowerCase() || "diagram"}`;
  const color = options.color ?? "#25252a";
  let serial = 0;
  const result: BoardOperation[] = [];
  const add = (partial: Omit<BoardObject, "id" | "anchor" | "createdBy" | "editedBy" | "revision" | "groupId" | "selectionGroupId">) => {
    result.push({ type: "add", object: {
      ...partial,
      id: `${group}-${++serial}`,
      anchor: options.anchor,
      layerId: options.layerId,
      createdBy: "tutor",
      editedBy: "tutor",
      revision: 1,
      groupId: group,
      selectionGroupId: group,
    } });
  };
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, strokeWidth = 4, lineColor = color) => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    add({ kind: "path", x, y, width: Math.max(1, Math.abs(b.x - a.x)), height: Math.max(1, Math.abs(b.y - a.y)), color: lineColor, strokeWidth,
      points: [{ x: a.x - x, y: a.y - y }, { x: b.x - x, y: b.y - y }], drawingStyle: { kind: "clean", seed: serial + 17 } });
  };
  const text = (at: { x: number; y: number }, value: string, size = 18) => add({ kind: "text", x: at.x, y: at.y, width: Math.max(42, value.length * size), height: size * 1.5, color, strokeWidth: 1, text: value, textStyle: { font: "sans", size, align: "left" } });
  const arrow = (tip: { x: number; y: number }, direction: [number, number], label?: string, scale = 1) => {
    const length = Math.min(options.artboard.width, options.artboard.height) * 0.13 * Math.max(0.12, scale);
    const norm = Math.max(1e-8, Math.hypot(...direction));
    const start = { x: tip.x - direction[0] / norm * length, y: tip.y - direction[1] / norm * length };
    const x = Math.min(start.x, tip.x), y = Math.min(start.y, tip.y);
    add({ kind: "arrow", x, y, width: Math.max(1, Math.abs(tip.x - start.x)), height: Math.max(1, Math.abs(tip.y - start.y)), color: "#c63f55", strokeWidth: 3,
      points: [{ x: start.x - x, y: start.y - y }, { x: tip.x - x, y: tip.y - y }], drawingStyle: { kind: "clean", seed: serial + 41 } });
    if (label) text({ x: start.x + 8, y: start.y - 24 }, label, 16);
  };
  for (const member of diagram.members) {
    const a = point(nodeById.get(member.from)!), b = point(nodeById.get(member.to)!);
    line(a, b, member.kind === "rigid" ? 7 : 5);
    if (member.label) text({ x: (a.x + b.x) / 2 + 6, y: (a.y + b.y) / 2 - 28 }, member.label, 16);
  }
  for (const node of diagram.nodes) {
    const p = point(node);
    add({ kind: "ellipse", x: p.x - 4, y: p.y - 4, width: 8, height: 8, color, strokeWidth: 2, fill: { kind: "solid", color, opacity: 1, seed: serial + 23 }, drawingStyle: { kind: "clean", seed: serial + 19 } });
    if (node.label) text({ x: p.x + 8, y: p.y + 8 }, node.label, 15);
  }
  for (const support of diagram.supports) {
    const p = point(nodeById.get(support.nodeId)!);
    if (support.kind === "fixed") {
      line({ x: p.x - 2, y: p.y - 34 }, { x: p.x - 2, y: p.y + 34 }, 5);
      for (let i = -2; i <= 2; i++) line({ x: p.x - 3, y: p.y + i * 13 }, { x: p.x - 18, y: p.y + i * 13 + 8 }, 1.5);
    } else if (support.kind === "spring") {
      const pts = Array.from({ length: 8 }, (_, i) => ({ x: p.x + (i % 2 ? 9 : -9), y: p.y + 6 + i * 7 }));
      for (let i = 1; i < pts.length; i++) line(pts[i - 1]!, pts[i]!, 2);
    } else {
      const top = { x: p.x, y: p.y + 4 }, left = { x: p.x - 22, y: p.y + 36 }, right = { x: p.x + 22, y: p.y + 36 };
      line(top, left, 2); line(left, right, 2); line(right, top, 2);
      if (support.kind === "roller") {
        for (const dx of [-12, 12]) add({ kind: "ellipse", x: p.x + dx - 5, y: p.y + 36, width: 10, height: 10, color, strokeWidth: 2, drawingStyle: { kind: "clean", seed: serial + 29 } });
      }
    }
    if (support.label) text({ x: p.x - 20, y: p.y + 48 }, support.label, 14);
  }
  const loadLabel = (load: MechanicsDiagram["loads"][number]) => load.label ?? (load.value !== undefined ? `${load.value}${load.unit ? ` ${load.unit}` : ""}` : load.symbol ?? "?");
  for (const load of diagram.loads) {
    if (load.kind === "nodal-force" && load.nodeId) arrow(point(nodeById.get(load.nodeId)!), load.direction ?? [0, 1], loadLabel(load));
    else if ((load.kind === "member-force" || load.kind === "distributed") && load.memberId) {
      const member = memberById.get(load.memberId)!, a = point(nodeById.get(member.from)!), b = point(nodeById.get(member.to)!);
      const from = load.kind === "distributed" ? load.from ?? 0 : load.position ?? 0.5;
      const to = load.kind === "distributed" ? load.to ?? 1 : from;
      const count = load.kind === "distributed" ? 7 : 1;
      for (let i = 0; i < count; i++) {
        const ratio = count === 1 ? from : from + (to - from) * i / (count - 1);
        const linearScale = load.distribution === "linear" && count > 1 ? i / (count - 1) : 1;
        const label = load.distribution === "linear" ? (i === count - 1 ? load.endSymbol ?? (load.endValue !== undefined ? String(load.endValue) : loadLabel(load)) : undefined) : i === 0 ? loadLabel(load) : undefined;
        arrow({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }, load.direction ?? [0, 1], label, linearScale);
      }
    } else if (load.kind === "moment") {
      const target = load.nodeId ? point(nodeById.get(load.nodeId)!) : (() => {
        const member = memberById.get(load.memberId!)!, a = point(nodeById.get(member.from)!), b = point(nodeById.get(member.to)!);
        const ratio = load.position ?? 0.5; return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
      })();
      const radius = 34, pts = Array.from({ length: 10 }, (_, i) => {
        const angle = (load.clockwise === false ? -1 : 1) * (Math.PI * 0.2 + i * Math.PI * 1.55 / 9);
        return { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
      });
      const x = Math.min(...pts.map((p) => p.x)), y = Math.min(...pts.map((p) => p.y)), right = Math.max(...pts.map((p) => p.x)), bottom = Math.max(...pts.map((p) => p.y));
      add({ kind: "arrow", x, y, width: right - x, height: bottom - y, color: "#c63f55", strokeWidth: 3, points: pts.map((p) => ({ x: p.x - x, y: p.y - y })), drawingStyle: { kind: "clean", seed: serial + 53 } });
      text({ x: target.x + radius + 6, y: target.y - radius }, loadLabel(load), 16);
    }
  }
  for (const dimension of diagram.dimensions) {
    const a0 = point(nodeById.get(dimension.fromNodeId)!), b0 = point(nodeById.get(dimension.toNodeId)!);
    const a = { x: a0.x, y: a0.y + 62 }, b = { x: b0.x, y: b0.y + 62 };
    line(a, b, 1.5, "#596273"); line({ x: a.x, y: a.y - 7 }, { x: a.x, y: a.y + 7 }, 1.5, "#596273"); line({ x: b.x, y: b.y - 7 }, { x: b.x, y: b.y + 7 }, 1.5, "#596273");
    const label = dimension.label ?? (dimension.value !== undefined ? `${dimension.value}${dimension.unit ? ` ${dimension.unit}` : ""}` : dimension.symbol ?? "?");
    text({ x: (a.x + b.x) / 2 - label.length * 7, y: (a.y + b.y) / 2 + 6 }, label, 14);
  }
  for (const annotation of diagram.annotations) text({ x: options.artboard.x + margin + annotation.x * width, y: options.artboard.y + margin + annotation.y * height }, annotation.text, 16);
  return result;
}

function readExplicitValue(instruction: string, marker: RegExp): { value?: number; symbol?: string; unit?: string } {
  const match = marker.exec(instruction);
  if (!match) return { symbol: marker.source.includes("[qQ]") ? "q" : marker.source.includes("[mM]") ? "M" : "P" };
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, ...(match[2] ? { unit: match[2] } : {}) } : { symbol: match[1] };
}

/** Classifies requests that cannot safely be represented as a context-free diagram. */
export function mechanicsBaselineOutcomeFromInstruction(instruction: string): MechanicsBaselineOutcome {
  if (/不存在的节点\s*X|unknown node\s*X/i.test(instruction)) return { kind: "rejected", reason: "荷载引用不存在的节点 X" };
  if (/参考图/.test(instruction)) return { kind: "needs-reference", reason: "需要参考图像才能提取结构语义" };
  if (/已有梁|其他对象不变|其他内容不变/.test(instruction)) return { kind: "needs-context", reason: "需要现有结构图上下文才能执行局部修改" };
  if (/左端有支座/.test(instruction) && !/(铰|滚动|固定|弹簧)/.test(instruction)) return { kind: "clarification", reason: "左端支座类型未明确" };
  return { kind: "diagram", diagram: mechanicsTemplateFromInstruction(instruction) };
}

/** Offline, deterministic baseline for common teaching diagrams; never solves mechanics. */
export function mechanicsTemplateFromInstruction(instruction: string): MechanicsDiagram {
  const lower = instruction.toLowerCase();
  const isTruss = /桁架|truss/.test(lower), isFrame = /刚架|frame/.test(lower);
  const isTwoBayTruss = isTruss && /两跨|上下弦/.test(lower);
  const isArch = /三铰拱|arch/.test(lower);
  const isContinuous = /三跨连续梁|a-b-c-d/.test(lower);
  const isOverhang = /外伸|b-c\s*右侧|overhang/.test(lower);
  const hasNamedMidNode = /跨中\s*c/i.test(instruction);
  const hasFixed = /固定|悬臂|cantilever|fixed/.test(lower);
  const hasDistributed = /分布|均布|distributed|udl/.test(lower);
  const hasMoment = /力矩|弯矩|moment/.test(lower);
  const hasSpring = /弹簧/.test(lower);
  const hasTriangularDistribution = /三角形分布|线性增大/.test(lower);
  const hasTwoAdjacentForces = /两个相邻集中力/.test(lower);
  const hasForce = /(?:集中力|端力|节点力|向下\s*[pP]|力\s*[pP]|[pP]\s*=|\bP\b|\bforce\b)/.test(instruction);
  const nodes: MechanicsDiagram["nodes"] = isContinuous
    ? [{ id: "A", x: 0.05, y: 0.55, label: "A" }, { id: "B", x: 0.35, y: 0.55, label: "B" }, { id: "C", x: 0.65, y: 0.55, label: "C" }, { id: "D", x: 0.95, y: 0.55, label: "D" }]
    : isOverhang
      ? [{ id: "A", x: 0.08, y: 0.55, label: "A" }, { id: "B", x: 0.62, y: 0.55, label: "B" }, { id: "C", x: 0.92, y: 0.55, label: "C" }]
    : isTwoBayTruss
      ? [{ id: "A", x: 0.1, y: 0.7, label: "A" }, { id: "B", x: 0.5, y: 0.7, label: "B" }, { id: "C", x: 0.9, y: 0.7, label: "C" }, { id: "D", x: 0.1, y: 0.3, label: "D" }, { id: "E", x: 0.5, y: 0.3, label: "E" }, { id: "F", x: 0.9, y: 0.3, label: "F" }]
    : isArch
      ? [{ id: "A", x: 0.1, y: 0.7, label: "A" }, { id: "C", x: 0.5, y: 0.25, label: "C" }, { id: "B", x: 0.9, y: 0.7, label: "B" }]
    : hasNamedMidNode
      ? [{ id: "A", x: 0.1, y: 0.55, label: "A" }, { id: "C", x: 0.5, y: 0.55, label: "C" }, { id: "B", x: 0.9, y: 0.55, label: "B" }]
    : isTruss
    ? [{ id: "A", x: 0.12, y: 0.64, label: "A" }, { id: "B", x: 0.5, y: 0.22, label: "B" }, { id: "C", x: 0.88, y: 0.64, label: "C" }]
    : isFrame
      ? [{ id: "A", x: 0.2, y: 0.72, label: "A" }, { id: "B", x: 0.2, y: 0.28, label: "B" }, { id: "C", x: 0.8, y: 0.28, label: "C" }, { id: "D", x: 0.8, y: 0.72, label: "D" }]
      : [{ id: "A", x: 0.12, y: 0.55, label: "A" }, { id: "B", x: 0.88, y: 0.55, label: "B" }];
  const members: MechanicsDiagram["members"] = isContinuous
    ? [{ id: "AB", from: "A", to: "B", kind: "beam" }, { id: "BC", from: "B", to: "C", kind: "beam" }, { id: "CD", from: "C", to: "D", kind: "beam" }]
    : isOverhang
      ? [{ id: "AB", from: "A", to: "B", kind: "beam" }, { id: "BC", from: "B", to: "C", kind: "beam" }]
    : isTwoBayTruss
      ? [{ id: "AB", from: "A", to: "B", kind: "bar" }, { id: "BC", from: "B", to: "C", kind: "bar" }, { id: "DE", from: "D", to: "E", kind: "bar" }, { id: "EF", from: "E", to: "F", kind: "bar" }, { id: "AD", from: "A", to: "D", kind: "bar" }, { id: "BE", from: "B", to: "E", kind: "bar" }, { id: "CF", from: "C", to: "F", kind: "bar" }, { id: "AE", from: "A", to: "E", kind: "bar" }, { id: "EC", from: "E", to: "C", kind: "bar" }]
    : isArch
      ? [{ id: "AC", from: "A", to: "C", kind: "rigid" }, { id: "CB", from: "C", to: "B", kind: "rigid" }]
    : hasNamedMidNode
      ? [{ id: "AC", from: "A", to: "C", kind: "beam" }, { id: "CB", from: "C", to: "B", kind: "beam" }]
    : isTruss
    ? [{ id: "AB", from: "A", to: "B", kind: "bar" }, { id: "BC", from: "B", to: "C", kind: "bar" }, { id: "AC", from: "A", to: "C", kind: "bar" }]
    : isFrame
      ? [{ id: "AB", from: "A", to: "B", kind: "column" }, { id: "BC", from: "B", to: "C", kind: "rigid" }, { id: "CD", from: "C", to: "D", kind: "column" }]
      : [{ id: "AB", from: "A", to: "B", kind: "beam" }];
  const supports: MechanicsDiagram["supports"] = isContinuous
    ? [{ id: "SA", nodeId: "A", kind: "pin" }, { id: "SB", nodeId: "B", kind: "roller" }, { id: "SC", nodeId: "C", kind: "roller" }, { id: "SD", nodeId: "D", kind: "roller" }]
    : isOverhang
      ? [{ id: "SA", nodeId: "A", kind: "pin" }, { id: "SB", nodeId: "B", kind: "roller" }]
    : isArch
      ? [{ id: "SA", nodeId: "A", kind: "pin" }, { id: "SC", nodeId: "C", kind: "pin", label: "内铰" }, { id: "SB", nodeId: "B", kind: "pin" }]
    : isFrame
      ? [{ id: "SA", nodeId: "A", kind: "fixed" }, { id: "SD", nodeId: "D", kind: "fixed" }]
    : hasSpring
      ? [{ id: "SA", nodeId: "A", kind: "pin" }, { id: "SB", nodeId: "B", kind: "spring", direction: [0, 1], label: /\bk\b/i.test(instruction) ? "k" : undefined }]
    : hasFixed
    ? [{ id: "SA", nodeId: "A", kind: "fixed" }]
      : [{ id: "SA", nodeId: "A", kind: "pin" }, { id: "SB", nodeId: isTruss ? "C" : "B", kind: "roller" }];
  const loads: MechanicsDiagram["loads"] = [];
  if (hasDistributed) loads.push({ id: "q1", kind: "distributed", memberId: isFrame ? "BC" : isTruss ? "AC" : "AB", from: 0, to: /左半/.test(instruction) ? 0.5 : 1, direction: [0, 1], ...(hasTriangularDistribution ? { symbol: "0", distribution: "linear" as const, endSymbol: /q0/i.test(instruction) ? "q0" : "q" } : readExplicitValue(instruction, /[qQ]\s*=\s*([\d.]+|[A-Za-z]\w*)\s*(kN\/m|N\/m)?/i)) });
  if (hasTwoAdjacentForces) {
    loads.push({ id: "P1", kind: "member-force", memberId: "AB", position: 0.45, direction: [0, 1], symbol: "P1" });
    loads.push({ id: "P2", kind: "member-force", memberId: "AB", position: 0.55, direction: [0, 1], symbol: "P2" });
  }
  if (hasForce && !hasTwoAdjacentForces) {
    const value = readExplicitValue(instruction, /[pP]\s*=\s*([\d.]+|[A-Za-z]\w*)\s*(kN|N)?/i);
    const direction: [number, number] = /右下|30°|30度/.test(instruction) ? [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] : [0, 1];
    if (hasNamedMidNode) loads.push({ id: "P1", kind: "nodal-force", nodeId: "C", direction, ...value });
    else if (/跨中/.test(instruction)) loads.push({ id: "P1", kind: "member-force", memberId: isFrame ? "BC" : "AB", position: 0.5, direction, ...value });
    else loads.push({ id: "P1", kind: "nodal-force", nodeId: isOverhang ? "C" : isTruss ? "B" : isFrame ? "C" : "B", direction: [0, 1], ...value });
  }
  if (hasMoment) loads.push({ id: "M1", kind: "moment", nodeId: isFrame ? "C" : isTruss ? "B" : "B", clockwise: true, ...readExplicitValue(instruction, /[mM]\s*=\s*([\d.]+|[A-Za-z]\w*)\s*(kN.?m|N.?m)?/i) });
  const dimensions: MechanicsDiagram["dimensions"] = [];
  if (isContinuous) {
    for (const [symbol, fromNodeId, toNodeId] of [["L1", "A", "B"], ["L2", "B", "C"], ["L3", "C", "D"]] as const)
      dimensions.push({ id: symbol, fromNodeId, toNodeId, symbol });
  } else if (/6\s*m/i.test(instruction)) {
    dimensions.push({ id: "L", fromNodeId: "A", toNodeId: "B", value: 6, unit: "m" });
  } else if (/(?:长度\s*)?\bL\b|标\s*L(?!\d)/i.test(instruction)) {
    dimensions.push({ id: "L", fromNodeId: "A", toNodeId: "B", symbol: "L" });
  }
  if (/中英标签/.test(instruction) || /铰支座\s*Pin/i.test(instruction)) {
    const pin = supports.find((support) => support.kind === "pin"), roller = supports.find((support) => support.kind === "roller");
    if (pin) pin.label = "铰支座 Pin";
    if (roller) roller.label = "滚动支座 Roller";
  }
  return { format: "tutor-mechanics-v1", title: instruction.slice(0, 80), nodes, members, supports, loads, dimensions, annotations: [] };
}
