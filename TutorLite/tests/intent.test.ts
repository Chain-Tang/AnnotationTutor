import { describe, expect, it } from "vitest";
import { classifyIntent, extractAnnotationId } from "../src/intent.js";

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

describe("extractAnnotationId", () => {
  it("pulls and upper-cases an annotation id", () => {
    expect(extractAnnotationId("please open ann-20260608-002 now")).toBe(
      "ANN-20260608-002"
    );
    expect(extractAnnotationId("no id here")).toBe(null);
  });
});
