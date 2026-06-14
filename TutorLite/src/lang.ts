// Detect the dominant script of a piece of text so the review language can be
// pinned to a concrete target. Free models frequently ignore a soft "reply in
// the note's language" instruction and drift to English; giving them an explicit
// target ("Write the review content in Chinese.") fixes that.
//
// We only pin the scripts where that drift actually happens — the CJK family and
// Korean — and return "" for everything else (Latin and friends), so notes
// written in French, German, Spanish, etc. keep the soft "same language as the
// note" instruction and are not mislabelled as English.

export type DetectedLanguage = "Chinese" | "Japanese" | "Korean" | "";

function isHangul(code: number): boolean {
  return (
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0x1100 && code <= 0x11ff) || // Jamo
    (code >= 0x3130 && code <= 0x318f) // Compatibility Jamo
  );
}

function isKana(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xff66 && code <= 0xff9d) // Half-width Katakana
  );
}

function isHan(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // Extension A
    (code >= 0xf900 && code <= 0xfaff) // Compatibility Ideographs
  );
}

/**
 * Best-effort language name for `text`. Kana ⇒ Japanese and Hangul ⇒ Korean take
 * precedence over bare Han (which ⇒ Chinese), because Japanese/Korean text mixes
 * in Han characters. Returns "" when no CJK/Korean script is present so callers
 * fall back to "same language as the note".
 */
export function detectLanguageName(text: string): DetectedLanguage {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (isHangul(code)) hangul += 1;
    else if (isKana(code)) kana += 1;
    else if (isHan(code)) han += 1;
  }
  if (hangul > 0) return "Korean";
  if (kana > 0) return "Japanese";
  if (han > 0) return "Chinese";
  return "";
}
