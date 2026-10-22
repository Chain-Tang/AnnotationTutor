import { describe, expect, it, vi } from "vitest";
import { TutorConversation, tutorRouteForText, type TutorRunnerInput, type TutorBoardRunner, type TutorBoardRunInput } from "../src/tutor-conversation.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import type { ChatLog } from "../src/model.js";
import { ImageContentRefusal } from "../src/board-image-error.js";
import { SurfaceCommitError, type SurfaceCommitReceipt } from "../src/tutor-surface.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function board(id: string, run: TutorBoardRunner["run"], canAuto = true): TutorBoardRunner {
  return { id, sourcePath: `${id}.md`, run, canAuto: () => canAuto };
}
function drawingReceipt(requestId:string,durability:SurfaceCommitReceipt["durability"]):SurfaceCommitReceipt {
  return {version:1,transactionId:`change-${requestId}`,requestId,clientId:"obsidian",targetId:"A",baseRevision:"runner-managed",appliedRevision:"1",
    ...(durability==="committed"?{committedRevision:"1"}:{}),createdIds:["shape"],updatedIds:[],deletedIds:[],objectRevisions:{shape:"a".repeat(64)},operationDigest:"b".repeat(64),durability};
}

describe("additional model call budget",()=>{
  it("assigns durable turn ids and keeps support dialogue out of ordinary tracking",async()=>{
    const service=new TutorConversation({run:async()=>({text:"answer"})});
    await service.submit("question",{context:{chat:{replyProtocol:"support"}}});
    const messages=service.state.history;
    expect(messages.map(m=>m.tracking)).toEqual(["private","private"]);
    expect(messages[0]?.persistentId).not.toBe(messages[1]?.persistentId);
    expect(messages.every(m=>/^[a-f0-9-]{36}$/.test(m.persistentId??""))).toBe(true);
  });
  it("uses the trusted executed result to exclude support after normal route preparation",async()=>{
    let calls=0;
    const service=new TutorConversation({run:async()=>++calls===2?{text:"bounded support",tracking:"private"}:{text:"ordinary answer"}});
    await service.submit("ordinary first");await service.submit("support second");await service.submit("ordinary third");
    expect(service.state.history.map(m=>m.tracking)).toEqual(["ordinary","ordinary","private","private","ordinary","ordinary"]);
    expect(service.state.history[2]?.completionStatus).toBeUndefined();
    expect(service.state.history[3]?.completionStatus).toBe("complete");
  });
  it.each([false,true])("charges a correction to its original turn with semantic preparation=%s",async prepare=>{
    const ready=deferred<void>();let input!:TutorRunnerInput;
    const service=new TutorConversation({
      prepare:async(_text,options)=>({...options,route:"chat",resolveIntent:false}),
      run:async next=>{input=next;await ready.promise;return {text:"answer"};}
    });
    const pending=service.submit("question",{route:"chat",resolveIntent:prepare});
    await Promise.resolve();
    const taskId=service.state.taskId!,initial=prepare?2:1;
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(initial);
    expect(input.consumeAdditionalModelCall).toBeTypeOf("function");
    input.consumeAdditionalModelCall!();
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(initial+1);
    ready.resolve();await pending;
    expect(service.state.taskStatus).toBe("complete");
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(initial+1);
  });

  it("cannot charge a cancelled turn or a later turn through the old callback",async()=>{
    const first=deferred<{text:string}>(),second=deferred<{text:string}>(),inputs:TutorRunnerInput[]=[];
    const service=new TutorConversation({run:input=>{inputs.push(input);return inputs.length===1?first.promise:second.promise;}});
    const oldRun=service.submit("first",{route:"chat"}),oldTask=service.state.taskId!;
    service.cancel();
    expect(()=>inputs[0]!.consumeAdditionalModelCall!()).toThrow(expect.objectContaining({name:"AbortError"}));
    const newRun=service.submit("second",{route:"chat"}),newTask=service.state.taskId!;
    expect(()=>inputs[0]!.consumeAdditionalModelCall!()).toThrow(expect.objectContaining({name:"AbortError"}));
    expect(service.tasks.get(oldTask,"obsidian").metrics.modelCalls).toBe(1);
    expect(service.tasks.get(newTask,"obsidian").metrics.modelCalls).toBe(1);
    inputs[1]!.consumeAdditionalModelCall!();
    expect(service.tasks.get(newTask,"obsidian").metrics.modelCalls).toBe(2);
    first.resolve({text:"late old answer"});await oldRun;
    expect(service.state.busy).toBe(true);
    second.resolve({text:"current answer"});await newRun;
    expect(service.state.latestReply).toBe("current answer");
    expect(service.tasks.get(oldTask,"obsidian").metrics.modelCalls).toBe(1);
  });

  it.each(["complete","failed"] as const)("rejects a retained callback after the turn is %s",async outcome=>{
    let input!:TutorRunnerInput;
    const service=new TutorConversation({run:async next=>{input=next;if(outcome==="failed")throw new Error("provider unavailable");return {text:"answer"};}});
    const pending=service.submit("question",{route:"chat"}),taskId=service.state.taskId!;await pending;
    expect(service.state.taskStatus).toBe(outcome);
    expect(()=>input.consumeAdditionalModelCall!()).toThrow(expect.objectContaining({name:"AbortError"}));
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(1);
  });

  it("applies the existing hard task budget before an additional model call",async()=>{
    const ready=deferred<void>();let input!:TutorRunnerInput;
    const service=new TutorConversation({run:async next=>{input=next;await ready.promise;return {text:"answer"};}});
    const pending=service.submit("question",{route:"chat"}),taskId=service.state.taskId!;
    for(let i=0;i<11;i++)input.consumeAdditionalModelCall!();
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(12);
    expect(()=>input.consumeAdditionalModelCall!()).toThrow("modelCalls-budget-exceeded");
    expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(12);
    ready.resolve();await pending;
  });
});

describe("board run preparation hook",()=>{
  it("waits for the bound target, prepares before any preview, and preserves authority plus boolean presentation",async()=>{
    const targetReady=deferred<import("../src/tutor-task.js").TaskTarget>(),prepared=deferred<void>(),events:string[]=[],authority=localLearnerAuthority();
    const target={id:"fixed-surface",source:"original.md",revision:"r7",surface:"studio" as const},metadata={learningEpisodeId:crypto.randomUUID()};
    let captured!:TutorBoardRunInput;
    const run=vi.fn<TutorBoardRunner["run"]>(async(instruction,_history,reply)=>{events.push("preview");expect(instruction).toBe("resolved drawing instruction");expect(reply("visible preview")).toBe(true);return {text:"drawn"};});
    const hook=vi.fn(async(input:TutorBoardRunInput,execute:()=>Promise<{text:string}>)=>{
      captured=input;events.push("prepare");expect(service.tasks.get(input.taskId,"obsidian").target).toEqual(target);
      expect(Object.isFrozen(input.target)).toBe(true);await prepared.promise;return execute();
    });
    const service=new TutorConversation({run:vi.fn(),withBoardRun:hook});
    service.registerBoard({...board("A",run),target:()=>targetReady.promise});
    const pending=service.submit("user drawing request",{route:"board",boardInstruction:"resolved drawing instruction",metadata,learningTurn:{entry:"sidebar",kind:"drawing",authority}});
    expect(hook).not.toHaveBeenCalled();targetReady.resolve(target);await Promise.resolve();
    expect(events).toEqual(["prepare"]);expect(run).not.toHaveBeenCalled();
    expect(captured).toMatchObject({text:"user drawing request",target,options:{metadata,learningTurn:{authority}}});
    expect(captured.options.learningTurn?.authority).toBe(authority);
    service.registerBoard(board("elsewhere",vi.fn()));target.source="mutated-after-bind.md";
    expect(captured.target.source).toBe("original.md");prepared.resolve();await pending;
    expect(events).toEqual(["prepare","preview"]);expect(run).toHaveBeenCalledOnce();expect(service.state.latestReply).toBe("drawn");
  });

  it.each(["success","failure"] as const)("never repeats a board callback after its %s",async outcome=>{
    const error=new Error("original-run-failed"),run=vi.fn<TutorBoardRunner["run"]>(async()=>{if(outcome==="failure")throw error;return {text:"drawn"};});
    const service=new TutorConversation({run:vi.fn(),withBoardRun:async(_input,execute)=>{
      const first=execute();expect(execute()).toBe(first);
      await first.catch(()=>{});expect(execute()).toBe(first);return first;
    }});service.registerBoard(board("A",run));await service.submit("draw",{route:"board"});
    expect(run).toHaveBeenCalledOnce();expect(service.state.taskStatus).toBe(outcome==="success"?"complete":"failed");
  });

  it("does not invoke a delayed old callback after cancellation and a newer turn",async()=>{
    const prepared=deferred<void>(),run=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"old drawing"}));let old!:TutorBoardRunInput;
    const service=new TutorConversation({run:async()=>({text:"new answer"}),withBoardRun:async(input,execute)=>{
      old=input;await prepared.promise;expect(input.onReply("stale preparation")).toBe(false);return execute();
    }});service.registerBoard(board("A",run));const pending=service.submit("draw",{route:"board"});
    const taskId=old.taskId;await service.submit("new question",{route:"chat"});prepared.resolve();await pending;
    expect(old.signal.aborted).toBe(true);expect(run).not.toHaveBeenCalled();expect(service.tasks.get(taskId,"obsidian").metrics.modelCalls).toBe(0);
    expect(service.state).toMatchObject({taskStatus:"complete",latestReply:"new answer"});
  });

  it("rejects a callback retained past wrapper completion instead of starting a detached drawing",async()=>{
    let execute!:(()=>Promise<{text:string}>);const run=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"detached"}));
    const service=new TutorConversation({run:vi.fn(),withBoardRun:async(_input,next)=>{execute=next;return {text:"No drawing requested"};}});
    service.registerBoard(board("A",run));await service.submit("draw",{route:"board"});
    await expect(execute()).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();
    expect(service.state.latestReply).toBe("No drawing requested");
  });

  it("fails a replaced board while retaining the original task target",async()=>{
    const prepared=deferred<void>(),original=vi.fn<TutorBoardRunner["run"]>(),replacement=vi.fn<TutorBoardRunner["run"]>();let captured!:TutorBoardRunInput;
    const service=new TutorConversation({run:vi.fn(),withBoardRun:async(input,execute)=>{captured=input;await prepared.promise;return execute();}});
    service.registerBoard(board("A",original));const pending=service.submit("draw",{route:"board"});
    service.registerBoard(board("A",replacement));prepared.resolve();await pending;
    expect(original).not.toHaveBeenCalled();expect(replacement).not.toHaveBeenCalled();
    expect(service.tasks.get(captured.taskId,"obsidian").target).toEqual(captured.target);expect(service.state.error).toBe("board-unavailable");
  });

  it.each(["committed","applied-not-durable","outcome-unknown"] as const)("preserves the %s receipt if wrapper confirmation fails",async durability=>{
    let taskId="";const run=vi.fn<TutorBoardRunner["run"]>(async()=>{
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,durability));return {text:"drawing result"};
    });
    const service=new TutorConversation({run:vi.fn(),withBoardRun:async(input,execute)=>{taskId=input.taskId;await execute();throw new Error("help-confirmation-failed");}});
    service.registerBoard(board("A",run));await service.submit("draw",{route:"board"});
    expect(service.state).toMatchObject({taskId,commit:{durability},taskStatus:durability==="committed"?"complete":"reconciliation",canRetry:false,error:null});
    await service.retry();expect(run).toHaveBeenCalledOnce();
  });

  it("keeps a late committed wrapped drawing in its old bubble after a new turn",async()=>{
    const saved=deferred<void>();let taskId="";
    const service=new TutorConversation({run:async()=>({text:"new answer"}),withBoardRun:async(input,execute)=>{taskId=input.taskId;return execute();}});
    service.registerBoard(board("A",async()=>{
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"applied-not-durable"));await saved.promise;
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"committed"));return {text:"old drawing"};
    }));
    const first=service.submit("draw",{route:"board"});await service.submit("new",{route:"chat"});saved.resolve();await first;
    expect(service.state).toMatchObject({latestReply:"new answer",taskStatus:"complete"});
    expect(service.state.history[1]).toMatchObject({status:"complete",text:expect.stringContaining("图形已保存")});
  });

  it.each(["explicit","auto","semantic","reference"] as const)("wraps the %s board path without changing the selected runner",async route=>{
    const run=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"drawn"})),hook=vi.fn(async(_input:TutorBoardRunInput,execute:()=>Promise<{text:string}>)=>execute());
    const service=new TutorConversation({run:vi.fn(),withBoardRun:hook,prepare:async(_text,options)=>({...options,route:"board",boardId:"A",resolveIntent:false})});
    service.registerBoard(board("A",run));await service.submit("draw",{route:route==="auto"?"auto":"board",...(route==="semantic"?{resolveIntent:true}:{}),...(route==="reference"?{referencePath:"saved-reference.png"}:{})});
    expect(hook).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledOnce();if(route==="reference")expect(run.mock.calls[0]![4]).toBe("saved-reference.png");
  });
});

describe("fixed drawing retries",()=>{
  it("retains the original stable target, semantic plan, learning request and capability when focus changes",async()=>{
    const target={id:"stable-A",source:"A.md",revision:"7",surface:"document" as const},token={},requestId=crypto.randomUUID();
    const plan={mode:"native" as const,surface:"document" as const,prompt:"curve"};
    const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({text:"drawn"});
    const prepare=vi.fn(async(_text:string,options:import("../src/tutor-conversation.js").TutorSubmitOptions)=>({...options,route:"board" as const,boardId:"A",resolveIntent:false,drawingPlan:plan,learningDrawing:token}));
    const hook=vi.fn(async(_input:TutorBoardRunInput,execute:()=>Promise<{text:string}>)=>execute());
    const service=new TutorConversation({run:vi.fn(),prepare,withBoardRun:hook});
    service.registerBoard({...board("A",run),target:()=>target});
    await service.submit("draw",{resolveIntent:true,learningRequestId:requestId});
    const elsewhere=vi.fn();service.registerBoard(board("B",elsewhere));await service.retry();
    expect(prepare).toHaveBeenCalledOnce();expect(elsewhere).not.toHaveBeenCalled();expect(run).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]![0].options.learningDrawing).toBe(token);expect(hook.mock.calls[1]![0].options.learningDrawing).toBe(token);
    for(const [input] of hook.mock.calls){expect(input.target).toEqual(target);expect(input.options.learningRequestId).toBe(requestId);expect(input.options.drawingPlan).toEqual(plan);}
    expect(service.state.taskStatus).toBe("complete");
  });

  it.each(["retry","connection"] as const)("rejects a changed base revision before a %s replay can show a preview",async mode=>{
    let revision="7";const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary"));
    const hook=vi.fn(async(_input:TutorBoardRunInput,execute:()=>Promise<{text:string}>)=>execute());
    const recoverConnection=vi.fn(async()=>{}),service=new TutorConversation({run:vi.fn(),withBoardRun:hook,recoverConnection});
    service.registerBoard({...board("A",run),target:()=>({id:"stable-A",source:"A.md",revision,surface:"document"})});
    await service.submit("draw",{route:"board"});revision="8";
    if(mode==="retry")await service.retry();else await service.useChatConnectionAndRetry();
    expect(run).toHaveBeenCalledOnce();expect(hook).toHaveBeenCalledOnce();
    expect(service.state).toMatchObject({taskStatus:"failed",canRetry:false,error:expect.stringContaining("目标或内容已变化")});
    await service.retry();await service.useChatConnectionAndRetry();expect(run).toHaveBeenCalledOnce();
    expect(recoverConnection).toHaveBeenCalledTimes(mode==="connection"?1:0);
  });

  it("rejects a replacement stable target even when its board registration id is reused",async()=>{
    let id="stable-A";const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary"));
    const service=new TutorConversation({run:vi.fn()});
    service.registerBoard({...board("A",run),target:()=>({id,source:"A.md",revision:"7",surface:"document"})});
    await service.submit("draw",{route:"board"});id="stable-B";await service.retry();
    expect(run).toHaveBeenCalledOnce();expect(service.state.canRetry).toBe(false);
  });

  it("refuses an unversioned replacement runner without claiming that a reused board id proves identity",async()=>{
    const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary")),replacement=vi.fn();
    const service=new TutorConversation({run:vi.fn()});service.registerBoard(board("A",run));
    await service.submit("draw",{route:"board"});service.registerBoard(board("A",replacement));await service.retry();
    expect(replacement).not.toHaveBeenCalled();expect(service.state.canRetry).toBe(false);
  });

  it("allows a remounted versioned runner to locate the same stable target after rename",async()=>{
    const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary")),replacement=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"drawn"}));
    const service=new TutorConversation({run:vi.fn()});
    service.registerBoard({...board("A",run),target:()=>({id:"stable-A",source:"A.md",revision:"7",surface:"document"})});
    await service.submit("draw",{route:"board"});
    service.registerBoard({...board("A",replacement),target:()=>({id:"stable-A",source:"renamed.md",revision:"7",surface:"document"})});
    await service.retry();expect(replacement).toHaveBeenCalledOnce();expect(service.state.taskStatus).toBe("complete");
  });

  it.each(["committed","not-applied"] as const)("waits for a stopped drawing to settle before offering retry (%s)",async outcome=>{
    const settled=deferred<void>(),recoverConnection=vi.fn(async()=>{});let taskId="";
    const service=new TutorConversation({run:vi.fn(),recoverConnection});
    const run=vi.fn<TutorBoardRunner["run"]>(async()=>{taskId=service.activeTask!.id;await settled.promise;
      if(outcome==="committed")service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"committed"));
      throw new Error("stopped during save");});
    service.registerBoard(board("A",run));const first=service.submit("draw",{route:"board"});service.cancel();
    expect(service.state).toMatchObject({taskStatus:"cancelled",canRetry:false,busy:false});
    await service.retry();await service.useChatConnectionAndRetry();expect(run).toHaveBeenCalledOnce();expect(recoverConnection).not.toHaveBeenCalled();
    const states:unknown[]=[];const stop=service.subscribe(state=>states.push(state.canRetry));settled.resolve();await first;stop();
    expect(service.state.canRetry).toBe(outcome==="not-applied");expect(states.at(-1)).toBe(outcome==="not-applied");
    if(outcome==="committed"){await service.retry();expect(run).toHaveBeenCalledOnce();expect(service.state.latestReply).toContain("图形已保存");}
  });

  it.each([false,true])("never starts an old drawing when a target lookup resolves after Stop (wrapper=%s)",async wrapped=>{
    const ready=deferred<import("../src/tutor-task.js").TaskTarget>(),run=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"drawn"}));
    const hook=vi.fn(async(_input:TutorBoardRunInput,execute:()=>Promise<{text:string}>)=>execute());
    const service=new TutorConversation({run:vi.fn(),...(wrapped?{withBoardRun:hook}:{})});
    service.registerBoard({...board("A",run),target:()=>ready.promise});const first=service.submit("draw",{route:"board"});service.cancel();
    ready.resolve({id:"stable-A",source:"A.md",revision:"7",surface:"document"});await first;
    expect(run).not.toHaveBeenCalled();expect(hook).not.toHaveBeenCalled();expect(service.state.taskStatus).toBe("cancelled");
  });
});

describe("shared Tutor conversation", () => {
  it("passes semantic image plans through board text and retries without reclassifying", async () => {
    const plan={mode:"reference" as const,prompt:"彩色包豪斯花园"};
    const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("temporary image error")).mockResolvedValueOnce({text:"painted"});
    const prepare=vi.fn(async (_text:string,options:import("../src/tutor-conversation.js").TutorSubmitOptions)=>({ ...options,route:"board" as const,boardId:"a",resolveIntent:false,requiresDrawing:true,drawingPlan:plan }));
    const service=new TutorConversation({run:vi.fn(),prepare});service.registerBoard(board("a",run));
    await service.submit("先生成示意图，再调整",{source:"board",boardId:"a",route:"board"});
    expect(prepare).toHaveBeenCalledOnce();expect(run.mock.calls[0]?.[6]).toEqual(plan);
    await service.retry();expect(prepare).toHaveBeenCalledOnce();expect(run.mock.calls[1]?.[6]).toEqual(plan);
  });
  it("does not bind a semantic request to a background board before opening its own source", async () => {
    const intent = deferred<void>();
    const oldRun = vi.fn<TutorBoardRunner["run"]>(async () => ({ text: "wrong document" }));
    const run = vi.fn<TutorBoardRunner["run"]>(async () => ({ text: "drawn" }));
    const service = new TutorConversation({ run: vi.fn(), prepare: async (_text, options) => {
      await intent.promise;
      service.registerBoard(board("target", run));
      return { ...options, route: "board", boardId: "target", resolveIntent: false, requiresDrawing: true };
    } });
    service.registerBoard(board("background", oldRun));
    const pending = service.submit("show it visually", { route: "board", resolveIntent: true });
    service.cancelForBoard("background"); // Source focus moves off a stale split.
    expect(service.state).toMatchObject({ busy: true, latestBoardId: null });
    intent.resolve(); await pending;
    expect(oldRun).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[5]).toBe(true);
    expect(service.state).toMatchObject({ taskStatus: "complete", latestBoardId: "target" });
  });
  it("resolves semantics before opening a board and then routes the original request to it",async()=>{
    const order:string[]=[];const drawing=vi.fn<TutorBoardRunner["run"]>(async()=>({text:"drawn"}));
    const service=new TutorConversation({run:vi.fn(),prepare:async(text,options)=>{
      order.push("intent");expect(text).toBe("show it visually");expect(service.hasBoard()).toBe(false);
      order.push("open");service.registerBoard(board("new",drawing));return {...options,route:"board",boardId:"new",resolveIntent:false};
    }});
    await service.submit("show it visually",{source:"chat",route:"board",resolveIntent:true});
    expect(order).toEqual(["intent","open"]);expect(drawing.mock.calls[0]?.[0]).toBe("show it visually");
    expect(service.state).toMatchObject({taskStatus:"complete",latestBoardId:"new"});
  });
  it("cancel during intent resolution prevents a late result from executing",async()=>{
    const wait=deferred<{}>(),run=vi.fn(async()=>({text:"answer"}));
    const service=new TutorConversation({run,prepare:async()=>{await wait.promise;return {route:"chat"};}});
    const pending=service.submit("please draw",{resolveIntent:true});service.cancel();wait.resolve({});await pending;
    expect(run).not.toHaveBeenCalled();expect(service.state.taskStatus).toBe("cancelled");
  });
  it("replaces progress with a provider refusal, disables blind retry and retains the request for editing",async()=>{
    const refusal=new ImageContentRefusal("ip","IPInfringementSuspect");
    const run=vi.fn<TutorBoardRunner["run"]>(async(_text,_history,onReply)=>{onReply("Generating reference…");throw refusal;});
    const conversation=new TutorConversation({run:vi.fn()});conversation.registerBoard(board("A",run));
    await conversation.submit("draw a character",{route:"board"});
    expect(conversation.state).toMatchObject({taskStatus:"blocked",canRetry:false,requestToEdit:"draw a character",latestReply:refusal.message});
    expect(conversation.state.history.at(-1)?.text).toBe(refusal.message);
    await conversation.retry();expect(run).toHaveBeenCalledOnce();
    run.mockResolvedValueOnce({text:"done"});await conversation.submit("draw an original character",{route:"board"});
    expect(conversation.state).toMatchObject({taskStatus:"complete",canRetry:false,requestToEdit:undefined});
  });
  it("does not leave an unrelated retry behind after a completed local action", async () => {
    const run=vi.fn().mockRejectedValue(new Error("network-error"));
    const conversation=new TutorConversation({run});
    await conversation.submit("old request");
    expect(conversation.state.canRetry).toBe(true);
    conversation.recordLocal("local action","saved");
    expect(conversation.state).toMatchObject({taskStatus:"complete",canRetry:false,error:null,latestReply:"saved"});
    await conversation.retry();expect(run).toHaveBeenCalledTimes(1);
  });
  it("retries only on demand, retaining the original board and saved reference",async()=>{
    const run=vi.fn<TutorBoardRunner["run"]>().mockRejectedValueOnce(new Error("network-error")).mockResolvedValueOnce({text:"done"});
    const conversation=new TutorConversation({run:vi.fn()});
    conversation.registerBoard(board("A",run));
    const pending=conversation.submit("draw this",{route:"board"});
    conversation.rememberBoardReference("A","Agent Memory/references/saved.png");
    await pending;
    expect(conversation.state).toMatchObject({taskStatus:"failed",canRetry:true});
    expect(run).toHaveBeenCalledTimes(1);
    await conversation.retry();
    expect(run.mock.calls[1]?.[4]).toBe("Agent Memory/references/saved.png");
    expect(conversation.state).toMatchObject({taskStatus:"complete",canRetry:false});
    await conversation.retry();expect(run).toHaveBeenCalledTimes(2);
  });
  it("exposes cancelled tasks for retry and ignores the cancelled attempt's late completion",async()=>{
    const pending=deferred<{text:string}>();const run=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({text:"retry done"});
    const conversation=new TutorConversation({run});
    const first=conversation.submit("draw");conversation.cancel();
    expect(conversation.state).toMatchObject({taskStatus:"cancelled",canRetry:true});
    await conversation.retry();pending.resolve({text:"late"});await first;
    expect(conversation.state).toMatchObject({taskStatus:"complete",latestReply:"retry done",canRetry:false});
  });
  it("shows a save completed after Stop as completed and preserves its commit artifact",async()=>{
    const wait=deferred<void>();let taskId="";
    const service=new TutorConversation({run:vi.fn()});
    service.registerBoard(board("A",async()=>{
      taskId=service.activeTask!.id;
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"applied-not-durable"));
      await wait.promise;
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"committed"));
      return {text:"drawn"};
    }));
    const pending=service.submit("draw",{route:"board"});service.cancel();
    expect(service.state).toMatchObject({taskStatus:"reconciliation",canRetry:false,busy:false});
    wait.resolve();await pending;
    expect(service.state).toMatchObject({taskStatus:"complete",canRetry:false,busy:false});
    expect(service.state.latestReply).toContain("图形已保存");expect(service.state.history.at(-1)?.status).toBe("complete");
    expect(service.tasks.get(taskId,"obsidian")).toMatchObject({state:"completed",phase:"committed-after-cancel",artifacts:[{type:"changes"}]});
  });
  it.each(["applied-not-durable","outcome-unknown"] as const)("does not offer generation or connection retries for a %s result",async durability=>{
    const recoverConnection=vi.fn(async()=>{});let taskId="";
    const service=new TutorConversation({run:vi.fn(),recoverConnection});
    const run=vi.fn(async()=>{
      taskId=service.activeTask!.id;const receipt=drawingReceipt(taskId,durability);
      throw new SurfaceCommitError("save-not-confirmed",{target:{id:"A",source:"A.md",revision:"1",surface:"studio"},selection:[],objects:[],receipt});
    });
    service.registerBoard(board("A",run));await service.submit("draw",{route:"board"});
    expect(service.state).toMatchObject({taskStatus:"reconciliation",canRetry:false,error:null});
    expect(service.state.latestReply).toContain("核对");expect(service.state.history.at(-1)?.status).toBe("complete");
    expect(service.tasks.get(taskId,"obsidian").state).toBe("input-required");
    await service.retry();await service.useChatConnectionAndRetry();expect(run).toHaveBeenCalledOnce();expect(recoverConnection).not.toHaveBeenCalled();
  });
  it("keeps a late saved receipt in its own bubble without overwriting a newer turn",async()=>{
    const wait=deferred<void>();let taskId="";
    const service=new TutorConversation({run:async()=>({text:"new answer"})});
    service.registerBoard(board("A",async()=>{
      taskId=service.activeTask!.id;service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"applied-not-durable"));
      await wait.promise;service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"committed"));return {text:"old answer"};
    }));
    const first=service.submit("draw",{route:"board"});await service.submit("new question",{route:"chat"});wait.resolve();await first;
    expect(service.state).toMatchObject({taskStatus:"complete",latestReply:"new answer",canRetry:false});
    expect(service.state.history[1]).toMatchObject({status:"complete",text:expect.stringContaining("图形已保存")});
  });
  it("does not revive a reset conversation when a native save finishes late",async()=>{
    const wait=deferred<void>();let taskId="";const service=new TutorConversation({run:vi.fn()});
    service.registerBoard(board("A",async()=>{
      taskId=service.activeTask!.id;service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"applied-not-durable"));
      await wait.promise;service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"committed"));return {text:"saved"};
    }));
    const pending=service.submit("draw",{route:"board"});service.reset();wait.resolve();await pending;
    expect(service.state).toMatchObject({history:[],latestReply:"",taskStatus:undefined,canRetry:false});
    expect(service.tasks.get(taskId,"obsidian").state).toBe("completed");
  });
  it("exposes the original task and receipt for local save recovery without another model run",async()=>{
    let taskId="";const service=new TutorConversation({run:vi.fn()});
    const run=vi.fn(async()=>{
      taskId=service.activeTask!.id;
      service.tasks.recordSurfaceCommit(drawingReceipt(taskId,"outcome-unknown"));throw new Error("save-unconfirmed");
    });
    service.registerBoard(board("A",run));await service.submit("draw",{route:"board"});
    expect(service.state).toMatchObject({taskId,commit:{requestId:taskId,durability:"outcome-unknown"},taskStatus:"reconciliation"});
    expect(service.state.history.at(-1)?.taskId).toBe(taskId);
    expect(service.applyRecoveredCommit(drawingReceipt(taskId,"applied-not-durable"))).toBe(true);
    expect(service.state).toMatchObject({taskId,commit:{durability:"applied-not-durable"},taskStatus:"reconciliation",canRetry:false});
    expect(service.applyRecoveredCommit(drawingReceipt(taskId,"committed"))).toBe(true);
    expect(service.state).toMatchObject({taskId,commit:{durability:"committed"},taskStatus:"complete",canRetry:false,latestReply:expect.stringContaining("图形已保存")});
    expect(run).toHaveBeenCalledOnce();
  });
  it("applies local recovery only to the matching message across new turns and reset",async()=>{
    let oldTaskId="";const service=new TutorConversation({run:async()=>({text:"new answer"})});
    service.registerBoard(board("A",async()=>{
      oldTaskId=service.activeTask!.id;service.tasks.recordSurfaceCommit(drawingReceipt(oldTaskId,"applied-not-durable"));throw new Error("disk-full");
    }));
    await service.submit("draw",{route:"board"});await service.submit("new question",{route:"chat"});const newTaskId=service.state.taskId;
    expect(newTaskId).toBeTruthy();expect(newTaskId).not.toBe(oldTaskId);expect(service.state.commit).toBeUndefined();
    expect(service.applyRecoveredCommit(drawingReceipt(oldTaskId,"committed"))).toBe(true);
    expect(service.state).toMatchObject({taskId:newTaskId,commit:undefined,latestReply:"new answer",taskStatus:"complete"});
    expect(service.state.history[1]?.text).toContain("图形已保存");
    expect(()=>service.applyRecoveredCommit({...drawingReceipt(oldTaskId,"committed"),clientId:"external-client"})).toThrow("client-mismatch");
    service.reset();expect(service.applyRecoveredCommit(drawingReceipt(oldTaskId,"committed"))).toBe(false);
    expect(service.state).toMatchObject({history:[],taskId:undefined,commit:undefined,taskStatus:undefined});
  });
  it("retains an asset written just after cancel without letting an older task overwrite the retry reference",async()=>{
    const pending=deferred<{text:string}>();
    const run=vi.fn<TutorBoardRunner["run"]>().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("failed"));
    const conversation=new TutorConversation({run:vi.fn()});conversation.registerBoard(board("A",run));
    const first=conversation.submit("draw",{route:"board"});
    const originalSignal=run.mock.calls[0]![3];conversation.cancel();
    conversation.rememberBoardReference("A","original.png",originalSignal);
    await conversation.retry();expect(run).toHaveBeenCalledOnce();
    pending.resolve({text:"late"});await first;
    await conversation.retry();
    expect(run.mock.calls[1]![4]).toBe("original.png");
    conversation.rememberBoardReference("A","wrong-late.png",originalSignal);
    run.mockResolvedValueOnce({text:"done"});await conversation.retry();
    expect(run.mock.calls[2]![4]).toBe("original.png");
  });
  it("keeps streaming and history alive when the sidebar closes, and only replaces the latest reply", async () => {
    const waits = [deferred<{ text: string }>(), deferred<{ text: string }>()];
    const inputs: TutorRunnerInput[] = [];
    const conversation = new TutorConversation({ run: input => { inputs.push(input); return waits[inputs.length - 1]!.promise; } });
    const subscriber = vi.fn();
    const unsubscribe = conversation.subscribe(subscriber);
    conversation.setSidebarVisible("right", true);
    const first = conversation.submit("first");
    inputs[0]!.onReply("你");
    expect(conversation.state.latestReply).toBe("你");
    unsubscribe(); conversation.setSidebarVisible("right", false);
    inputs[0]!.onReply("好");
    expect(conversation.state.latestReply).toBe("你好");
    expect(inputs[0]!.signal.aborted).toBe(false);
    waits[0]!.resolve({ text: "你好" }); await first;
    const second = conversation.submit("second");
    expect(conversation.state.latestReply).toBe("");
    expect(inputs[1]!.history.map(message => message.content)).toEqual(["first", "你好"]);
    inputs[1]!.onReply("新回复");
    waits[1]!.resolve({ text: "新回复" }); await second;
    expect(conversation.state.history.map(message => message.text)).toEqual(["first", "你好", "second", "新回复"]);
  });

  it("tracks sidebar visibility separately for the main and popout documents", () => {
    const conversation = new TutorConversation({ run: async () => ({ text: "" }) });
    const main = {} as Document; const popout = {} as Document;
    conversation.setSidebarVisible("main", true, main);
    expect(conversation.isSidebarVisible(main)).toBe(true);
    expect(conversation.isSidebarVisible(popout)).toBe(false);
    conversation.setSidebarVisible("popout", true, popout);
    conversation.setSidebarVisible("main", false, main);
    expect(conversation.isSidebarVisible()).toBe(true);
    expect(conversation.isSidebarVisible(main)).toBe(false);
  });

  it("uses one transcript for explicit drawing, automatic observations, and ordinary chat", async () => {
    const normal = vi.fn(async ({ onReply }: TutorRunnerInput) => { onReply("text"); return { text: "text" }; });
    const draw = vi.fn<TutorBoardRunner["run"]>(async (_text, _history, reply) => { reply("drawing"); return { text: "drawing" }; });
    const conversation = new TutorConversation({ run: normal, boardUpdateLabel: () => "画板更新" });
    conversation.registerBoard(board("A", draw, false));
    await conversation.submit("question");
    expect(normal).toHaveBeenCalledTimes(1);
    await conversation.submit("diagram", { route: "board" });
    expect(draw.mock.calls[0]?.[1]).toEqual([{ role: "user", content: "question" }, { role: "assistant", content: "text" }]);
    expect(conversation.state.latestBoardId).toBe("A");
    await conversation.submit("", { source: "board", route: "board", boardId: "A" });
    expect(conversation.state.history.at(-2)?.text).toBe("画板更新");
    await conversation.submit("revise the note", { route: "chat", mode: "build" });
    expect(normal.mock.calls.at(-1)?.[0].history).toHaveLength(6);
  });

  it("deduplicates one observation and does not let automatic drawing interrupt a manual question", async () => {
    const pending = deferred<{ text: string }>();
    const draw = vi.fn<TutorBoardRunner["run"]>(() => pending.promise);
    const conversation = new TutorConversation({ run: async () => ({ text: "" }) });
    conversation.registerBoard(board("A", draw));
    const first = conversation.submit("manual", { route: "board", key: "same" });
    const duplicate = conversation.submit("manual", { route: "board", key: "same" });
    await conversation.submit("", { source: "board", route: "board", key: "new" });
    expect(first).toBe(duplicate);
    expect(draw).toHaveBeenCalledTimes(1);
    pending.resolve({ text: "done" }); await first;
  });

  it("cancels a superseded turn immediately and drops its late chunks and result", async () => {
    const stale = deferred<{ text: string }>();
    const calls: TutorRunnerInput[] = [];
    const conversation = new TutorConversation({ run: input => { calls.push(input); return calls.length === 1 ? stale.promise : Promise.resolve({ text: "current" }); } });
    const old = conversation.submit("old");
    calls[0]!.onReply("partial");
    await conversation.submit("new");
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.onReply("stale"); stale.resolve({ text: "stale final" }); await old;
    expect(conversation.state.latestReply).toBe("current");
    expect(conversation.state.history[1]?.status).toBe("stopped");
    expect(conversation.state.history[1]?.text).toBe("partial");
  });

  it.each(["提示已显示", ""])("preserves an interrupted reply boundary before a new answer: %s", async fragment => {
    const stale = deferred<{text:string}>(), calls:TutorRunnerInput[]=[];
    const conversation=new TutorConversation({run:input=>{
      calls.push(input);return calls.length===1?stale.promise:Promise.resolve({text:"current response"});
    }});
    const old=conversation.submit("给我一点提示",{route:"chat"});
    if(fragment)calls[0]!.onReply(fragment);
    conversation.cancel();
    await conversation.submit("6",{route:"chat"});
    const next=calls[1]!;
    expect(next.text).toBe("6");expect(next.historyOffset).toBe(0);
    expect(next.history).toHaveLength(2);
    expect(next.history[0]).toEqual({role:"user",content:"给我一点提示"});
    expect(next.history[1]).toMatchObject({role:"assistant"});
    expect(next.history[1]!.content).toContain("earlier response was interrupted");
    expect(next.history[1]!.content.endsWith("\n"+fragment)).toBe(true);
    calls[0]!.onReply("late secret fragment");stale.resolve({text:"late final"});await old;
    expect(next.history[1]!.content).not.toContain("late secret fragment");
    expect(next.history[1]!.content).not.toContain("late final");
    expect(conversation.state.history[1]).toMatchObject({text:fragment,status:"stopped"});
    expect(conversation.state.latestReply).toBe("current response");
  });

  it("bounds settled history including interruptions and keeps its absolute offset",async()=>{
    const calls:TutorRunnerInput[]=[];
    const conversation=new TutorConversation({run:async input=>{
      calls.push(input);input.onReply("visible");if(input.text==="interrupt")throw new Error("network interruption");return {text:"done"};
    }});
    for(let i=0;i<21;i++)await conversation.submit(i===0?"interrupt":"turn "+i,{route:"chat"});
    await conversation.submit("new answer",{route:"chat"});
    expect(calls.at(-1)!.history).toHaveLength(40);expect(calls.at(-1)!.historyOffset).toBe(2);
    expect(calls.at(-1)!.history[0]).toEqual({role:"user",content:"turn 1"});
  });

  it("cancelling an unrelated board cannot interrupt the active conversation", async () => {
    const pending = deferred<{ text: string }>();
    let signal: AbortSignal | undefined;
    const conversation = new TutorConversation({ run: async () => ({ text: "" }) });
    conversation.registerBoard(board("A", (_t, _h, _r, abort) => { signal = abort; return pending.promise; }));
    const turn = conversation.submit("hello", { route: "board", boardId: "A" });
    conversation.cancelForBoard("B"); expect(signal?.aborted).toBe(false);
    conversation.cancelForBoard("A"); expect(signal?.aborted).toBe(true);
    pending.resolve({ text: "late" }); await turn;
    expect(conversation.state.latestReply).toBe("");
  });

  it("keeps a plain reply bound to its source board, then stops routing when the learner leaves the document", async () => {
    const plain = vi.fn(async () => ({ text: "answer" }));
    const draw = vi.fn<TutorBoardRunner["run"]>(async () => ({ text: "drawing" }));
    const conversation = new TutorConversation({ run: plain });
    conversation.registerBoard(board("A", draw, false));
    await conversation.submit("explain");
    expect(conversation.state.latestBoardId).toBe("A");
    conversation.registerBoard(board("B", draw));
    expect(conversation.state.latestBoardId).toBe("A");
    conversation.deactivateBoard();
    await conversation.submit("another question");
    expect(draw).not.toHaveBeenCalled();
    expect(plain).toHaveBeenCalledTimes(2);
    expect(conversation.state.latestBoardId).toBeNull();
  });

  it("does not silently send a missing board request to a text-only runner", async () => {
    const run = vi.fn(async () => ({ text: "" }));
    const conversation = new TutorConversation({ run });
    await conversation.submit("draw", { route: "board" });
    expect(run).not.toHaveBeenCalled();
    expect(conversation.state.error).toBe("board-unavailable");
  });

  it("rejects an explicit empty reply without leaving an empty assistant bubble", async () => {
    const conversation = new TutorConversation({
      run: async () => ({ text: "   " }),
      emptyReplyLabel: () => "模型没有返回内容。",
    });
    await conversation.submit("请画一只鲸鱼");
    expect(conversation.state.error).toBe("模型没有返回内容。");
    expect(conversation.state.history.map(message => [message.role, message.text])).toEqual([
      ["user", "请画一只鲸鱼"],
    ]);
  });

  it("silently drops a no-op automatic board observation", async () => {
    const conversation = new TutorConversation({ run: async () => ({ text: "" }), boardUpdateLabel: () => "画板更新" });
    conversation.registerBoard(board("A", async () => ({ text: "" })));
    await conversation.submit("", { source: "board", route: "board", boardId: "A" });
    expect(conversation.state.history).toEqual([]);
    expect(conversation.state.error).toBeNull();
  });

  it("restores history without an old view, and persists the previous conversation during reset", async () => {
    const writes: string[][] = [];
    const conversation = new TutorConversation({ run: async () => ({ text: "answer" }),
      persist: async (messages, mode, previous) => {
        writes.push(messages.map(message => message.text));
        return { id: previous?.id ?? `CHAT-${writes.length}`, title: "Test", engine: "api", mode,
          status: "active", createdAt: "now", updatedAt: "now", turns: messages.map(m => ({ role: m.role, text: m.text, at: m.at })) };
      } });
    await conversation.submit("one"); conversation.reset();
    await conversation.submit("two"); await conversation.flush();
    expect(writes.some(turns => turns.join() === "one,answer")).toBe(true);
    expect(conversation.log?.turns.map(turn => turn.text)).toEqual(["two", "answer"]);
    const saved = conversation.log as ChatLog;
    conversation.reset(); conversation.restore(saved);
    expect(conversation.state.history.map(message => message.text)).toEqual(["two", "answer"]);
    expect(conversation.state.busy).toBe(false);
  });
});

describe("Tutor routing", () => {
  const context = { mode: "ask" as const, pinned: false, hasBoard: true };
  it.each(["画个示意", "来个表情", "draw a diagram", "把本章画成思维导图", "修改这个示意图", "把这个表情改成开心的", "编辑画板文字", "edit this diagram", "insert an emoji"])("routes %s to the open board", text => {
    expect(tutorRouteForText(text, context)).toBe("board");
  });
  it.each(["在正文插入一张图", "润色这段文字", "insert a diagram into this note", "生成一个 Mermaid", "画一个表格"])("preserves the note edit flow for %s", text => {
    expect(tutorRouteForText(text, context)).toBe("chat");
  });
  it("preserves pinned annotations and the Plan/Build modes", () => {
    expect(tutorRouteForText("draw", { ...context, mode: "build" })).toBe("chat");
    expect(tutorRouteForText("draw", { ...context, mode: "plan" })).toBe("chat");
    expect(tutorRouteForText("draw", { ...context, pinned: true })).toBe("chat");
  });
  it.each(["修改一下", "编辑这里", "insert", "edit this"])("keeps ambiguous edit %s in the current context", text => {
    expect(tutorRouteForText(text, context)).toBe("auto");
  });
  it("leaves ordinary questions eligible for opt-in visual context", () => {
    expect(tutorRouteForText("Why does it move?", context)).toBe("auto");
    expect(tutorRouteForText("draw", { ...context, hasBoard: false })).toBe("auto");
  });
});

describe('effective board connection recovery',()=>{
  it('shows the actual model, clears replacement replies, and retries the original board after a connection switch',async()=>{
    const {AIExecutionError,executionFailure}=await import('../src/ai-execution.js');let custom=true;
    const run=vi.fn<TutorBoardRunner['run']>().mockImplementationOnce(async(_text,_history,reply)=>{reply('old promise');service.resetBoardReply();reply('new promise');throw new AIExecutionError('denied',executionFailure('opencode','actual/vision','provider-access-403'));}).mockResolvedValue({text:'done'});
    const prepare=vi.fn();const other=vi.fn<TutorBoardRunner['run']>(async()=>({text:'wrong page'}));
    const service=new TutorConversation({run:vi.fn(),prepare,recoverConnection:async()=>{custom=false;service.settingsChanged();}});
    service.registerBoard({...board('original',run),connection:()=>custom?{engine:'opencode',model:'actual/vision',mode:'custom'}:{engine:'api',model:'sidebar',mode:'inherit'}});
    await service.submit('draw the function',{route:'board',boardId:'original',drawingPlan:{mode:'math'}});
    expect(service.state).toMatchObject({canRetry:false,latestReply:'new promise',failure:{category:'access'},execution:{model:'actual/vision'}});
    service.registerBoard(board('other',other));service.activateBoard('other');
    await service.useChatConnectionAndRetry();
    expect(run).toHaveBeenCalledTimes(2);expect(other).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
    expect(run.mock.calls[1]?.[6]).toEqual({mode:'math'});
    expect(service.state).toMatchObject({taskStatus:'complete',failure:undefined,error:null,execution:{model:'sidebar'}});
  });
});
