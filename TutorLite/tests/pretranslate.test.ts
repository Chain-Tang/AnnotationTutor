import { describe, expect, it } from "vitest";
import {
  applyGlossary,
  buildFileGlossary,
  buildGlossaryPrompt,
  contentHash,
  emptyFileGlossary,
  lookupGloss,
  mergeGlossaryEntry,
  parseGlossary,
  segmentDocument
} from "../src/pretranslate.js";

describe("buildGlossaryPrompt", () => {
  it("names the native language, the format, and embeds the passage", () => {
    const prompt = buildGlossaryPrompt("The ego mediates.", "Chinese (Simplified)");
    expect(prompt).toContain("Chinese (Simplified)");
    expect(prompt).toContain("term :: meaning");
    expect(prompt).toContain("The ego mediates.");
  });

  it("asks for individual single-word entries so word lookups hit the cache", () => {
    const prompt = buildGlossaryPrompt("x", "English");
    expect(prompt).toContain("individual words");
  });
});

describe("parseGlossary", () => {
  it("parses the requested `term :: meaning` format", () => {
    const entries = parseGlossary("ego :: 自我\nid :: 本我");
    expect(entries).toEqual([
      { surface: "ego", gloss: "自我" },
      { surface: "id", gloss: "本我" }
    ]);
  });

  it("strips list markers and tolerates other separators", () => {
    const entries = parseGlossary("- ego => 自我\n1. id\t本我\n* superego || 超我");
    expect(entries).toEqual([
      { surface: "ego", gloss: "自我" },
      { surface: "id", gloss: "本我" },
      { surface: "superego", gloss: "超我" }
    ]);
  });

  it("drops blank, separator-less, and self-equal lines", () => {
    const entries = parseGlossary("\nnonsense line\nego :: ego\nid :: 本我\n");
    expect(entries).toEqual([{ surface: "id", gloss: "本我" }]);
  });

  it("de-noises wrapping quotes and trailing punctuation", () => {
    expect(parseGlossary('"ego" :: "自我"')).toEqual([
      { surface: "ego", gloss: "自我" }
    ]);
    expect(parseGlossary("flow :: 心流。")).toEqual([
      { surface: "flow", gloss: "心流" }
    ]);
  });
});

describe("buildFileGlossary + lookupGloss", () => {
  it("keeps the first meaning per term and looks up case-insensitively", () => {
    const glossary = buildFileGlossary("h", [
      { surface: "Ego", gloss: "自我" },
      { surface: "ego", gloss: "另一个" },
      { surface: "id", gloss: "本我" }
    ]);
    expect(glossary.entries).toHaveLength(2);
    expect(lookupGloss(glossary, "EGO")).toBe("自我");
    expect(lookupGloss(glossary, "  id  ")).toBe("本我");
    expect(lookupGloss(glossary, "missing")).toBeUndefined();
  });

  it("orders entries longest-surface first for greedy matching", () => {
    const glossary = buildFileGlossary("h", [
      { surface: "ego", gloss: "a" },
      { surface: "cognitive dissonance", gloss: "b" }
    ]);
    expect(glossary.entries[0]?.surface).toBe("cognitive dissonance");
  });

  it("marks a glossary complete by default and partial when asked", () => {
    expect(buildFileGlossary("h", []).complete).toBe(true);
    expect(buildFileGlossary("h", [], false).complete).toBe(false);
    expect(emptyFileGlossary("h").complete).toBe(true);
  });
});

describe("mergeGlossaryEntry", () => {
  it("adds a new entry, re-sorts longest-first, and preserves hash/complete", () => {
    const base = buildFileGlossary("h", [{ surface: "ego", gloss: "自我" }], false);
    const merged = mergeGlossaryEntry(base, {
      surface: "cognitive dissonance",
      gloss: "认知失调"
    });
    expect(merged.hash).toBe("h");
    expect(merged.complete).toBe(false);
    expect(merged.entries[0]?.surface).toBe("cognitive dissonance");
    expect(lookupGloss(merged, "ego")).toBe("自我");
    expect(lookupGloss(merged, "Cognitive Dissonance")).toBe("认知失调");
  });

  it("keeps the existing meaning (first-wins) for an already cached term", () => {
    const base = buildFileGlossary("h", [{ surface: "Ego", gloss: "自我" }]);
    const merged = mergeGlossaryEntry(base, { surface: "ego", gloss: "另一个" });
    expect(merged).toBe(base); // unchanged reference, no duplicate
    expect(lookupGloss(merged, "ego")).toBe("自我");
  });
});

describe("applyGlossary", () => {
  const glossary = buildFileGlossary("h", [
    { surface: "ego", gloss: "自我" },
    { surface: "superego", gloss: "超我" },
    { surface: "認知", gloss: "认知" }
  ]);

  it("glosses each cached term inline, preferring the longest match", () => {
    expect(applyGlossary("The superego limits the ego.", glossary)).toBe(
      "The superego (超我) limits the ego (自我)."
    );
  });

  it("respects word boundaries for Latin terms", () => {
    // "egoist" must not be glossed as "ego".
    expect(applyGlossary("an egoist", glossary)).toBe("an egoist");
  });

  it("matches CJK terms as substrings", () => {
    expect(applyGlossary("これは認知です", glossary)).toBe(
      "これは認知 (认知)です"
    );
  });

  it("returns the passage unchanged when nothing is cached", () => {
    expect(applyGlossary("nothing here", glossary)).toBe("nothing here");
    expect(applyGlossary("x", emptyFileGlossary("h"))).toBe("x");
  });

  it("resolves a bare single word (the word-mode cache fallback)", () => {
    // Word mode tries lookupGloss first, then applyGlossary on the lone word.
    expect(applyGlossary("ego", glossary)).toBe("ego (自我)");
  });
});

describe("segmentDocument", () => {
  it("drops frontmatter and fenced code, keeping prose paragraphs", () => {
    const doc = [
      "---",
      "title: Note",
      "---",
      "First paragraph with words.",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "Second paragraph here."
    ].join("\n");
    const batches = segmentDocument(doc, 1000);
    expect(batches.join("\n")).toContain("First paragraph with words.");
    expect(batches.join("\n")).toContain("Second paragraph here.");
    expect(batches.join("\n")).not.toContain("const x = 1;");
    expect(batches.join("\n")).not.toContain("title: Note");
  });

  it("packs paragraphs up to the batch budget", () => {
    const para = "word ".repeat(40).trim(); // ~200 chars
    const doc = Array.from({ length: 6 }, () => para).join("\n\n");
    const batches = segmentDocument(doc, 500);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(500);
  });

  it("skips paragraphs with no glossable letters", () => {
    expect(segmentDocument("--- \n\n***\n\n123 456", 1000)).toEqual([]);
  });

  it("packs the whole document into one batch when the chunk size exceeds it", () => {
    const doc = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const batches = segmentDocument(doc, 100000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("First paragraph.");
    expect(batches[0]).toContain("Third paragraph.");
  });
});

describe("contentHash", () => {
  it("is stable and content-sensitive", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});
