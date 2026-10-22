import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({spawn:vi.fn(),kill:vi.fn()}));
vi.mock("node:child_process",async importOriginal=>({...await importOriginal<typeof import("node:child_process")>(),spawn:mocks.spawn}));
vi.mock("../src/process-tree.js",()=>({killProcessTree:mocks.kill}));
import { runAcpReview } from "../src/acp-runner.js";
const options={command:"synthetic-acp",model:"",prompt:"Synthetic question",timeoutMs:1000};
function child(){
  const process=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  mocks.spawn.mockReturnValue(process);return process;
}
beforeEach(()=>{mocks.spawn.mockReset();mocks.kill.mockReset();});
describe("one-shot ACP cancellation",()=>{
  it("does not spawn for a pre-aborted signal",async()=>{
    const abort=new AbortController();abort.abort();
    expect(await runAcpReview({...options,signal:abort.signal})).toMatchObject({ok:false,cancelled:true,reviewText:""});expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("kills the process tree and detaches the signal while discarding late output",async()=>{
    const process=child(),abort=new AbortController(),remove=vi.spyOn(abort.signal,"removeEventListener");
    const result=runAcpReview({...options,signal:abort.signal});abort.abort();
    expect(await result).toMatchObject({ok:false,cancelled:true,error:"cancelled",reviewText:""});
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(process as unknown as ChildProcessWithoutNullStreams);
    expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
    process.stdout.write(JSON.stringify({method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"late paid output"}}}})+"\n");
    process.emit("close");expect(mocks.kill).toHaveBeenCalledTimes(1);
  });
  it("completion removes the abort listener so a late cancellation cannot kill twice",async()=>{
    const process=child(),abort=new AbortController(),remove=vi.spyOn(abort.signal,"removeEventListener");
    const result=runAcpReview({...options,signal:abort.signal});
    process.stdout.write(JSON.stringify({id:1,result:{}})+"\n");
    process.stdout.write(JSON.stringify({id:2,result:{sessionId:"synthetic-session"}})+"\n");
    process.stdout.write(JSON.stringify({method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Synthetic answer"}}}})+"\n");
    process.stdout.write(JSON.stringify({id:3,result:{stopReason:"end_turn"}})+"\n");
    expect(await result).toMatchObject({ok:true,reviewText:"Synthetic answer"});expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
    abort.abort();expect(mocks.kill).toHaveBeenCalledTimes(1);
  });
});
