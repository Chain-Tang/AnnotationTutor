// The chat's first-layer intent recognition: before a message is sent to the
// agent, classify what the learner actually wants so the chat can route it —
// answer a question (ask), propose an edit to the note (write), or find and jump
// to an annotation (locate). Pure and bilingual (English + Chinese) so it is
// unit-tested and runs instantly with no model call.

export type ChatIntent = "ask" | "write" | "locate";

const ANN_ID = /\bANN-\d{8}-\d{3}\b/i;

// Editing the note: rewrite/polish/add a table/draw a diagram, etc.
const WRITE_EN =
  /\b(re-?write|rewrites?|polish|edit|revis(?:e|ing)|improve|refine|reword|rephrase|expand|shorten|condense|proofread|fix (?:the )?(?:grammar|wording|typos?)|add (?:a |an )?(?:table|code(?: ?block)?|mermaid|diagram|section|paragraph|example)|insert|draw (?:a |an )?(?:mermaid|diagram|chart|table|flowchart)|turn (?:this|it) into|format (?:this|it) as|make (?:it|this) (?:better|clearer|more)|help me write)\b/i;
const WRITE_ZH =
  /(改写|润色|修改|编辑|重写|改一下|帮我写|帮我改|补充|扩写|续写|精简|缩写|优化(?:一下)?(?:文字|表达|措辞|语言)?|添加|插入|画(?:一个|一张)?(?:表格|图|流程图|示意图|mermaid)|做(?:一个|一张)?表格|生成(?:表格|代码|图表|mermaid)|整理成|改成)/;

// Finding/opening a specific annotation.
const LOCATE_EN =
  /\b(find|locate|jump to|go to|open|show me|where is|which)\b[^.?!]*\b(annotation|note|highlight|card)\b/i;
const LOCATE_ZH =
  /(定位|跳转|跳到|找到|找一下|哪条|哪一条|哪个标注|查看(?:标注|注释|批注)|定位到|打开.*?(?:标注|批注|注释))/;

/** Pull a fully-formed annotation id (ANN-YYYYMMDD-NNN) out of the text, if any. */
export function extractAnnotationId(text: string): string | null {
  const match = ANN_ID.exec(text);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Classify a chat message. Write intent wins over locate (the end goal is the
 * edit), and an explicit annotation id or a "find … annotation" phrase signals
 * locate; everything else is a plain question.
 */
export function classifyIntent(text: string): ChatIntent {
  const trimmed = text.trim();
  if (!trimmed) return "ask";
  if (WRITE_EN.test(trimmed) || WRITE_ZH.test(trimmed)) return "write";
  if (
    LOCATE_EN.test(trimmed) ||
    LOCATE_ZH.test(trimmed) ||
    ANN_ID.test(trimmed)
  ) {
    return "locate";
  }
  return "ask";
}
