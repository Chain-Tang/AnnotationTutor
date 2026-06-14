import { describe, expect, it } from "vitest";
import {
  buildPassageGlossPrompt,
  buildWordGlossPrompt,
  classifyTranslateSelection,
  cleanGloss,
  formatWordGloss,
  nativeLanguageName,
  stripWrapper
} from "../src/translate.js";

describe("classifyTranslateSelection", () => {
  it("treats a short single token as a word", () => {
    expect(classifyTranslateSelection("ephemeral")).toBe("word");
    expect(classifyTranslateSelection("  認知  ")).toBe("word");
  });

  it("treats multi-word, punctuated, long, or empty text as a passage", () => {
    expect(classifyTranslateSelection("cognitive dissonance")).toBe("passage");
    expect(classifyTranslateSelection("ego.")).toBe("passage");
    expect(classifyTranslateSelection("自我，本我")).toBe("passage");
    expect(classifyTranslateSelection("字".repeat(30))).toBe("passage");
    expect(classifyTranslateSelection("")).toBe("passage");
  });
});

describe("nativeLanguageName", () => {
  it("maps locales to English language names", () => {
    expect(nativeLanguageName("zh-cn")).toBe("Chinese (Simplified)");
    expect(nativeLanguageName("zh-tw")).toBe("Chinese (Traditional)");
    expect(nativeLanguageName("ja")).toBe("Japanese");
    expect(nativeLanguageName("en")).toBe("English");
  });
});

describe("buildWordGlossPrompt", () => {
  it("includes the word, its context, and the target language", () => {
    const prompt = buildWordGlossPrompt("ego", "The ego mediates.", "Chinese (Simplified)");
    expect(prompt).toContain("ego");
    expect(prompt).toContain("The ego mediates.");
    expect(prompt).toContain("Chinese (Simplified)");
  });
});

describe("buildPassageGlossPrompt", () => {
  it("names the native language and embeds the passage", () => {
    const prompt = buildPassageGlossPrompt("ego and id", "Chinese (Simplified)");
    expect(prompt).toContain("Chinese (Simplified)");
    expect(prompt).toContain("ego and id");
  });
});

describe("cleanGloss", () => {
  it("takes the first line and strips quotes and trailing punctuation", () => {
    expect(cleanGloss('"自我"')).toBe("自我");
    expect(cleanGloss("自我。\n(ignored second line)")).toBe("自我");
    expect(cleanGloss("  ego  ")).toBe("ego");
  });
});

describe("stripWrapper", () => {
  it("removes a code fence", () => {
    expect(stripWrapper("```\nhello world\n```")).toBe("hello world");
  });

  it("removes surrounding triple quotes", () => {
    expect(stripWrapper('"""hello"""')).toBe("hello");
  });

  it("leaves plain text untouched", () => {
    expect(stripWrapper("just text")).toBe("just text");
  });
});

describe("formatWordGloss", () => {
  it("appends the gloss in parentheses", () => {
    expect(formatWordGloss("ego", "自我")).toBe("ego (自我)");
  });

  it("returns the word alone when the gloss is empty or identical", () => {
    expect(formatWordGloss("ego", "")).toBe("ego");
    expect(formatWordGloss("ego", "ego")).toBe("ego");
  });
});
