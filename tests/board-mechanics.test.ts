import { describe, expect, it } from "vitest";
import { buildMechanicsDiagramPrompt, createMechanicsDiagramProvider, mechanicsBaselineOutcomeFromInstruction, mechanicsTemplateFromInstruction, parseMechanicsDiagram, renderMechanicsDiagram, scoreMechanicsRelations, validateMechanicsDiagram } from "../src/board-mechanics.js";

describe("mechanics semantic diagrams", () => {
  it("keeps missing values symbolic and renders deterministic editable vectors", () => {
    const diagram = mechanicsTemplateFromInstruction("画 AB 简支梁，全跨向下均布荷载 q，长度 L");
    expect(diagram.loads[0]).toMatchObject({ kind: "distributed", symbol: "q" });
    expect(diagram.loads[0]?.value).toBeUndefined();
    const options = { artboard: { x: 0, y: 0, width: 800, height: 500 }, anchor: { kind: "canvas", pageId: "main" } as const, layerId: "mechanics", groupId: "fixed" };
    const first = renderMechanicsDiagram(diagram, options), second = renderMechanicsDiagram(diagram, options);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(10);
    expect(first.every((operation) => operation.type === "add" && operation.object.createdBy === "tutor")).toBe(true);
  });

  it("preserves explicit values and units without solving reactions", () => {
    const diagram = mechanicsTemplateFromInstruction("画 6 m 简支梁，跨中 P=20 kN，并作用顺时针力矩 M=8 kN·m");
    expect(diagram.loads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "member-force", position: 0.5, value: 20, unit: "kN" }),
      expect.objectContaining({ kind: "moment", value: 8 }),
    ]));
    expect(Object.keys(diagram)).not.toContain("reactions");
  });

  it("rejects unknown references and zero directions before rendering", () => {
    const raw = {
      format: "tutor-mechanics-v1", nodes: [{ id: "A", x: 0, y: 0 }, { id: "B", x: 1, y: 0 }],
      members: [{ id: "AB", from: "A", to: "B", kind: "beam" }], supports: [],
      loads: [{ id: "P", kind: "nodal-force", nodeId: "X", direction: [0, 0], symbol: "P" }], dimensions: [], annotations: [],
    };
    const parsed = (() => { try { return parseMechanicsDiagram(raw); } catch { return null; } })();
    expect(parsed).toBeNull();
    const schemaOnly = { ...raw, loads: [] };
    const diagram = parseMechanicsDiagram(schemaOnly);
    expect(validateMechanicsDiagram(diagram)).toMatchObject({ valid: true, errors: [] });
  });

  it("keeps model transport separate from strict semantic validation", async () => {
    const valid = mechanicsTemplateFromInstruction("简支梁跨中集中力 P");
    const provider = createMechanicsDiagramProvider({ id: "test", model: "vision", async available() { return { available: true }; }, async complete(prompt) {
      expect(prompt).toContain("Never invent a number");
      return `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    } });
    const result = await provider.generate("简支梁");
    expect(result).toMatchObject({ provider: "test", model: "vision", diagram: { format: "tutor-mechanics-v1" } });
    expect(buildMechanicsDiagramPrompt("P 未知")).toContain("P 未知");
  });

  it("scores semantic relations independently from generated object IDs", () => {
    const expected = mechanicsTemplateFromInstruction("简支梁跨中集中力 P");
    const renamed = structuredClone(expected);
    renamed.loads = [];
    expect(scoreMechanicsRelations(expected, expected).f1).toBe(1);
    const partial = scoreMechanicsRelations(renamed, expected);
    expect(partial.precision).toBe(1);
    expect(partial.recall).toBeLessThan(1);
    expect(partial.f1).toBeLessThan(1);
  });

  it("preserves multi-span and overhang topology without inventing loads", () => {
    const continuous = mechanicsTemplateFromInstruction("画三跨连续梁 A-B-C-D，A 铰，B/C/D 滚动，标注三跨长度 L1、L2、L3。");
    expect(continuous).toMatchObject({
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      members: [{ id: "AB" }, { id: "BC" }, { id: "CD" }],
      supports: [{ nodeId: "A", kind: "pin" }, { nodeId: "B", kind: "roller" }, { nodeId: "C", kind: "roller" }, { nodeId: "D", kind: "roller" }],
      loads: [],
      dimensions: [{ symbol: "L1" }, { symbol: "L2" }, { symbol: "L3" }],
    });
    const overhang = mechanicsTemplateFromInstruction("画 A-B 支承、B-C 右侧外伸的梁，C 点向下 P。");
    expect(overhang.members.map((member) => `${member.from}-${member.to}`)).toEqual(["A-B", "B-C"]);
    expect(overhang.loads).toEqual([expect.objectContaining({ kind: "nodal-force", nodeId: "C", symbol: "P" })]);
  });

  it("distinguishes load placement and supports compound teaching structures", () => {
    const full = mechanicsTemplateFromInstruction("画长度 L 的简支梁，全跨承受向下均布荷载 q。");
    const half = mechanicsTemplateFromInstruction("简支梁左半跨承受向下均布荷载 q，右半跨无荷载。");
    expect(scoreMechanicsRelations(full, half).f1).toBeLessThan(1);
    const truss = mechanicsTemplateFromInstruction("画两跨平面桁架，给出上下弦、竖杆与对角杆，左铰右滚。");
    expect(truss.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "F" })]));
    expect(truss.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: "EC" })]));
    expect(truss.members).toHaveLength(9);
    const arch = mechanicsTemplateFromInstruction("画三铰拱，左右铰支座，拱顶设内铰并标注 C。");
    expect(arch.supports).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "C", kind: "pin", label: "内铰" })]));
  });

  it("returns explicit non-diagram outcomes instead of guessing missing inputs", () => {
    expect(mechanicsBaselineOutcomeFromInstruction("画一根梁，左端有支座，右端自由。").kind).toBe("clarification");
    expect(mechanicsBaselineOutcomeFromInstruction("把参考图中的梁和支座转成结构图。").kind).toBe("needs-reference");
    expect(mechanicsBaselineOutcomeFromInstruction("将已有梁的跨中 P 移到四分之一跨，其他对象不变。").kind).toBe("needs-context");
    expect(mechanicsBaselineOutcomeFromInstruction("输入语义 JSON，其中荷载引用不存在的节点 X。").kind).toBe("rejected");
    const noSolve = mechanicsBaselineOutcomeFromInstruction("画简支梁示意图，并求支座反力。");
    expect(noSolve).toMatchObject({ kind: "diagram", diagram: { loads: [], annotations: [] } });
  });

  it("models triangular distributed loads and spring supports explicitly", () => {
    const triangular = mechanicsTemplateFromInstruction("梁上分布荷载从左端 0 线性增大到右端 q0。");
    expect(triangular.loads[0]).toMatchObject({ kind: "distributed", distribution: "linear", symbol: "0", endSymbol: "q0", from: 0, to: 1 });
    const spring = mechanicsTemplateFromInstruction("梁右端由竖向弹簧 k 支承，左端铰支。");
    expect(spring.supports).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "B", kind: "spring", label: "k" })]));
  });
});
