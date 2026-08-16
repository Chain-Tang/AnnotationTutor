import { describe, expect, it } from "vitest";
import {
  parseBibTeX,
  parseCslJson,
  parseImport,
  toBibTeX,
  zoteroCaptureNote,
  type ZoteroEntry
} from "../src/zotero-import.js";

const CSL_SAMPLE = JSON.stringify([
  {
    type: "article-journal",
    title: "Improving Students' Learning With Effective Learning Techniques",
    author: [
      { family: "Dunlosky", given: "John" },
      { family: "Rawson", given: "Katherine A." }
    ],
    issued: { "date-parts": [[2013, 1]] },
    "container-title": "Psychological Science in the Public Interest",
    DOI: "10.1177/1529100612453266",
    URL: "https://example.org/paper",
    abstract: "Practice testing and distributed practice beat rereading."
  },
  { title: "  " },
  { title: "No authors", issued: { "date-parts": [[2020]] } }
]);

describe("parseCslJson", () => {
  it("normalizes items and skips entries without a title", () => {
    const result = parseCslJson(CSL_SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    const first = result.entries[0]!;
    expect(first.title).toBe(
      "Improving Students' Learning With Effective Learning Techniques"
    );
    expect(first.authors).toEqual(["Dunlosky, John", "Rawson, Katherine A."]);
    expect(first.year).toBe("2013");
    expect(first.venue).toBe("Psychological Science in the Public Interest");
    expect(first.doi).toBe("10.1177/1529100612453266");
    expect(first.url).toBe("https://example.org/paper");
    expect(first.abstract).toContain("distributed practice");
  });

  it("accepts a single item object", () => {
    const result = parseCslJson(JSON.stringify({ title: "Solo" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Solo");
  });

  it("supports literal author names", () => {
    const result = parseCslJson(
      JSON.stringify([{ title: "Report", author: [{ literal: "WHO" }] }])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.authors).toEqual(["WHO"]);
  });

  it("rejects invalid JSON and empty exports", () => {
    expect(parseCslJson("not json")).toEqual({ ok: false, error: "invalid-json" });
    expect(parseCslJson("[]")).toEqual({ ok: false, error: "no-entries" });
    expect(parseCslJson(JSON.stringify([{ title: "" }]))).toEqual({
      ok: false,
      error: "no-entries"
    });
  });
});

describe("toBibTeX", () => {
  const entry: ZoteroEntry = {
    title: "Deep Learning for Memory",
    authors: ["Smith, Ada", "Chen, Bo"],
    year: "2024",
    venue: "Nature Learning",
    doi: "10.1000/xyz",
    url: "https://example.org/dl"
  };

  it("emits a parseable entry with a stable key", () => {
    const bib = toBibTeX(entry);
    expect(bib).toMatch(/^@article\{smith2024deep,/);
    expect(bib).toContain("title = {Deep Learning for Memory},");
    expect(bib).toContain("author = {Smith, Ada and Chen, Bo},");
    expect(bib).toContain("year = {2024},");
    expect(bib).toContain("journal = {Nature Learning},");
    expect(bib).toContain("doi = {10.1000/xyz},");
    expect(bib.trim().endsWith("}")).toBe(true);
  });

  it("falls back to an unknown key without authors or year", () => {
    const bib = toBibTeX({ title: "Orphan", authors: [] });
    expect(bib).toMatch(/^@article\{unknown/);
    expect(bib).not.toContain("author =");
    expect(bib).not.toContain("year =");
  });
});

describe("zoteroCaptureNote", () => {
  it("anchors the abstract and embeds the BibTeX citation", () => {
    const note = zoteroCaptureNote(
      {
        title: "Paper",
        authors: ["Curie, Marie"],
        year: "1903",
        doi: "10.5555/radium",
        abstract: "Radiation facts."
      },
      "2026-08-13T00:00:00.000Z",
      "cap-z1"
    );
    expect(note).toContain("> Radiation facts. ^cap-z1");
    expect(note).toContain('source-url: "https://doi.org/10.5555/radium"');
    expect(note).toContain("## Reference");
    expect(note).toContain("- Authors: Curie, Marie");
    expect(note).toContain("```bibtex");
    expect(note).toContain("@article{curie1903pape,");
  });

  it("uses the title as the anchored text when no abstract exists", () => {
    const note = zoteroCaptureNote(
      { title: "Only Title", authors: [] },
      "2026-08-13T00:00:00.000Z",
      "cap-z2"
    );
    expect(note).toContain("> Only Title ^cap-z2");
  });
});

const BIB_SAMPLE = `@article{dunlosky2013impr,
  title = {Improving Students' {Learning} With Effective Learning Techniques},
  author = {Dunlosky, John and Rawson, Katherine A.},
  year = 2013,
  journal = {Psychological Science in the Public Interest},
  doi = {10.1177/1529100612453266},
  url = "https://example.org/paper",
  abstract = {Practice testing and distributed practice beat rereading.}
}

@comment{this should be skipped}

@inproceedings{smith2024deep,
  title = "Deep Learning for Memory",
  author = {Smith, Ada and Chen, Bo},
  booktitle = {Nature Learning},
  year = {2024}
}`;

describe("parseBibTeX", () => {
  it("parses multiple entries with mixed value styles", () => {
    const result = parseBibTeX(BIB_SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    const first = result.entries[0]!;
    expect(first.title).toBe(
      "Improving Students' Learning With Effective Learning Techniques"
    );
    expect(first.authors).toEqual(["Dunlosky, John", "Rawson, Katherine A."]);
    expect(first.year).toBe("2013");
    expect(first.venue).toBe("Psychological Science in the Public Interest");
    expect(first.doi).toBe("10.1177/1529100612453266");
    expect(first.url).toBe("https://example.org/paper");
    expect(first.abstract).toContain("distributed practice");
    const second = result.entries[1]!;
    expect(second.title).toBe("Deep Learning for Memory");
    expect(second.authors).toEqual(["Smith, Ada", "Chen, Bo"]);
    expect(second.venue).toBe("Nature Learning");
  });

  it("strips LaTeX grouping braces from values", () => {
    const result = parseBibTeX(
      "@article{k, title = {A {Nested} {Brace} Title}, year = {1999}}"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.title).toBe("A Nested Brace Title");
  });

  it("skips entries without a title", () => {
    const result = parseBibTeX("@misc{k, author = {Nobody}, year = {2001}}");
    expect(result).toEqual({ ok: false, error: "no-entries" });
  });

  it("rejects text without entries", () => {
    expect(parseBibTeX("just some text")).toEqual({
      ok: false,
      error: "no-entries"
    });
  });

  it("walks many entries in order with skippable blocks interleaved", () => {
    // Guards the sticky-cursor rewrite (L6): the parser must advance past each
    // body and every @comment without dropping, duplicating, or reordering the
    // real entries.
    const many = Array.from(
      { length: 6 },
      (_, i) =>
        `@article{k${i}, title = {Paper ${i}}, year = {${2000 + i}}}\n@comment{skip ${i}}`
    ).join("\n");
    const result = parseBibTeX(many);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.title)).toEqual([
      "Paper 0",
      "Paper 1",
      "Paper 2",
      "Paper 3",
      "Paper 4",
      "Paper 5"
    ]);
  });
});

describe("parseImport", () => {
  it("routes CSL-JSON pastes to the CSL parser", () => {
    const result = parseImport(CSL_SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.year).toBe("2013");
  });

  it("routes BibTeX pastes to the BibTeX parser", () => {
    const result = parseImport(BIB_SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
  });

  it("finds a BibTeX entry after a leading comment line", () => {
    const result = parseImport("% exported by hand\n@article{k, title = {Hi}}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]!.title).toBe("Hi");
  });

  it("rejects empty and unparseable pastes", () => {
    expect(parseImport("")).toEqual({ ok: false, error: "no-entries" });
    expect(parseImport("hello world")).toEqual({
      ok: false,
      error: "invalid-json"
    });
  });
});
