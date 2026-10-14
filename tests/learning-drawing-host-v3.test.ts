import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningV3Store, type EpisodeV3 } from "../src/learning-v3.js";
import { LearningCommandsV3, learningPhaseId } from "../src/learning-commands-v3.js";
import { LearningDialogueV3 } from "../src/learning-dialogue-v3.js";
import { hasLocalLearnerAuthority, localLearnerAuthority } from "../src/learning-control-v3.js";
import { LearningInvalidation } from "../src/learning-invalidation.js";
import { learningContext, type LearningContextQuery, type LearningContextSnapshot } from "../src/learning-context.js";
import { TutorTaskCoordinator, type TaskTarget } from "../src/tutor-task.js";
import type { SurfaceCommitReceipt } from "../src/tutor-surface.js";
import type { TutorBoardRunInput } from "../src/tutor-conversation.js";

// Execute the real main wrapper with memory-only storage and actual task/store
// lifecycles. The injected drawing is a test double, never a model or real app.
const source=readFileSync(new URL("../src/main.ts",import.meta.url),"utf8"),start=source.indexOf("  private async runLearningDrawing("),end=source.indexOf("\n  private async runNaturalLearningExpert(",start);
if(start<0||end<0)throw new Error("Drawing host fixture needs updated method boundaries");
const module={exports:{}};
const dependencies={hasLocalLearnerAuthority,learningPhaseId,learningContext};
new Function("module",...Object.keys(dependencies),transformSync(`class Host {${source.slice(start,end)}}; module.exports=Host;`,{loader:"ts",format:"cjs"}).code)(module,...Object.values(dependencies));
type Host={
  learningDrawingBindings:WeakMap<object,{episode:EpisodeV3;sourceVersion:string;relation:"current-question"|"uncertain"}>;
  learningDialogue:LearningDialogueV3;learningReaders:LearningInvalidation;tutorConversation:{tasks:TutorTaskCoordinator};
  learningContextSnapshot(query:LearningContextQuery):Promise<LearningContextSnapshot>;
  learningSourceRevision(source:string):Promise<string>;
  runLearningDrawing(input:TutorBoardRunInput,run:()=>Promise<{text:string}>):Promise<{text:string}>;
};
const Host=module.exports as {new():Host};
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function barrier(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),released=new Promise<void>(r=>{release=r;});return {entered,release,wait:async()=>{enter();await released;}};}
async function fixture(relation:"current-question"|"uncertain"="current-question"){
  const files=new Map<string,string>();
  const io={read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+"/")),write:async(p:string,n:string)=>{files.set(p,n);},compareWrite:async(p:string,b:string|null,n:string)=>{if((files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};
  const store=new LearningV3Store(io,"learning/v3/episodes"),commands=new LearningCommandsV3(store),dialogue=new LearningDialogueV3(commands),authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),source={path:"math.md",version:"v1"};
  const invitation=commands.offer({authority,conversationId,source,requestId:crypto.randomUUID(),concept:"value-limit"}),episode=(await commands.accept(invitation,{authority,conversationId,source,requestId:crypto.randomUUID()})).episode;
  const host=new Host(),tasks=new TutorTaskCoordinator(),readers=new LearningInvalidation(),token={},bindings=new WeakMap<object,{episode:EpisodeV3;sourceVersion:string;relation:"current-question"|"uncertain"}>();
  bindings.set(token,{episode:structuredClone(episode),sourceVersion:"v1",relation});let version="v1";
  const target:TaskTarget={id:"studio:target",source:source.path,revision:"scene-v1",surface:"studio"},task=tasks.start({clientId:"obsidian",target});
  const readState=async(query:LearningContextQuery)=>{const read=await store.readEffectiveResult();return {read,protection:read.protectionByEpisode,snapshot:learningContext(read,query,read.protectionByEpisode)};};
  Object.assign(host,{learningDialogue:dialogue,learningDrawingBindings:bindings,learningReaders:readers,tutorConversation:{tasks},
    learningReadState:readState,learningContextSnapshot:async(query:LearningContextQuery)=>(await readState(query)).snapshot,learningSourceRevision:async()=>version});
  const unsubscribe=store.subscribeCommits(change=>readers.changed(change));cleanups.push(()=>{unsubscribe();tasks.dispose();readers.clear();});
  const input:TutorBoardRunInput={text:"请用图解释当前题",history:[],historyOffset:0,taskId:task.id,target:Object.freeze(target),signal:tasks.signal(task.id,"obsidian"),onReply:()=>true,onEvent:()=>{},
    options:{learningDrawing:token,learningRequestId:crypto.randomUUID(),learningTurn:{entry:"sidebar",kind:"drawing",authority}}};
  const primary=`${store.root}/${episode.id}.json`,stored=()=>JSON.parse(files.get(primary)!) as EpisodeV3;
  const receipt=(durability:SurfaceCommitReceipt["durability"]="committed"):SurfaceCommitReceipt=>({version:1,transactionId:crypto.randomUUID(),requestId:task.id,clientId:"obsidian",targetId:target.id,baseRevision:target.revision,appliedRevision:"scene-v2",...(durability==="committed"?{committedRevision:"scene-v2"}:{}),createdIds:["shape-1"],updatedIds:[],deletedIds:[],objectRevisions:{"shape-1":"object-v1"},operationDigest:"a".repeat(64),durability});
  const record=(durability:SurfaceCommitReceipt["durability"]="committed")=>{const value=receipt(durability);tasks.recordSurfaceCommit(value);return value;};
  return {host,files,io,store,commands,dialogue,authority,episode,source,readers,tasks,task,input,token,primary,stored,receipt,record,setVersion:(next:string)=>{version=next;}};
}

describe("main drawing learning help boundary",()=>{
  it.each(["active","paused"] as const)("records conservative help before a passive observation of the %s bound question without another classifier",async status=>{
    const f=await fixture(),conversationId=crypto.randomUUID();
    Object.assign(f.host.tutorConversation,{conversationId});
    if(status==="paused")await f.commands.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:f.episode.id,questionId:f.episode.currentQuestionId,expectedRevision:f.episode.revision,source:f.source});
    const turn=await f.dialogue.prepare({authority:f.authority,conversationId,requestId:crypto.randomUUID(),entry:"sidebar",kind:"conversation",source:f.source,episodeId:f.episode.id,text:"continue"});
    expect(turn.active?.id).toBe(f.episode.id);
    const input={...f.input,text:"",options:{source:"board" as const,learningRequestId:crypto.randomUUID(),learningTurn:{entry:"board" as const,kind:"drawing" as const,authority:f.authority},context:{chat:{notePath:f.source.path,sourceBinding:"host-view",observation:{version:"v1"}}}}};
    const run=vi.fn(async()=>{expect(f.stored().help).toEqual([expect.objectContaining({kind:"related-discussion",state:"prepared",questionId:f.episode.currentQuestionId})]);return {text:"visual suggestion"};});
    await f.host.runLearningDrawing(input,run);expect(run).toHaveBeenCalledOnce();expect(f.stored().help[0]?.state).toBe("unknown");expect(f.stored().evidence).toEqual([]);
  });
  it("does not attach passive observation to an unbound document candidate",async()=>{
    const f=await fixture();Object.assign(f.host.tutorConversation,{conversationId:crypto.randomUUID()});const before=new Map(f.files),run=vi.fn(async()=>({text:"ordinary visual response"}));
    await f.host.runLearningDrawing({...f.input,text:"",options:{source:"board",learningTurn:{entry:"board",kind:"drawing",authority:f.authority},context:{chat:{notePath:f.source.path,sourceBinding:"host-view",observation:{version:"v1"}}}}},run);
    expect(run).toHaveBeenCalledOnce();expect(f.files).toEqual(before);
  });
  it("retains the saved-reference help scope across retry and rejects a foreign learning change",async()=>{
    const f=await fixture(),conversationId=crypto.randomUUID();Object.assign(f.host.tutorConversation,{conversationId});
    await f.dialogue.prepare({authority:f.authority,conversationId,requestId:crypto.randomUUID(),entry:"sidebar",kind:"conversation",source:f.source,episodeId:f.episode.id,text:"continue"});
    const input={...f.input,text:"reuse saved diagram",options:{source:"board" as const,referencePath:"references/diagram.png",learningRequestId:crypto.randomUUID(),learningTurn:{entry:"board" as const,kind:"drawing" as const,authority:f.authority},context:{chat:{notePath:f.source.path,sourceBinding:"host-view",observation:{version:"v1"}}}}};
    await expect(f.host.runLearningDrawing(input,async()=>{throw Error("offline");})).rejects.toThrow("offline");
    expect(f.stored().help[0]).toMatchObject({kind:"related-discussion",state:"unknown"});
    await f.host.runLearningDrawing(input,async()=>({text:"preview"}));expect(f.stored().help).toHaveLength(1);
    const e=f.stored();await f.commands.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:e.id,questionId:e.currentQuestionId,expectedRevision:e.revision,source:f.source});
    const run=vi.fn();await expect(f.host.runLearningDrawing(input,run)).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();
  });
  it.each(["missing-binding","wrong-source"] as const)("refuses a passive observation with %s before preview",async cause=>{
    const f=await fixture(),run=vi.fn();
    await expect(f.host.runLearningDrawing({...f.input,text:"",options:{source:"board",learningTurn:{entry:"board",kind:"drawing",authority:f.authority},context:{chat:{notePath:cause==="wrong-source"?"other.md":f.source.path,...(cause==="missing-binding"?{}:{sourceBinding:"host-view"}),observation:{version:"v1"}}}}},run)).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();
  });
  it("does not create a learning capability from a copied or forged scope object",async()=>{
    const f=await fixture(),before=new Map(f.files),run=vi.fn(async()=>({text:"ordinary drawing"}));
    const input={...f.input,options:{...f.input.options,learningDrawing:{episode:f.episode,sourceVersion:"v1",relation:"current-question"}}};
    expect(await f.host.runLearningDrawing(input,run)).toEqual({text:"ordinary drawing"});expect(run).toHaveBeenCalledOnce();expect(f.files).toEqual(before);
  });
  it("requires an actual local learner authority even with a real host scope token",async()=>{
    const f=await fixture(),before=new Map(f.files),run=vi.fn();
    const input={...f.input,options:{...f.input.options,learningTurn:{entry:"sidebar" as const,kind:"drawing" as const,authority:JSON.parse("{}")}}};
    await expect(f.host.runLearningDrawing(input,run)).rejects.toThrow("local-learner-required");expect(run).not.toHaveBeenCalled();expect(f.files).toEqual(before);
  });
  it.each(["cancelled","source-changed"] as const)("refuses a %s scope before drawing or preparing help",async cause=>{
    const f=await fixture(),before=new Map(f.files),run=vi.fn();if(cause==="cancelled")f.tasks.cancel(f.task.id,"obsidian");else f.setVersion("v2");
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();expect(f.files).toEqual(before);
  });
  it("awaits the help CAS before allowing a drawing preview",async()=>{
    const f=await fixture(),blocked=barrier(),write=f.io.compareWrite;let waited=false;
    vi.spyOn(f.io,"compareWrite").mockImplementation(async(p,b,n)=>{await write(p,b,n);if(p===f.primary&&!waited){waited=true;await blocked.wait();}});
    const run=vi.fn(async()=>{expect(f.stored().help[0]).toMatchObject({kind:"diagram",state:"prepared"});expect((await f.store.protection.read(f.episode.id)).questions.get(f.episode.currentQuestionId)?.blockedFromSequence).toBe(1);return {text:"preview"};});
    const pending=f.host.runLearningDrawing(f.input,run);await blocked.entered;expect(run).not.toHaveBeenCalled();blocked.release();await pending;
    expect(run).toHaveBeenCalledOnce();expect(f.stored().help[0]!.state).toBe("unknown");
  });
  it("cannot preview when preparing help fails even if a conservative protection sidecar was saved",async()=>{
    const f=await fixture(),write=f.io.compareWrite,before=f.files.get(f.primary),run=vi.fn();
    vi.spyOn(f.io,"compareWrite").mockImplementation(async(p,b,n)=>{if(p===f.primary)throw new Error("prepare-save-failed");await write(p,b,n);});
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toThrow("prepare-save-failed");expect(run).not.toHaveBeenCalled();expect(f.files.get(f.primary)).toBe(before);
    expect((await f.store.protection.read(f.episode.id)).questions.get(f.episode.currentQuestionId)?.blockedFromSequence).toBe(1);
  });
  it.each(["failed","cancelled"] as const)("retains unknown exposure and visible previews when drawing is %s before commit",async outcome=>{
    const f=await fixture(),previews:string[]=[];
    const pending=f.host.runLearningDrawing(f.input,async()=>{previews.push("existing-preview");if(outcome==="failed")throw new Error("drawing-failed");f.tasks.cancel(f.task.id,"obsidian");throw new DOMException("Cancelled","AbortError");});
    await expect(pending).rejects.toThrow();expect(previews).toEqual(["existing-preview"]);expect(f.stored().help[0]).toMatchObject({kind:"diagram",state:"unknown"});expect(f.stored().links).toEqual([]);
  });
  it.each(["committed","applied-not-durable","outcome-unknown","not-applied"] as const)("uses only a definite %s receipt to confirm exposure, and only durable success to link",async durability=>{
    const f=await fixture();const result=await f.host.runLearningDrawing(f.input,async()=>{f.record(durability);return {text:"drawing result"};});
    expect(result.text).toBe("drawing result");expect(f.stored().help[0]!.state).toBe(["committed","applied-not-durable"].includes(durability)?"presented":"unknown");
    expect(f.stored().links).toHaveLength(durability==="committed"?1:0);
    if(durability==="committed")expect(f.stored().links[0]).toMatchObject({kind:"drawing",taskId:f.task.id,targetId:f.input.target.id,questionId:f.episode.currentQuestionId,evidenceIds:[],state:"current"});
    expect(f.tasks.get(f.task.id,"obsidian").commit?.durability).toBe(durability);
  });
  it("does not create duplicate help or artifact links when the same request wrapper is replayed",async()=>{
    const f=await fixture(),receipt=f.receipt();
    const run=async()=>{f.tasks.recordSurfaceCommit(receipt);return {text:"same saved drawing"};};
    await f.host.runLearningDrawing(f.input,run);const before=new Map(f.files);await f.host.runLearningDrawing(f.input,run);
    expect(f.stored().help).toHaveLength(1);expect(f.stored().links).toHaveLength(1);expect(f.files).toEqual(before);
  });
  it("retries a failed drawing through only its acknowledged exposure changes",async()=>{
    const f=await fixture();
    await expect(f.host.runLearningDrawing(f.input,async()=>{throw new Error("offline");})).rejects.toThrow("offline");
    expect(f.stored().help[0]?.state).toBe("unknown");
    await f.host.runLearningDrawing(f.input,async()=>{f.record();return {text:"saved retry"};});
    expect(f.stored().help).toHaveLength(1);expect(f.stored().help[0]?.state).toBe("presented");expect(f.stored().links).toHaveLength(1);
  });
  it("rejects a foreign update before replay even though help preparation has an idempotence receipt",async()=>{
    const f=await fixture();await f.host.runLearningDrawing(f.input,async()=>({text:"preview only"}));
    const old=f.stored();await f.commands.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:old.id,questionId:old.currentQuestionId,expectedRevision:old.revision,source:old.source});
    const before=new Map(f.files),run=vi.fn();
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toMatchObject({name:"AbortError"});
    expect(run).not.toHaveBeenCalled();expect(f.files).toEqual(before);
  });
  it.each(["notified","delayed-watch"] as const)("does not adopt a %s foreign change between cleanup verification and help confirmation",async delivery=>{
    const f=await fixture(),confirm=f.commands.confirmHelp.bind(f.commands),writer=delivery==="notified"?f.commands:new LearningCommandsV3(new LearningV3Store(f.io,f.store.root));let changed=false;
    vi.spyOn(f.commands,"confirmHelp").mockImplementation(async(...args)=>{
      if(!changed){changed=true;const current=f.stored();
        await writer.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:current.id,questionId:current.currentQuestionId,expectedRevision:current.revision,source:current.source});
      }
      return confirm(...args);
    });
    await f.host.runLearningDrawing(f.input,async()=>({text:"preview only"}));
    expect(f.input.signal.aborted).toBe(delivery==="notified");expect(f.stored().status).toBe("paused");expect(f.stored().help[0]?.state).toBe("unknown");
    const next=f.tasks.start({clientId:"obsidian",target:f.input.target}),input={...f.input,taskId:next.id,signal:f.tasks.signal(next.id,"obsidian")},run=vi.fn(async()=>({text:"must not reuse revoked learning scope"}));
    await expect(f.host.runLearningDrawing(input,run)).rejects.toMatchObject({name:"AbortError"});
    expect(run).not.toHaveBeenCalled();expect(f.stored().links).toEqual([]);
  });
  it("does not treat a help replay containing a late external update as this request's acknowledgement",async()=>{
    const f=await fixture();await f.host.runLearningDrawing(f.input,async()=>({text:"first preview"}));
    // A separate writer models a disk update whose filesystem event has not yet
    // reached this window. Replay currently reads the latest record itself.
    const external=new LearningCommandsV3(new LearningV3Store(f.io,f.store.root)),prepare=f.commands.prepareHelp.bind(f.commands);let changed=false;
    vi.spyOn(f.commands,"prepareHelp").mockImplementation(async(...args)=>{
      if(!changed){changed=true;const current=f.stored();
        await external.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:current.id,questionId:current.currentQuestionId,expectedRevision:current.revision,source:current.source});
      }
      return prepare(...args);
    });
    const run=vi.fn(async()=>({text:"must not draw from stale evidence"}));
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toMatchObject({name:"AbortError"});
    expect(run).not.toHaveBeenCalled();expect(f.stored().status).toBe("paused");expect(f.stored().links).toEqual([]);
  });
  it("can retry a settled cancellation without recording help twice",async()=>{
    const f=await fixture();
    await expect(f.host.runLearningDrawing(f.input,async()=>{f.tasks.cancel(f.task.id,"obsidian");throw new DOMException("Cancelled","AbortError");})).rejects.toThrow();
    const next=f.tasks.start({clientId:"obsidian",target:f.input.target}),input={...f.input,taskId:next.id,signal:f.tasks.signal(next.id,"obsidian")};
    await f.host.runLearningDrawing(input,async()=>({text:"fresh preview"}));
    expect(f.stored().help).toHaveLength(1);expect(f.stored().help[0]?.state).toBe("unknown");expect(f.stored().links).toEqual([]);
  });
  it("confirms a late durable receipt after cancellation without attaching a new current link",async()=>{
    const f=await fixture();await f.host.runLearningDrawing(f.input,async()=>{f.tasks.cancel(f.task.id,"obsidian");f.record();return {text:"committed after cancel"};});
    expect(f.stored().help[0]!.state).toBe("presented");expect(f.stored().links).toEqual([]);expect(f.tasks.get(f.task.id,"obsidian")).toMatchObject({state:"completed",phase:"committed-after-cancel"});
  });
  it("tracks foreign evidence changes during drawing and keeps a late real receipt without a current link",async()=>{
    const f=await fixture(),blocked=barrier();
    const pending=f.host.runLearningDrawing(f.input,async()=>{await blocked.wait();f.record();return {text:"late"};});
    await blocked.entered;const current=f.stored();
    await f.commands.pause({authority:f.authority,requestId:crypto.randomUUID(),episodeId:current.id,questionId:current.currentQuestionId,expectedRevision:current.revision,source:current.source});
    expect(f.input.signal.aborted).toBe(true);blocked.release();await pending;
    expect(f.stored().status).toBe("paused");expect(f.stored().help[0]!.state).toBe("presented");expect(f.stored().links).toEqual([]);
  });
  it("does not link a saved drawing to a source version that changed while watch delivery was delayed",async()=>{
    const f=await fixture();await f.host.runLearningDrawing(f.input,async()=>{f.setVersion("v2");f.record();return {text:"saved art"};});
    expect(f.stored().help[0]!.state).toBe("presented");expect(f.stored().links).toEqual([]);expect(f.tasks.get(f.task.id,"obsidian").commit?.durability).toBe("committed");
  });
  it("checks cancellation again after the last awaited source read and before allowing preview",async()=>{
    const f=await fixture(),blocked=barrier(),run=vi.fn(async()=>({text:"must not preview"}));let calls=0;
    vi.spyOn(f.host,"learningSourceRevision").mockImplementation(async()=>{if(++calls===2)await blocked.wait();return "v1";});
    const pending=f.host.runLearningDrawing(f.input,run),rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});
    await blocked.entered;f.readers.changed({recordId:f.episode.id,sources:[f.source.path],unknownScope:false});blocked.release();await rejected;
    expect(run).not.toHaveBeenCalled();expect(f.stored().help[0]!.state).toBe("unknown");
  });
  it("rejects a protection sidecar changed after the help commit acknowledgement",async()=>{
    const f=await fixture(),prepare=f.commands.prepareHelp.bind(f.commands),run=vi.fn();
    vi.spyOn(f.commands,"prepareHelp").mockImplementation(async(...args)=>{const result=await prepare(...args);await f.store.protection.block({episodeId:f.episode.id,questions:[{ref:f.episode.questions[0]!,fromSequence:1}],reason:"external-uncertainty"});return result;});
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();expect(f.stored().links).toEqual([]);
    expect((await f.store.protection.read(f.episode.id)).questions.get(f.episode.currentQuestionId)?.reasons).toContain("external-uncertainty");
  });
  it("cannot absorb a sidecar race during the final source read as a current preview lease",async()=>{
    const f=await fixture(),run=vi.fn(async()=>({text:"must not preview"}));let calls=0;
    vi.spyOn(f.host,"learningSourceRevision").mockImplementation(async()=>{if(++calls===2)await f.store.protection.block({episodeId:f.episode.id,questions:[{ref:f.episode.questions[0]!,fromSequence:1}],reason:"external-uncertainty"});return "v1";});
    await expect(f.host.runLearningDrawing(f.input,run)).rejects.toMatchObject({name:"AbortError"});expect(run).not.toHaveBeenCalled();expect(f.stored().links).toEqual([]);
  });
  it("keeps an uncertain semantic relation conservative without inventing an objective answer",async()=>{
    const f=await fixture("uncertain");await f.host.runLearningDrawing(f.input,async()=>{f.record();return {text:"related art"};});
    expect(f.stored().help[0]).toMatchObject({kind:"related-discussion",state:"presented"});expect(f.stored().evidence).toEqual([]);
  });
});
