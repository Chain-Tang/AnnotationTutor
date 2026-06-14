import { describe, expect, it } from "vitest";
import { detectLanguageName } from "../src/lang.js";

describe("detectLanguageName", () => {
  it("detects Chinese from Han characters", () => {
    expect(detectLanguageName("婴儿把坏的部分投射到客体上。")).toBe("Chinese");
  });

  it("detects Japanese when kana is present, even mixed with Han", () => {
    expect(detectLanguageName("投射された対象が怖い。")).toBe("Japanese");
  });

  it("detects Korean from Hangul", () => {
    expect(detectLanguageName("대상에 대한 두려움")).toBe("Korean");
  });

  it("returns empty for Latin-script text so the soft fallback applies", () => {
    expect(detectLanguageName("It runs attention in parallel.")).toBe("");
    expect(detectLanguageName("Le bébé projette les mauvaises parties.")).toBe("");
  });

  it("returns empty for text with no decisive script", () => {
    expect(detectLanguageName("")).toBe("");
    expect(detectLanguageName("123 — ??!")).toBe("");
  });
});
