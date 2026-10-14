import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TeachingStreamV3, TeachingControlSchemaError, LEARNING_STREAM_LIMITS } from "../src/learning-stream-v3.js";
const control=z.object({type:z.enum(["none","answer"]),meta:z.unknown().optional()}).strict();
function fixture(options:Partial<ConstructorParameters<typeof TeachingStreamV3<z.infer<typeof control>>>[0]>={}){
  let shown="";const onControl=vi.fn(),onError=vi.fn();
  const stream=new TeachingStreamV3({validateControl:value=>control.parse(value),onControl,onReply:delta=>{shown+=delta;},onError,...options});
  return {stream,onControl,onError,shown:()=>shown};
}
describe("bounded v3 teaching stream",()=>{
  it("decodes only top-level reply at every possible chunk boundary",()=>{
    const reply='普通答复 😀 \"quoted\" \\ slash /\n次行\t';
    const raw=JSON.stringify({control:{type:"none",meta:{reply:"DO NOT SHOW",nested:[{reply:"SECRET"}],quote:'} \\\"reply\\\": \\\"LEAK\\\"'}},reply});
    for(let index=0;index<=raw.length;index++){
      const f=fixture();f.stream.push(raw.slice(0,index));f.stream.push(raw.slice(index));
      expect(f.stream.finish()).toEqual({control:JSON.parse(raw).control,reply});expect(f.shown()).toBe(reply);expect(f.onControl).toHaveBeenCalledOnce();
    }
  });
  it("handles escaped Unicode and structural string escapes one character at a time",()=>{
    const raw=' { "control" : {"type":"none","meta":{"reply":"hidden\\\"},[]"}} , "reply" : "\\u4f60\\u597d\\uD83D\\uDE00\\n\\\\\\\"" } \n';
    const f=fixture();for(const char of raw)f.stream.push(char);
    expect(f.stream.finish().reply).toBe('你好😀\n\\"');expect(f.shown()).toBe('你好😀\n\\"');
  });
  it("supports explicitly selected action-key compatibility without accepting mixed envelopes",()=>{
    const f=fixture({controlKey:"action"});f.stream.push('{"action":{"type":"none"},"reply":"ok"}');expect(f.stream.finish().control.type).toBe("none");expect(f.shown()).toBe("ok");
    const mixed=fixture({controlKey:"action"});expect(()=>mixed.stream.push('{"control":{"type":"none"},"reply":"no"}')).toThrow();expect(mixed.shown()).toBe("");
  });
  it.each([
    '{"reply":"leak","control":{"type":"none"}}',
    '{"control":{"type":"none"},"nested":{"reply":"leak"},"reply":"text"}',
    '{"control":{"type":"unknown","reply":"secret"},"reply":"text"}',
    '{"control":[{"type":"none"}],"reply":"text"}',
    '{"control":{"type":"answer","type":"none"},"reply":"text"}',
    '{"control":{"type":"none","meta":{"reply":"a","reply":"b"}},"reply":"text"}',
    '{"control":{"type":"none"},"reply":"text","reply":"more"}',
    '{"control":{"type":"none"},"reply":9}',
    '{"control":{"type":"none"},"reply":"text"} trailing',
    '```json\n{"control":{"type":"none"},"reply":"text"}\n```',
    '{"control":{"type":"none"},"reply":"bad\\q"}',
    '{"control":{"type":"none"},"reply":"bad\nline"}',
    '{"control":{"type":"none"},"reply":"\\ud800x"}',
    '{"control":{"type":"none"},"reply":"\\udc00"}',
  ])("rejects malformed or ambiguous control without exposing its contents: %s",raw=>{
    const f=fixture();expect(()=>{f.stream.push(raw);f.stream.finish();}).toThrow();expect(f.shown()).toBe("");expect(f.onError).toHaveBeenCalled();
  });
  it.each(['','{"control":','{"control":{"type":"none"},"reply":"incomplete','{"control":{"type":"none"},"reply":"\\u12'])
  ("rejects incomplete framing on finish: %s",raw=>{const f=fixture();f.stream.push(raw);expect(()=>f.stream.finish()).toThrow("incomplete");expect(f.onError).toHaveBeenCalledOnce();});
  it("bounds control size, depth, total input and decoded reply before displaying new fragments",()=>{
    const raws=[
      JSON.stringify({control:{type:"none",meta:"x".repeat(LEARNING_STREAM_LIMITS.maxControlChars)},reply:"hidden"}),
      '{"control":{"type":"none","meta":'+"[".repeat(33)+'0'+"]".repeat(33)+'},"reply":"hidden"}',
      " ".repeat(LEARNING_STREAM_LIMITS.maxEnvelopeChars+1),
      JSON.stringify({control:{type:"none"},reply:"x".repeat(LEARNING_STREAM_LIMITS.maxReplyChars+1)}),
    ];
    for(const raw of raws){const f=fixture();expect(()=>f.stream.push(raw)).toThrow();expect(f.shown()).toBe("");}
  });
  it("reports a malformed suffix instead of validating an already streamed candidate",()=>{
    const f=fixture();f.stream.push('{"control":{"type":"answer"},"reply":"already delivered');expect(f.shown()).toBe("already delivered");
    expect(()=>f.stream.push('","extra":"secret"}')).toThrow("extra-field");expect(()=>f.stream.finish()).toThrow();expect(f.shown()).toBe("already delivered");
  });
  it("rejects invalid limits and does not accept deltas after completion",()=>{
    expect(()=>fixture({limits:{maxDepth:100}})).toThrow("limit-invalid");
    const f=fixture();f.stream.push('{"control":{"type":"none"},"reply":""}');f.stream.finish();expect(()=>f.stream.push(" ")).toThrow("already-finished");
  });
  it("separates schema failure from consumer rejection without trusting message text",()=>{
    const raw=JSON.stringify({control:{type:"none"},reply:"PRIVATE_REPLY"});
    const schema=fixture({validateControl:()=>{throw new TeachingControlSchemaError("question-id");}});
    expect(()=>schema.stream.push(raw)).toThrow("teaching-control-schema-question-id");
    expect(schema.onControl).not.toHaveBeenCalled();expect(schema.shown()).toBe("");
    for(const thrown of [new Error("teaching-control-schema-question-id"),new TeachingControlSchemaError("question-id")]){
      const consumer=fixture({onControl:()=>{throw thrown;}});
      expect(()=>consumer.stream.push(raw)).toThrow("teaching-control-rejected");expect(consumer.shown()).toBe("");
    }
    const forged=fixture({validateControl:()=>{throw new Error("teaching-control-schema-question-id");}});
    expect(()=>forged.stream.push(raw)).toThrow("teaching-control-rejected");
  });

});
