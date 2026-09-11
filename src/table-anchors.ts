import { findTableInLines } from "./editor.js";

/** Strip only TutorLite-owned table tokens; preserve EOLs, user ids and math. */
export function cleanTableAnchors(source: string, knownIds: ReadonlySet<string>): string {
  const lines = source.split(/\r?\n/);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const remove = new Set<number>();
  let changed = false;
  for (let line = 0; line < lines.length; line++) {
    const table = findTableInLines(lines, line);
    if (!table) continue;
    for (let row = table.startLine; row <= table.endLine; row++) {
      const before = lines[row]!;
      // Tokens inside inline code are examples, not generated anchors.
      lines[row] = before.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part :
        part.replace(/[ \t]+\^([A-Za-z0-9_-]+)(?=[ \t|]|$)/g,
          (token, id: string) => knownIds.has(id) ? "" : token)).join("");
      changed ||= lines[row] !== before;
    }
    const next = table.endLine + 1;
    const id = /^[ \t]*\^([A-Za-z0-9_-]+)[ \t]*$/.exec(lines[next] ?? "")?.[1];
    if (id && knownIds.has(id)) { remove.add(next); changed = true; }
    line = table.endLine;
  }
  return changed ? lines.filter((_, i) => !remove.has(i)).join(eol) : source;
}
