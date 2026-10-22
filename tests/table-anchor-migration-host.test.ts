import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { IndexTable } from "../src/index-table.js";
import { bareBlockId, type IndexRecord } from "../src/model.js";
import { cleanTableAnchors } from "../src/table-anchors.js";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const from = source.indexOf("  private async migrateTableAnchors("), to = source.indexOf("\n  /** Legacy or user-owned table anchor;", from);
if (from < 0 || to < 0) throw new Error("Table migration host boundaries changed");
const module = { exports: {} };
new Function("module", "bareBlockId", "cleanTableAnchors", transformSync(`class Host {
  migratingTables = new Set(); ${source.slice(from, to)}
}; module.exports = Host;`, { loader: "ts", format: "cjs" }).code)(module, bareBlockId, cleanTableAnchors);
type Host = { migrateTableAnchors(file: { path: string; extension: string }): Promise<void> };
const Host = module.exports as new () => Host;
const row = (annotationId: string, sourceFile: string, anchor: string, anchorOrigin: IndexRecord["anchorOrigin"] = "generated"): IndexRecord => ({
  annotationId, memoryFile: `memory/${annotationId}.md`, sourceFile, anchor, anchorOrigin, selectedText: "test", status: "saved",
  concepts: [], relatedMemoryCells: [], createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z"
});

describe("indexed table-anchor migration", () => {
  it("checks only generated anchors belonging to the opened source in a 10000-record library", async () => {
    const table = new IndexTable(Array.from({ length: 10000 }, (_, i) => row(`ANN-${i}`, `unrelated-${i}.md`, `^other-${i}`)));
    table.upsert(row("ANN-current", "current.md", "^owned"));
    table.upsert(row("ANN-user", "current.md", "^user", "existing"));
    const all = vi.spyOn(table, "all"), host = new Host();
    let markdown = "A | B\n--- | ---\nvalue ^owned | user ^user";
    const read = vi.fn(async () => markdown), process = vi.fn(async (_file, transform: (text: string) => string) => { markdown = transform(markdown); });
    const refresh = vi.fn(async () => {});
    Object.assign(host, { indexTable: table, app: { vault: { read, process } }, refreshDecorations: refresh });
    await host.migrateTableAnchors({ path: "empty.md", extension: "md" });
    expect(read).not.toHaveBeenCalled();
    await host.migrateTableAnchors({ path: "current.md", extension: "md" });
    expect(markdown).toBe("A | B\n--- | ---\nvalue | user ^user");
    expect(all).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce(); expect(process).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
  });
});
