import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("AI drawing benchmark corpus", () => {
  it("keeps the fixed 24/24/12 distribution and complete evaluation fields", async () => {
    const benchmark = JSON.parse(await readFile(new URL("../research/ai-drawing/benchmark-v1.json", import.meta.url), "utf8")) as {
      tasks: Array<{ id: string; domain: string; title: string; prompt: string; references: string[]; expected: string[]; forbidden: string[] }>;
    };
    expect(benchmark.tasks).toHaveLength(60);
    const counts = benchmark.tasks.reduce<Record<string, number>>((result, task) => {
      result[task.domain] = (result[task.domain] ?? 0) + 1;
      expect(task.title).not.toBe("");
      expect(task.prompt).not.toBe("");
      expect(Array.isArray(task.references)).toBe(true);
      expect(task.expected.length).toBeGreaterThan(0);
      expect(task.forbidden.length).toBeGreaterThan(0);
      return result;
    }, {});
    expect(counts).toEqual({ anime: 24, mechanics: 24, general: 12 });
    expect(new Set(benchmark.tasks.map((task) => task.id)).size).toBe(60);
  });
});
