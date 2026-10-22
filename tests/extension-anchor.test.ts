// Re-anchoring semantics for the on-page highlight store: `locate` must not
// only find the quote but find the *right* occurrence when a quote repeats,
// and must grade how confident the match was. The text map is pure data, so
// these run without any DOM — `locate` only reads `map.text`.

import { describe, expect, it } from "vitest";
import { locate, type TextMap } from "../extension/src/anchor.js";

/** A text map with no node segments; locate never touches them. */
function mapOf(text: string): TextMap {
  return { text, segments: [] };
}

describe("locate", () => {
  it("finds a unique quote and grades it exact", () => {
    const map = mapOf("The quick brown fox jumps over the lazy dog.");
    const hit = locate(map, {
      exact: "brown fox",
      prefix: "The quick ",
      suffix: " jumps over"
    });
    expect(hit).toEqual({ start: 10, end: 19, status: "exact" });
  });

  it("disambiguates repeats toward the recorded creation offset", () => {
    const map = mapOf("alpha beta alpha beta");
    const hit = locate(map, {
      exact: "alpha",
      prefix: "",
      suffix: " beta",
      start: 11
    });
    expect(hit?.start).toBe(11);
    expect(hit?.status).toBe("exact");
  });

  it("falls back to the first occurrence without a recorded offset", () => {
    const map = mapOf("alpha beta alpha beta");
    const hit = locate(map, { exact: "alpha", prefix: "", suffix: " beta" });
    expect(hit?.start).toBe(0);
  });

  it("grades a fallback-level match as shifted", () => {
    // Created with prefix "before "; the page now starts differently, so only
    // the exact+suffix probe can still match.
    const map = mapOf("Some new lead-in. quote after the change.");
    const hit = locate(map, {
      exact: "quote",
      prefix: "before ",
      suffix: " after"
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe("quote");
  });

  it("returns null when the quote is gone from the page", () => {
    const map = mapOf("Nothing to see here.");
    expect(locate(map, { exact: "vanishing quote", prefix: " ", suffix: " " })).toBeNull();
  });

  it("caps candidate collection on a pathological repeat without failing", () => {
    const map = mapOf("ab ".repeat(100));
    const hit = locate(map, { exact: "ab", prefix: "", suffix: " ", start: 150 });
    // Hits cap at 50 (offsets 0..147); the closest to 150 is 147.
    expect(hit?.start).toBe(147);
  });
});

describe("fuzzy re-anchoring", () => {
  it("recovers a quote that drifted in whitespace and case", () => {
    const map = mapOf("Intro then The   QUITE   important passage ends here.");
    const hit = locate(map, {
      exact: "The quite important passage",
      prefix: "zzz ",
      suffix: " zzz"
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe("The   QUITE   important passage");
  });

  it("recovers a quote through curly-quote drift", () => {
    const map = mapOf('He said “learning” was the key to everything.');
    const hit = locate(map, {
      exact: 'He said "learning" was the key',
      prefix: "zzz ",
      suffix: " zzz"
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe("He said “learning” was the key");
  });

  it("recovers a small rewording near the recorded offset", () => {
    const page =
      "Some filler paragraph that stays put. The core idea of spaced repitition matters a lot in practice.";
    const map = mapOf(page);
    const start = page.indexOf("The core idea");
    const hit = locate(map, {
      exact: "The core idea of spaced repetition matters",
      prefix: "zzz ",
      suffix: " zzz",
      start
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe(
      "The core idea of spaced repitition matters"
    );
  });

  it("still finds the quote when the page deleted text before it", () => {
    // Creation offset pointed at 40; an edit trimmed the lead-in, so the quote
    // now sits well before the recorded offset but inside the search window.
    const page = "Short lead. The highlighted sentence about anchoring stays.";
    const map = mapOf(page);
    const hit = locate(map, {
      exact: "The highlighted sentence about anchoring",
      prefix: "zzz ",
      suffix: " zzz",
      start: 60
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe(
      "The highlighted sentence about anchoring"
    );
  });

  it("gives up when the page text is unrelated", () => {
    const map = mapOf("Totally different words now fill this paragraph.");
    expect(
      locate(map, {
        exact: "The core idea of spaced repetition matters",
        prefix: "zzz ",
        suffix: " zzz",
        start: 5
      })
    ).toBeNull();
  });

  it("skips edit-distance matching for very short quotes", () => {
    const map = mapOf("xx yy zz");
    expect(locate(map, { exact: "qq ww", prefix: "", suffix: "", start: 0 })).toBeNull();
  });

  it("declines an ambiguous normalized match without a recorded offset", () => {
    const map = mapOf("He said Hi there. Later he said Hi again.");
    // "said hi" occurs twice in normalized space; without `start` the fuzzy
    // pass cannot tell them apart, and the raw probes already failed.
    expect(
      locate(map, { exact: "SAID hi", prefix: "He ", suffix: " there" })
    ).toBeNull();
  });

  it("disambiguates a normalized repeat toward the recorded offset", () => {
    const map = mapOf("He said Hi there. Later he said Hi again.");
    const hit = locate(map, {
      exact: "SAID hi",
      prefix: "He ",
      suffix: " there",
      start: 30
    });
    expect(hit?.status).toBe("shifted");
    expect(map.text.slice(hit!.start, hit!.end)).toBe("said Hi");
  });
});
