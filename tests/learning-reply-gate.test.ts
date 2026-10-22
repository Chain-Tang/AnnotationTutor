import { describe, expect, it, vi } from "vitest";
import { LearningReplyGate, LearningReplyGateError, type LearningPresentationObservation, type LearningReplyPlan, type LearningReplyPresenter } from "../src/learning-reply-gate.js";
import { TeachingStreamV3 } from "../src/learning-stream-v3.js";
type Ticket={presentationId:string;helpId:string};
const deferred=<T=void>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(options:{mode?:"stream"|"buffer"|"suppress";help?:boolean;before?:()=>Promise<void>;confirm?:()=>Promise<void>;presenter?:LearningReplyPresenter;maxBufferedChars?:number}={}){
  const abort=new AbortController(),presentationId=crypto.randomUUID(),ticket={presentationId,helpId:crypto.randomUUID()},events:string[]=[];
  let stored:"absent"|"prepared"|"provided"|"unknown"="absent",shown="";
  const beforeHelp=vi.fn(async()=>{await options.before?.();stored="prepared";events.push("prepared");return ticket;});
  const confirmPresentation=vi.fn(async(_ticket:Ticket,observation:LearningPresentationObservation)=>{events.push(`confirm:${observation.state}`);await options.confirm?.();stored=observation.state;});
  const presenter=options.presenter??{present:vi.fn(({text,presentationId})=>{shown+=text;events.push(`show:${text}`);return {state:"provided" as const,presentationId};})};
  const gate=new LearningReplyGate<string,Ticket>({signal:abort.signal,presenter,maxBufferedChars:options.maxBufferedChars,plan:()=>({mode:options.mode??"stream",presentationId,...(options.help===false?{}:{help:{beforeHelp,confirmPresentation}})})});
  gate.acceptControl("none");return {gate,abort,presentationId,ticket,events,beforeHelp,confirmPresentation,presenter,shown:()=>shown,stored:()=>stored};
}
describe("persistent learning reply gate",()=>{
  it("does not provide any help until preparation has durably completed",async()=>{
    const wait=deferred(),f=fixture({before:()=>wait.promise});f.gate.enqueue("first");f.gate.enqueue(" second");await Promise.resolve();
    expect(f.shown()).toBe("");expect(f.stored()).toBe("absent");wait.resolve();const outcome=await f.gate.finish();
    expect(f.shown()).toBe("first second");expect(f.events).toEqual(["prepared","show:first second","confirm:provided"]);expect(outcome).toMatchObject({prepared:true,state:"provided",confirmed:"provided"});
  });
  it("buffers grading-related replies until the host validates the entire envelope",async()=>{
    const f=fixture({mode:"buffer"});f.gate.enqueue("feedback");await Promise.resolve();expect(f.beforeHelp).not.toHaveBeenCalled();expect(f.shown()).toBe("");
    await f.gate.finish();expect(f.shown()).toBe("feedback");expect(f.beforeHelp).toHaveBeenCalledOnce();
  });
  it("suppresses model-written canonical hints/solutions without preparing or presenting them",async()=>{
    const f=fixture({mode:"suppress"});f.gate.enqueue("untrusted solution");expect(await f.gate.finish()).toMatchObject({prepared:false,state:"unknown",offeredChars:0});expect(f.beforeHelp).not.toHaveBeenCalled();expect(f.shown()).toBe("");
  });
  it("does not prepare help for an empty reply or a host-confirmed unrelated question",async()=>{
    const empty=fixture();await empty.gate.finish();expect(empty.beforeHelp).not.toHaveBeenCalled();
    const unrelated=fixture({help:false});unrelated.gate.enqueue("shortcut answer");await unrelated.gate.finish();expect(unrelated.shown()).toBe("shortcut answer");expect(unrelated.beforeHelp).not.toHaveBeenCalled();
  });
  it("stops before display when beforeHelp cannot confirm persistence",async()=>{
    const f=fixture({before:async()=>{throw new Error("PRIVATE IO failure");}});f.gate.enqueue("solution");
    await expect(f.gate.finish()).rejects.toMatchObject({code:"learning-reply-preparation-not-confirmed",outcome:{prepared:false,preparation:"unknown",offeredChars:0}});
    expect(f.shown()).toBe("");expect(f.confirmPresentation).not.toHaveBeenCalled();expect(f.beforeHelp).toHaveBeenCalledOnce();
  });
  it("keeps prepared help as unknown if cancelled before the first fragment",async()=>{
    const wait=deferred(),f=fixture({before:()=>wait.promise});f.gate.enqueue("solution");await Promise.resolve();f.abort.abort();wait.resolve();
    await expect(f.gate.finish()).rejects.toMatchObject({name:"AbortError",outcome:{prepared:true,state:"unknown",confirmed:"unknown"}});
    expect(f.shown()).toBe("");expect(f.stored()).toBe("unknown");expect(f.events).toEqual(["prepared","confirm:unknown"]);
  });
  it("does not erase help or repeat a fragment after its presentation confirmation fails",async()=>{
    const f=fixture({confirm:async()=>{throw new Error("storage closed");}});f.gate.enqueue("answer");
    const first=f.gate.finish();await expect(first).rejects.toMatchObject({code:"learning-reply-confirmation-not-confirmed",outcome:{prepared:true,state:"provided",confirmed:"none"}});
    expect(f.shown()).toBe("answer");expect(f.stored()).toBe("prepared");expect(f.gate.finish()).toBe(first);
    expect(()=>f.gate.enqueue("answer again")).toThrow();expect(f.beforeHelp).toHaveBeenCalledOnce();expect(f.confirmPresentation).toHaveBeenCalledOnce();
  });
  it("stops the remaining buffered fragments on first confirmation failure",async()=>{
    const f=fixture({confirm:async()=>{throw new Error("confirmation unavailable");}});f.gate.enqueue("a".repeat(4096));
    await expect(f.gate.finish()).rejects.toMatchObject({outcome:{prepared:true,state:"provided",offeredChars:2048}});
    expect(f.shown()).toBe("a".repeat(2048));expect(f.beforeHelp).toHaveBeenCalledOnce();expect(f.confirmPresentation).toHaveBeenCalledOnce();
  });
  it("prepares once across separately streamed chunks and never weakens provided to unknown",async()=>{
    let calls=0;const f=fixture({presenter:{present:({presentationId})=>({state:++calls===1?"provided":"unknown",presentationId}),complete:({presentationId})=>({state:"unknown",presentationId})}});
    f.gate.enqueue("first");await vi.waitFor(()=>expect(f.confirmPresentation).toHaveBeenCalledOnce());
    f.gate.enqueue("second");await f.gate.finish();expect(f.beforeHelp).toHaveBeenCalledOnce();expect(f.confirmPresentation).toHaveBeenCalledOnce();expect(f.stored()).toBe("provided");
  });
  it("confirms an observed first fragment after generation cancellation and never provides the next one",async()=>{
    const observation=deferred<LearningPresentationObservation>();let shown="";
    const present=vi.fn(({text}:{text:string})=>{shown+=text;return observation.promise;});
    const f=fixture({presenter:{present}});f.gate.enqueue("first");
    await vi.waitFor(()=>expect(present).toHaveBeenCalledOnce());f.gate.enqueue("second");f.abort.abort();observation.resolve({state:"provided",presentationId:f.presentationId});
    await expect(f.gate.finish()).rejects.toMatchObject({outcome:{prepared:true,state:"provided",confirmed:"provided"}});expect(shown).toBe("first");expect(f.stored()).toBe("provided");
  });
  it("treats annotation no-op streaming as unknown, and confirms only its successful append",async()=>{
    const noop=fixture({mode:"buffer",presenter:{present:()=>{}}});noop.gate.enqueue("answer");await noop.gate.finish();expect(noop.stored()).toBe("unknown");
    const appended:string[]=[];let buffered="";
    const annotation=fixture({mode:"buffer",presenter:{present:({text})=>{buffered+=text;},complete:async({presentationId})=>{appended.push(buffered);return {state:"provided",presentationId};}}});
    annotation.gate.enqueue("answer");await annotation.gate.finish();expect(appended).toEqual(["answer"]);expect(annotation.events).toEqual(["prepared","confirm:unknown","confirm:provided"]);
  });
  it("keeps unknown when annotation append fails, and confirms a late durable append despite cancellation",async()=>{
    const failed=fixture({mode:"buffer",presenter:{present:()=>{},complete:async()=>{throw new Error("annotation deleted");}}});failed.gate.enqueue("answer");await expect(failed.gate.finish()).rejects.toThrow();expect(failed.stored()).toBe("unknown");
    const append=deferred<LearningPresentationObservation>(),complete=vi.fn(()=>append.promise),late=fixture({mode:"buffer",presenter:{present:()=>{},complete}});
    late.gate.enqueue("answer");const finishing=late.gate.finish();const rejection=expect(finishing).rejects.toMatchObject({outcome:{state:"provided",confirmed:"provided"}});
    await vi.waitFor(()=>expect(complete).toHaveBeenCalledOnce());late.abort.abort();append.resolve({state:"provided",presentationId:late.presentationId});await rejection;expect(late.stored()).toBe("provided");
  });
  it("retains unknown on a presenter failure or mismatched presentation receipt",async()=>{
    for(const present of [()=>{throw new Error("closed");},()=>({state:"provided" as const,presentationId:"another"})]){
      const f=fixture({presenter:{present}});f.gate.enqueue("answer");await expect(f.gate.finish()).rejects.toBeInstanceOf(LearningReplyGateError);expect(f.stored()).toBe("unknown");expect(f.gate.status().state).toBe("unknown");
    }
  });
  it("bounds input while preparation is blocked without re-preparing or leaking queued help",async()=>{
    const wait=deferred(),f=fixture({maxBufferedChars:8,before:()=>wait.promise});f.gate.enqueue("12345678");await Promise.resolve();
    expect(()=>f.gate.enqueue("9")).toThrow("buffer-exceeded");wait.resolve();await expect(f.gate.finish()).rejects.toMatchObject({code:"learning-reply-buffer-exceeded"});
    expect(f.shown()).toBe("");expect(f.stored()).toBe("unknown");expect(f.beforeHelp).toHaveBeenCalledOnce();
  });
  it("aborts a buffered action on a malformed JSON suffix without committing its preparation",async()=>{
    const abort=new AbortController(),beforeHelp=vi.fn(),presentationId=crypto.randomUUID();
    const gate=new LearningReplyGate<string>({signal:abort.signal,presenter:{present:()=>{}},plan:()=>({mode:"buffer",presentationId,help:{beforeHelp,confirmPresentation:vi.fn()}})});
    const stream=new TeachingStreamV3({validateControl:()=>"answer",onControl:control=>gate.acceptControl(control),onReply:delta=>gate.enqueue(delta),onError:error=>gate.abort(error)});
    stream.push('{"control":{"type":"answer"},"reply":"feedback');expect(()=>stream.finish()).toThrow("incomplete");await expect(gate.finish()).rejects.toThrow("aborted");expect(beforeHelp).not.toHaveBeenCalled();
  });
  it("requires matching prepared identity and accepts no second control plan",async()=>{
    const abort=new AbortController(),confirmPresentation=vi.fn(),plan:LearningReplyPlan<Ticket>={mode:"stream",presentationId:"fixed",help:{beforeHelp:async()=>({presentationId:"other",helpId:"help"}),confirmPresentation}};
    const gate=new LearningReplyGate({signal:abort.signal,presenter:{present:vi.fn()},plan:()=>plan});gate.acceptControl("none");gate.enqueue("reply");await expect(gate.finish()).rejects.toThrow("prepared-identity-mismatch");expect(confirmPresentation).not.toHaveBeenCalled();
    const f=fixture();expect(()=>f.gate.acceptControl("another")).toThrow("control-repeated");await expect(f.gate.finish()).rejects.toThrow();
  });
});
