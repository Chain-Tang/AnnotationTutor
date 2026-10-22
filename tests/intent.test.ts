import { describe, expect, it } from "vitest";
import { classifyIntent, extractAnnotationId, requestsDocumentEdit } from "../src/intent.js";

describe("classifyIntent", () => {
  it("treats plain questions as ask", () => {
    expect(classifyIntent("What is the paranoid-schizoid position?")).toBe("ask");
    expect(classifyIntent("这段话是什么意思？")).toBe("ask");
    expect(classifyIntent("")).toBe("ask");
  });

  it("detects edit/write requests in English and Chinese", () => {
    expect(classifyIntent("Polish this paragraph for me")).toBe("write");
    expect(classifyIntent("rewrite the selection to be clearer")).toBe("write");
    expect(classifyIntent("add a table summarizing the defenses")).toBe("write");
    expect(classifyIntent("draw a mermaid diagram of the process")).toBe("write");
    expect(classifyIntent("帮我润色这段文字")).toBe("write");
    expect(classifyIntent("把这段改写得更清楚")).toBe("write");
    expect(classifyIntent("插入一个表格")).toBe("write");
  });

  it.each([
    '原函数f(x)=x²在2处连续。如果仅改成f(2)=7而其他点不变，会破坏连续性吗？',
    '如果修改这个孤立点，会改变附近的极限吗？请解释，不修改正文。',
    '为什么要把函数值改成极限值才能连续？',
    '我想知道“改写这段”是什么意思，不要实际修改。',
    '不要润色原文，直接解释概念。',
    'If we edit f(2) to be 7, does the limit change?',
    'Explain why changing a single point can break continuity.',
    'What happens if we rewrite the formula?',
    'Please do not rewrite the paragraph. Explain it instead.',
  ])('keeps a discussion or negated edit in conversation: %s',text=>expect(classifyIntent(text)).toBe('ask'));

  it.each([
    '请帮我润色这段文字', '请把这段改成更易读的解释', '将正文整理成表格',
    '帮我把选中的文字改写得简洁一些', '能不能帮我修改这段？',
    '这句不够清楚；请改写这段文字', 'Could you rewrite this paragraph?',
    'Please edit the selected paragraph', 'find the annotation and rewrite it',
  ])('retains directed edit proposals: %s',text=>expect(classifyIntent(text)).toBe('write'));

  it("detects locate requests and bare annotation ids", () => {
    expect(classifyIntent("find the annotation about projection")).toBe("locate");
    expect(classifyIntent("jump to ANN-20260608-002")).toBe("locate");
    expect(classifyIntent("open ANN-20260608-002")).toBe("locate");
    expect(classifyIntent("ANN-20260609-001")).toBe("locate");
    expect(classifyIntent("定位到关于投射的标注")).toBe("locate");
    expect(classifyIntent("哪条标注讲了客体关系？")).toBe("locate");
  });

  it("prefers write when a message asks to both find and edit", () => {
    expect(
      classifyIntent("find the annotation about projection and rewrite it")
    ).toBe("write");
  });
});

describe('document requests versus mention or negation',()=>{
  it.each([
    '请画一个示意图表示极限。请在本页空白处画，不修改正文。',
    '请画极限图，不改写原文。',
    'Draw a curve, do not edit the note.',
    'Please draw a diagram. Do not rewrite the paragraph.',
    '原函数连续，如果改成f(2)=7会怎么样？',
    '这篇文章在讨论修改正文是什么意思，请解释。',
  ])('does not request a document edit: %s',text=>expect(requestsDocumentEdit(text)).toBe(false));
  it.each(['Insert a diagram into the note','请向正文插入表格','请把这段改写得清楚些','Draw a Mermaid diagram','请生成一个表格','rewrite this for me'])('keeps a real document proposal: %s',text=>expect(requestsDocumentEdit(text)).toBe(true));
});

describe("extractAnnotationId", () => {
  it("pulls and upper-cases an annotation id", () => {
    expect(extractAnnotationId("please open ann-20260608-002 now")).toBe(
      "ANN-20260608-002"
    );
    expect(extractAnnotationId("no id here")).toBe(null);
  });
});
