import { canonicalMathAnswer, parseMathValue, type AnswerQuestion, type MathAnswer } from "./learning-answer.js";

export const ANSWER_EXTRACTION_LIMITS = Object.freeze({ input: 512, atom: 128, choices: 8, choiceId: 32, units: 16, unitSymbol: 16 });
/** Host declarations only. A factor converts a displayed unit to the question's
 * canonical unit; affine conversions and arbitrary expressions are unsupported. */
export type AnswerExtractionQuestion = AnswerQuestion & {
  choiceIds?: readonly string[];
  units?: readonly { symbol: string; factor: number }[];
};
/** Offsets refer to the current input's UTF-16 code units, before normalization. */
export type AnswerCandidateSpan = { start: number; end: number; text: string };
export type AnswerExtraction =
  | { kind: "answer"; answer: MathAnswer; source: "host" | "candidate" }
  | { kind: "clarification"; reason: "input-too-long" | "invalid-question" | "invalid-candidate" | "contextual-or-ambiguous" | "invalid-value" | "unit-not-declared" | "ambiguous-choice" }
  | { kind: "not-an-answer"; reason: "empty" | "explanation-question" | "unsupported-form" };

const clarification = (reason: Extract<AnswerExtraction, { kind: "clarification" }>["reason"]): AnswerExtraction => ({ kind: "clarification", reason });
const choiceId = /^[a-z][a-z0-9_-]{0,31}$/i;
const unitSymbol = /^[\p{L}µμ°%][\p{L}\p{N}µμ°%/^·⋅−⁻²³-]{0,15}$/u;
// Consume only these short request clauses, never arbitrary prose after an
// answer. A model-picked span cannot make a private or ambiguous suffix safe.
const checkRequest = /^(?:请(?:帮我)?(?:检查|核对|批改)(?:一下)?|帮我(?:检查|核对)(?:一下)?|(?:请)?(?:不需要|不用|不要)(?:再)?(?:给(?:我)?)?提示)$/;
const answerConfirmation = /^(?:这是我的最终答案|这是我的答案|这是最终答案)$/;
// Final mathematical trend statements are ordinary answers in this course.
// Keep a bounded whole-utterance grammar: never search arbitrary prose for a
// number, and never treat the approaching input x as the requested output.
const trendPrefix = /^(?:(?:(?:附近|周围)(?:的)?(?:读数|数值|函数值|输出值)|读数|函数值|输出值|它|其值)?\s*(?:趋向|趋于|接近|逼近)|(?:the\s+(?:nearby\s+)?(?:readings?|function\s+values?|output)|it)\s+(?:tends?\s+to|approach(?:es)?))\s*/i;

function validQuestion(question: AnswerExtractionQuestion): boolean {
  if (!question || !["number", "choice", "explanation"].includes(question.kind)) return false;
  if (question.kind === "choice") {
    const choices = question.choices;
    if (!Array.isArray(choices) || !choices.length || choices.length > ANSWER_EXTRACTION_LIMITS.choices ||
      choices.some(text => typeof text !== "string" || !text.trim() || text !== text.trim() || text.length > ANSWER_EXTRACTION_LIMITS.atom || /[\r\n]/.test(text)) || new Set(choices).size !== choices.length) return false;
    if (question.choiceIds !== undefined && (!Array.isArray(question.choiceIds) || question.choiceIds.length !== choices.length ||
      question.choiceIds.some(id => typeof id !== "string" || !choiceId.test(id)) || new Set(question.choiceIds).size !== question.choiceIds.length)) return false;
  } else if (question.choiceIds !== undefined) return false;
  if (question.units !== undefined) {
    if (question.kind !== "number" || !Array.isArray(question.units) || question.units.length > ANSWER_EXTRACTION_LIMITS.units ||
      question.units.some(unit => !unit || typeof unit.symbol !== "string" || !unitSymbol.test(unit.symbol) || parseMathValue(`1${unit.symbol}`) !== undefined ||
        typeof unit.factor !== "number" || !Number.isFinite(unit.factor) || unit.factor < 1e-12 || unit.factor > 1e12) ||
      new Set(question.units.map(unit => unit.symbol)).size !== question.units.length) return false;
  }
  return true;
}

/** A small whole-utterance grammar, not a classifier for arbitrary natural
 * language. In particular it never searches a sentence for its first number. */
function answerAtom(input: string, numeric: boolean): { text: string; start: number; end: number; explicit: boolean } {
  const startTrimmed = input.trimStart(), leading = input.length - startTrimmed.length;
  const trimmed = startTrimmed.trimEnd();
  const prefix = /^(?:(?:我的|我这次的|这次我的)?(?:最终)?答案(?:是|为|[:：])|(?:这次)?我改为|这次改为|极限(?:值)?(?:是|为|等于|[:：])|(?:计算)?结果(?:是|为|等于|[:：])|我选择|我选|选择|选(?!项)|the (?:answer|limit|result) is\b|answer\s*[:：]|i choose\b)\s*/i.exec(trimmed)
    ?? (numeric ? trendPrefix.exec(trimmed) : null);
  const start = leading + (prefix?.[0].length ?? 0), body = input.slice(start, leading + trimmed.length);
  const clauses = body.split(/[。；;，,]/).map(text => text.trim());
  if (clauses.at(-1) === "") clauses.pop();
  // At most two check/no-hint or explicit answer-confirmation clauses. The
  // numeric/choice atom still has to parse in full (including any declared
  // unit), and semantic classification plus a current lease remains required.
  if (clauses.length >= 2 && clauses.length <= 3 && clauses.slice(1).every(text => checkRequest.test(text)||answerConfirmation.test(text))) {
    const atom = body.slice(0, body.search(/[。；;，,]/)).trimEnd();
    return { text: atom, start, end: start + atom.length, explicit: !!prefix };
  }
  // A Chinese full stop is prose punctuation. Never discard ?, !, percent,
  // quotes or unit characters, all of which can change the mathematical claim.
  const atom = (body.endsWith("。") ? body.slice(0, -1) : body).trimEnd();
  return { text: atom, start, end: start + atom.length, explicit: !!prefix };
}

function matchesCandidate(input: string, atom: ReturnType<typeof answerAtom>, candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Partial<AnswerCandidateSpan>;
  return Object.keys(value).length === 3 && Object.keys(value).every(key => ["start", "end", "text"].includes(key)) &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && typeof value.text === "string" &&
    value.text.length > 0 && value.text.length <= ANSWER_EXTRACTION_LIMITS.atom &&
    value.start === atom.start && value.end === atom.end && input.slice(value.start, value.end) === value.text && value.text === atom.text;
}

function numericAnswer(question: AnswerExtractionQuestion, text: string): MathAnswer | "ambiguous" | undefined {
  const bare = canonicalMathAnswer(question, text);
  if (bare) return bare;
  const values = new Set<number>();
  for (const unit of question.units ?? []) {
    if (!text.endsWith(unit.symbol)) continue;
    const value = parseMathValue(text.slice(0, -unit.symbol.length));
    if (value === undefined) continue;
    const answer = canonicalMathAnswer(question, String(value * unit.factor));
    if (answer?.kind !== "number") return undefined;
    values.add(answer.value);
  }
  if (values.size > 1) return "ambiguous";
  if (values.size === 1) return canonicalMathAnswer(question, String([...values][0]));
}

function choiceAnswer(question: AnswerExtractionQuestion, text: string): MathAnswer | "ambiguous" | undefined {
  const indices = new Set<number>(), choices = question.choices!;
  const literal = canonicalMathAnswer(question, text);
  if (literal?.kind === "choice") indices.add(literal.index);
  const semantic = question.choiceIds?.indexOf(text) ?? -1;
  if (semantic >= 0) indices.add(semantic);
  const letter = /^(?:选项\s*|option\s+)?([A-H])$/i.exec(text);
  if (letter) indices.add(letter[1]!.toUpperCase().charCodeAt(0) - 65);
  const ordinal = /^第([1-8一二三四五六七八])(?:项|个选项)$/.exec(text);
  if (ordinal) indices.add(/[1-8]/.test(ordinal[1]!) ? Number(ordinal[1]) - 1 : "一二三四五六七八".indexOf(ordinal[1]!));
  const available = [...indices].filter(index => index < choices.length);
  if (available.length > 1) return "ambiguous";
  return available.length === 1 ? canonicalMathAnswer(question, choices[available[0]!]!) : undefined;
}

/** Extraction is not consent, turn classification or grading. The host must
 * still bind the active question/request and decide whether this turn is a
 * learner answer. This codec emits no original text or candidate text, and
 * does not assert that a model understands private or ambiguous free prose. */
export function extractMathAnswer(question: AnswerExtractionQuestion, input: string, candidate?: unknown): AnswerExtraction {
  if (typeof input !== "string" || input.length > ANSWER_EXTRACTION_LIMITS.input) return clarification("input-too-long");
  if (!validQuestion(question)) return clarification("invalid-question");
  if (!input.trim()) return { kind: "not-an-answer", reason: "empty" };
  if (question.kind === "explanation") return { kind: "not-an-answer", reason: "explanation-question" };
  const atom = answerAtom(input, question.kind === "number");
  if (candidate !== undefined && !matchesCandidate(input, atom, candidate)) return clarification("invalid-candidate");
  if (!atom.text || atom.text.length > ANSWER_EXTRACTION_LIMITS.atom || /[\r\n]/.test(atom.text)) return clarification("contextual-or-ambiguous");
  const answer = question.kind === "number" ? numericAnswer(question, atom.text) : choiceAnswer(question, atom.text);
  if (answer === "ambiguous") return clarification(question.kind === "choice" ? "ambiguous-choice" : "contextual-or-ambiguous");
  if (answer) return { kind: "answer", answer, source: candidate === undefined ? "host" : "candidate" };
  // Distinguish a simple undeclared unit from invalid arithmetic without
  // extracting a number for scoring. The entire suffix must be unit-shaped.
  if (question.kind === "number" && /^(.{1,64}?)\s*([\p{L}µμ°%][\p{L}\p{N}µμ°%/^·⋅−⁻²³-]{0,15})$/u.test(atom.text)) {
    const split = /^(.{1,64}?)\s*([\p{L}µμ°%][\p{L}\p{N}µμ°%/^·⋅−⁻²³-]{0,15})$/u.exec(atom.text)!;
    if (parseMathValue(split[1]!) !== undefined) return clarification("unit-not-declared");
  }
  if (atom.explicit || candidate !== undefined || /[\d−+\-/]/.test(atom.text)) return clarification(question.kind === "number" && /^[\d.eE−+\-/\s]+$/.test(atom.text) ? "invalid-value" : "contextual-or-ambiguous");
  return { kind: "not-an-answer", reason: "unsupported-form" };
}
