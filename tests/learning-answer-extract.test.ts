import { describe, expect, it } from "vitest";
import { extractMathAnswer, ANSWER_EXTRACTION_LIMITS, type AnswerExtractionQuestion } from "../src/learning-answer-extract.js";

const number: AnswerExtractionQuestion = { kind: "number", answer: "9" };
const choices: AnswerExtractionQuestion = { kind: "choice", answer: "趋于零", choices: ["趋于零", "没有极限", "趋于无穷"], choiceIds: ["zero-limit", "no-limit", "unbounded"] };
const span = (input: string, text: string) => ({ start: input.indexOf(text), end: input.indexOf(text) + text.length, text });

describe("bounded numeric utterances", () => {
  it.each([
    ["附近的读数趋向6。", 6], ["附近读数趋于 6", 6],
    ["附近的函数值接近 −1/2。", -.5], ["函数值趋向6", 6],
    ["读数逼近6。请检查一下。", 6], ["它趋于6。", 6], ["趋向6", 6],
    ["The nearby readings approach 6.", 6], ["The function values tend to 6.", 6],
    ["附近的读数趋向5。", 5],
  ])("extracts an explicit whole-utterance mathematical trend: %s", (input, value) => {
    const text = (input as string).includes("−1/2") ? "−1/2" : String(value);
    expect(extractMathAnswer(number, input as string)).toEqual({kind:"answer",answer:{kind:"number",value},source:"host"});
    // Even for these natural sentences, model offsets must match the whole
    // original answer atom; they cannot select some other number or suffix.
    const atom = (input as string).includes("approach") || (input as string).includes("tend to") ? text + "." : text;
    expect(extractMathAnswer(number, input as string, span(input as string, atom))).toMatchObject({kind:"answer",answer:{kind:"number",value},source:"candidate"});
  });
  it.each([
    "附近的读数可能趋向6", "附近的读数趋向6吗", "附近的读数趋向6？",
    "附近的读数趋向6或7", "附近的读数趋向6，我很痛苦", "老师说附近的读数趋向6",
    "附近的读数趋向6，不要记录", "附近的读数趋向6。这是我的密码。",
    "当x趋向6时，读数是9", "x趋向6", "它可能趋于6", "我的情绪趋向6",
    "附近的读数趋向6\n我需要支持", "The readings might approach 6.",
  ])("does not promote a contextual trend sentence into evidence: %s", input => {
    expect(extractMathAnswer(number, input).kind).not.toBe("answer");
    expect(extractMathAnswer(number, input, span(input, "6")).kind).not.toBe("answer");
  });
  it("keeps new trend grammar numeric and keeps undeclared units intact", () => {
    expect(extractMathAnswer(choices,"它趋于6").kind).not.toBe("answer");
    expect(extractMathAnswer(number,"附近的读数趋向6kg")).toEqual({kind:"clarification",reason:"unit-not-declared"});
    expect(extractMathAnswer({...number,units:[{symbol:"cm",factor:.01}]},"附近的读数趋向600cm")).toMatchObject({kind:"answer",answer:{kind:"number",value:6}});
  });
  it.each([
    ["极限是 9。", 9], ["极限等于9", 9], ["极限值为 −1/2。", -.5], ["结果是9", 9], ["计算结果等于9。", 9], ["the limit is 9.", 9], ["9", 9], ["答案是9", 9], ["  我的答案为 9。  ", 9], ["答案：−2", -2], ["−0", 0],
    ["1/4", .25], ["答案是 −1 / −4", .25], ["+1.25", 1.25], [".5", .5], ["1e-3", .001],
    ["−2E+3", -2000], ["the answer is 9.", 9], ["Answer: 2.5", 2.5], ["1e12", 1e12],
    ["我的最终答案是 9。",9], ["最终答案为 −1/2。",-.5], ["我这次的答案是9。",9], ["这次我的最终答案：9。",9],
    ["这次我改为9。这是我的最终答案。",9], ["我改为9。请核对一下。",9],
  ])("normalizes the whole answer %s", (input, value) => {
    expect(extractMathAnswer(number, input as string)).toEqual({ kind: "answer", answer: { kind: "number", value }, source: "host" });
  });
  it.each(["1/0", "1/1000000001", "1e101", "1e13", "NaN", "Infinity", "9!", "9%", "9?", "Math.random()", "2+7", "√81", "1/2/3", "9,000"])("never evaluates or strips unsupported syntax %s", input => {
    expect(extractMathAnswer(number, input).kind).not.toBe("answer");
  });
  it("is bounded and never treats a free explanation as numeric evidence", () => {
    expect(extractMathAnswer(number, "9".repeat(ANSWER_EXTRACTION_LIMITS.input + 1))).toEqual({ kind: "clarification", reason: "input-too-long" });
    expect(extractMathAnswer(number, "   ")).toEqual({ kind: "not-an-answer", reason: "empty" });
    expect(extractMathAnswer({ kind: "explanation", answer: "" }, "答案是9")).toEqual({ kind: "not-an-answer", reason: "explanation-question" });
    expect(extractMathAnswer(number, "今天很难受")).toEqual({ kind: "not-an-answer", reason: "unsupported-form" });
  });
});

describe("same-turn candidate spans cannot authorize substring scoring", () => {
  it.each(["我的答案是9。请检查，不需要再给提示。", "9，请检查一下", "答案是9；帮我核对一下；请不要再给我提示。", "答案是 −1/2，请批改一下。"])("consumes bounded check requests without scoring unrelated prose: %s", input => {
    const text = input.includes("−1/2") ? "−1/2" : "9", value = text === "9" ? 9 : -.5;
    expect(extractMathAnswer(number, input)).toEqual({kind:"answer",answer:{kind:"number",value},source:"host"});
    expect(extractMathAnswer(number, input, span(input,text))).toEqual({kind:"answer",answer:{kind:"number",value},source:"candidate"});
    expect(extractMathAnswer(number, input, {start:0,end:input.length,text:input}).kind).toBe("clarification");
  });
  it.each(["9。请检查，我最近很痛苦。", "9。请检查一下我的病情。", "9。请检查，也可能10。", "老师说9。请检查。", "9？请检查", "9,000，请检查", "9，请检查一下；请核对；请批改", "9。不要记成答案。", "答案是9。请检查。\n我的密码是9", "9kg，请检查。"])("does not widen the suffix grammar for %s", input => {
    expect(extractMathAnswer(number,input).kind).not.toBe("answer");
    expect(extractMathAnswer(number,input,span(input,"9")).kind).not.toBe("answer");
  });
  it("accepts only the exact original UTF-16 answer span and emits no source text", () => {
    const input = "  极限值为 −1/2。 ";
    const result = extractMathAnswer(number, input, span(input, "−1/2"));
    expect(result).toEqual({ kind: "answer", answer: { kind: "number", value: -.5 }, source: "candidate" });
    expect(JSON.stringify(result)).not.toMatch(/答案|text|start|end|−1\/2/);
  });
  it.each([
    "极限是9吗", "极限是不是9", "极限可能是9", "极限是9，也许不对", "老师说极限是9", "极限是9，我最近很痛苦", "极限是9或10", "可能9也可能10", "9或10", "答案是9，也可能10", "我先算9，再得到10", "2+7=9", "老师说答案是9", "“9”", "> 9",
    "答案是9，我最近很痛苦", "我的密码是9", "我今年9岁", "请解释9", "不要记成9", "答案是9\n其实10", "答案是9？", "答案是9吗",
    "我的最终答案是9吗", "我的最终答案是9或10", "老师说我的最终答案是9", "我的最终答案是9，我最近很痛苦", "我的最终答案是9。这是我的最终答案。不要记成答案。",
    "这次我改为9，这是我的密码", "我改为9，也可能10", "我改为9。这是我的最终答案。\n我需要支持",
  ])("does not promote a model-picked number from %s", input => {
    expect(extractMathAnswer(number, input).kind).not.toBe("answer");
    expect(extractMathAnswer(number, input, span(input, "9")).kind).not.toBe("answer");
  });
  it.each([
    { start: 3, end: 4, text: "10" }, { start: 0, end: 1, text: "9" }, { start: -1, end: 4, text: "9" },
    { start: 3.5, end: 4, text: "9" }, { start: 3, end: 4, text: "9", answer: 9 }, null,
  ])("rejects an invalid or unbounded model structure", candidate => {
    expect(extractMathAnswer(number, "答案是9", candidate)).toEqual({ kind: "clarification", reason: "invalid-candidate" });
  });
  it("matches before Unicode normalization and rejects stale candidate text", () => {
    expect(extractMathAnswer(number, "答案是−9", { start: 3, end: 5, text: "-9" }).kind).toBe("clarification");
    expect(extractMathAnswer(number, "答案是10", { start: 3, end: 4, text: "9" }).kind).toBe("clarification");
  });
});

describe("host-declared choice semantics", () => {
  it.each([["趋于零", 0], ["no-limit", 1], ["我选B", 1], ["选C", 2], ["选项A", 0], ["答案是第二项", 1], ["第3项", 2], ["I choose B", 1]])("maps %s to its bounded semantic index", (input, index) => {
    expect(extractMathAnswer(choices, input as string)).toEqual({ kind: "answer", answer: { kind: "choice", index }, source: "host" });
  });
  it("matches candidate text instead of trusting a supplied index", () => {
    const input = "我选no-limit";
    expect(extractMathAnswer(choices, input, span(input, "no-limit"))).toMatchObject({ kind: "answer", answer: { kind: "choice", index: 1 } });
    expect(extractMathAnswer(choices, input, { ...span(input, "no-limit"), index: 0 }).kind).toBe("clarification");
  });
  it.each(["A或B", "A/B", "第二项是别人的答案", "我猜B", "D", "8", "选A\n选B"])("does not guess a choice from %s", input => expect(extractMathAnswer(choices, input).kind).not.toBe("answer"));
  it("does not confuse literal numeric choices, letter labels or duplicate semantic IDs", () => {
    expect(extractMathAnswer({ kind: "choice", answer: "2", choices: ["2", "4", "6"] }, "2")).toMatchObject({ kind: "answer", answer: { index: 0 } });
    expect(extractMathAnswer({ kind: "choice", answer: "A", choices: ["B", "A"] }, "A")).toEqual({ kind: "clarification", reason: "ambiguous-choice" });
    expect(extractMathAnswer({ ...choices, choiceIds: ["same", "same", "other"] }, "A")).toEqual({ kind: "clarification", reason: "invalid-question" });
  });
});

describe("finite unit declarations", () => {
  const unitQuestion: AnswerExtractionQuestion = { ...number, units: [{ symbol: "m", factor: 1 }, { symbol: "cm", factor: .01 }, { symbol: "米", factor: 1 }, { symbol: "%", factor: .01 }] };
  it.each([["答案是900cm", 9], ["9 米", 9], ["1/2 m", .5], ["1e2cm", 1], ["50%", .5]])("uses only a declared conversion for %s", (input, value) => {
    expect(extractMathAnswer(unitQuestion, input as string)).toMatchObject({ kind: "answer", answer: { kind: "number", value } });
  });
  it.each(["9m", "9 米", "50%", "9kg"])("does not discard an undeclared unit %s", input => {
    expect(extractMathAnswer(number, input)).toEqual({ kind: "clarification", reason: "unit-not-declared" });
  });
  it("requires the candidate to include the whole declared-unit answer", () => {
    const input = "答案是900cm";
    expect(extractMathAnswer(unitQuestion, input, span(input, "900")).kind).toBe("clarification");
    expect(extractMathAnswer(unitQuestion, input, span(input, "900cm"))).toMatchObject({ kind: "answer", answer: { value: 9 } });
    expect(extractMathAnswer(unitQuestion, "9mm").kind).not.toBe("answer");
    expect(extractMathAnswer(unitQuestion,"答案是900cm。请检查。",span("答案是900cm。请检查。","900cm"))).toMatchObject({kind:"answer",answer:{value:9}});
    expect(extractMathAnswer(choices,"我选no-limit，帮我检查一下。",span("我选no-limit，帮我检查一下。","no-limit"))).toMatchObject({kind:"answer",answer:{index:1}});
  });
  it("rejects overflowing conversions and ambiguous scientific-prefix unit boundaries", () => {
    expect(extractMathAnswer({ ...number, units: [{ symbol: "km", factor: 1000 }] }, "1e12km").kind).not.toBe("answer");
    const units = [{ symbol: "m", factor: 1 }, { symbol: "e2m", factor: 10 }];
    for (const declared of [units, [...units].reverse()]) expect(extractMathAnswer({ ...number, units: declared }, "1e2m").kind).not.toBe("answer");
  });
  it.each([
    [{ symbol: "m", factor: NaN }], [{ symbol: "m", factor: Infinity }], [{ symbol: "m", factor: 0 }],
    [{ symbol: "m", factor: -1 }], [{ symbol: "m", factor: 1 }, { symbol: "m", factor: 2 }], [{ symbol: "e3", factor: 1 }],
    Array.from({ length: 17 }, (_, index) => ({ symbol: `u${index}`, factor: 1 })),
  ].map(units => [units] as const))("rejects invalid host unit declarations", units => expect(extractMathAnswer({ ...number, units }, "9m")).toEqual({ kind: "clarification", reason: "invalid-question" }));
});
