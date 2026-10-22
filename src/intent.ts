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
  /(改写|润色|修改|编辑|重写|改一下|帮我写|帮我改|补充|扩写|续写|精简|缩写|优化(?:一下)?(?:文字|表达|措辞|语言)?|添加|插入|画(?:一个|一张)?(?:表格|图|流程图|示意图|mermaid)|做(?:一个|一张)?表格|生成\s*(?:一个|一份|一张)?\s*(?:表格|代码|图表|mermaid)|整理成|改成)/i;

// Mentioning a change in an explanation/conditional is not asking the host to
// edit the document. Recognize a directed request, not an arbitrary occurrence
// of an editing verb. This local proposal heuristic never executes a drawing;
// drawing requests still pass through semantic preparation before any tool.
const EDIT_REQUEST_EN=/^(?:(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:help\s+me\s+)?)?(?:re-?write|polish|edit|revise|improve|refine|reword|rephrase|expand|shorten|condense|proofread|fix|add|insert|draw|turn|format|make)\b/i;
const EDIT_REQUEST_ZH=/^(?:(?:请(?:你)?|麻烦(?:你)?|能不能|可以|能)?(?:帮我|替我)?\s*)(?:改写|润色|修改|编辑|重写|改一下|写|改|补充|扩写|续写|精简|缩写|优化|添加|插入|画|做|生成|整理成)/;
const EDIT_TARGET_ZH=/^(?:请(?:你)?|麻烦(?:你)?|能不能|可以|能)?(?:帮我|替我)?(?:把|将)(?:这段|这句|这篇|这些|这份|选中|选区|正文|笔记|原文|段落|文章|文字|内容|标注|批注)[^。！？；\n]{0,48}(?:改写|润色|修改|编辑|重写|改成|补充|精简|整理成|添加|插入)/;
const EDIT_LOCATION_ZH=/^(?:请(?:你)?|麻烦(?:你)?)?(?:帮我|替我)?(?:向|往|在)(?:当前|这份|选中的)?(?:正文|笔记|段落|原文|选区)(?:中|里|内)?\s*(?:插入|添加|写入|编辑|修改|改写|润色)/;
function requestedEditClauses(text:string):string[] {
  const clauses=text.split(/[。！？；;，,\n]|(?<!\d)[.!?](?!\d)|\band\s+(?:then\s+)?/iu);
  return clauses.filter(clause=>{
    const value=clause.trim();
    return WRITE_EN.test(value)&&EDIT_REQUEST_EN.test(value)||WRITE_ZH.test(value)&&(EDIT_REQUEST_ZH.test(value)||EDIT_TARGET_ZH.test(value)||EDIT_LOCATION_ZH.test(value));
  });
}

/** A document proposal needs its target/format in a directed request clause.
 * A trailing negation such as "do not modify the note" is not that request.
 * This chooses a proposal protocol, not permission to modify or draw. */
export function requestsDocumentEdit(text:string):boolean {
  return requestedEditClauses(text).some(clause=>{
    // "Edit the canvas text" names the drawing, not the source document.
    if(/(?:画板|畫板|示意图|示意圖|\b(?:canvas|board|studio|diagram)\b)/i.test(clause)&&
      !/(?:正文|笔记|筆記|markdown|mermaid|表格|段落|文章|原文|\b(?:note|paragraph|table|section)\b)/i.test(clause))return false;
    return (
    /(正文|笔记|筆記|markdown|mermaid|表格|段落|文章|文字|选区|原文|这段|这句|\b(?:note|paragraph|table|section|selection|text)\b)/i.test(clause)||
    /(改写|改寫|润色|潤色|重写|重寫|\b(?:rewrite|polish|rephrase|proofread)\b)/i.test(clause));
  });
}

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
  if (requestedEditClauses(trimmed).length) return "write";
  if (
    LOCATE_EN.test(trimmed) ||
    LOCATE_ZH.test(trimmed) ||
    ANN_ID.test(trimmed)
  ) {
    return "locate";
  }
  return "ask";
}
