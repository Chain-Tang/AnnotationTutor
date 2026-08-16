import { describe, expect, it } from "vitest";
import {
  aggregateWebStats,
  parseCaptureMeta,
  type WebCaptureMeta
} from "../src/web-bridge/stats.js";

const noteA = [
  "---",
  "type: web-capture",
  'title: "Alpha"',
  'source-url: "https://a.example/1"',
  "captured-at: 2026-08-13T09:00:00.000Z",
  "tags:",
  "  - web-capture",
  "---",
  "",
  "> highlight one ^cap-a1",
  "",
  "> highlight two ^cap-a2",
  "",
  "## My understanding",
  ""
].join("\n");

describe("parseCaptureMeta", () => {
  it("reads frontmatter and counts anchored selections", () => {
    const meta = parseCaptureMeta("captures/alpha.md", noteA);
    expect(meta.title).toBe("Alpha");
    expect(meta.url).toBe("https://a.example/1");
    expect(meta.capturedAt).toBe("2026-08-13T09:00:00.000Z");
    expect(meta.selections).toBe(2);
  });

  it("reports zero selections for a plain page note", () => {
    const meta = parseCaptureMeta(
      "captures/none.md",
      "---\ntype: web-capture\n---\n\nbody"
    );
    expect(meta.selections).toBe(0);
  });
});

describe("aggregateWebStats", () => {
  const items: WebCaptureMeta[] = [
    {
      path: "a.md",
      url: "https://a.example/1",
      capturedAt: "2026-08-13T09:00:00.000Z",
      selections: 2
    },
    {
      path: "b.md",
      url: "https://a.example/1",
      capturedAt: "2026-08-13T22:00:00.000Z",
      selections: 0
    },
    {
      path: "c.md",
      url: "https://b.example/2",
      capturedAt: "2026-08-15T08:00:00.000Z",
      selections: 1
    }
  ];

  it("counts pages and de-dupes source URLs in first-seen order", () => {
    const stats = aggregateWebStats(items);
    expect(stats.totalPages).toBe(3);
    expect(stats.uniqueUrls).toEqual([
      "https://a.example/1",
      "https://b.example/2"
    ]);
  });

  it("buckets captures by calendar day, ascending", () => {
    const stats = aggregateWebStats(items);
    expect(stats.byDay).toEqual([
      { day: "2026-08-13", count: 2 },
      { day: "2026-08-15", count: 1 }
    ]);
  });

  it("ignores items without a URL or timestamp", () => {
    const stats = aggregateWebStats([{ path: "x.md", selections: 0 }]);
    expect(stats.totalPages).toBe(1);
    expect(stats.uniqueUrls).toEqual([]);
    expect(stats.byDay).toEqual([]);
  });
});
