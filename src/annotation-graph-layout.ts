import type { AnchorMark } from "./decorations-plan.js";

export type AnnotationGraphPlacement = {
  id: string;
  mark?: AnchorMark;
  parentId?: string;
  missing: boolean;
  cycle: boolean;
  x: number;
  y: number;
  childCount: number;
};

/** Resolve a forest without recursion: malformed/external links remain visible. */
export function planAnnotationGraph(
  marks: readonly AnchorMark[],
  focusId?: string,
  collapsed: ReadonlySet<string> = new Set()
): AnnotationGraphPlacement[] {
  const byId = new Map(marks.map(mark => [mark.id, mark]));
  const focus = focusId ? byId.get(focusId) : undefined;
  const rootId = focus?.branch?.rootAnnotationId ?? focus?.id;
  const relevant = rootId
    ? marks.filter(mark => mark.id === rootId || mark.branch?.rootAnnotationId === rootId || mark.id === focusId)
    : [...marks];
  const nodes = new Map<string, AnnotationGraphPlacement>();
  for (const mark of relevant) nodes.set(mark.id, {
    id: mark.id, mark, parentId: mark.branch?.parentAnnotationId,
    missing: false, cycle: false, x: 0, y: 0, childCount: 0
  });
  for (const node of [...nodes.values()]) if (node.parentId && !nodes.has(node.parentId)) {
    nodes.set(node.parentId, {
      id: node.parentId, missing: true, cycle: false, x: 0, y: 0, childCount: 0
    });
  }
  // Break only a display edge, preserving the original relationship on the file.
  const resolved = new Set<string>();
  for (const node of nodes.values()) {
    const seen = new Set<string>();
    let current: AnnotationGraphPlacement | undefined = node;
    while (current && !resolved.has(current.id)) {
      if (seen.has(current.id)) { current.cycle = true; current.parentId = undefined; break; }
      seen.add(current.id);
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    for (const id of seen) resolved.add(id);
  }
  const children = new Map<string, AnnotationGraphPlacement[]>();
  const roots: AnnotationGraphPlacement[] = [];
  for (const node of nodes.values()) {
    if (!node.parentId) roots.push(node);
    else {
      const group = children.get(node.parentId) ?? [];
      group.push(node); children.set(node.parentId, group);
    }
  }
  for (const node of nodes.values()) node.childCount = children.get(node.id)?.length ?? 0;
  const result: AnnotationGraphPlacement[] = [];
  const queue = roots.map(node => ({ node, depth: 0 }));
  const rows = new Map<number, number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor]!;
    const row = rows.get(item.depth) ?? 0;
    rows.set(item.depth, row + 1);
    item.node.x = item.depth * 340 + 32;
    item.node.y = row * 216 + 32;
    result.push(item.node);
    if (!collapsed.has(item.node.id)) {
      for (const child of children.get(item.node.id) ?? []) queue.push({ node: child, depth: item.depth + 1 });
    }
  }
  return result;
}

/** Current path, siblings and immediate children, in source order, without duplicates. */
export function annotationNeighborhood(marks: readonly AnchorMark[], selectedId: string): AnchorMark[] {
  const byId = new Map(marks.map(mark => [mark.id, mark]));
  const selected = byId.get(selectedId);
  if (!selected) return [];
  const path: AnchorMark[] = [];
  const seen = new Set<string>();
  let current: AnchorMark | undefined = selected;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); path.unshift(current);
    current = current.branch ? byId.get(current.branch.parentAnnotationId) : undefined;
  }
  const nearby = marks.filter(mark =>
    mark.branch?.parentAnnotationId === selectedId ||
    (selected.branch && mark.branch?.parentAnnotationId === selected.branch.parentAnnotationId)
  );
  return [...new Map([...path, ...nearby].map(mark => [mark.id, mark])).values()];
}
