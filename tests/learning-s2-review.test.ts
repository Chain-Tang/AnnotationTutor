import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningV3Store, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { LearningCommandsV3, type LearningCommandResult } from "../src/learning-commands-v3.js";
import { LearningDialogueV3 } from "../src/learning-dialogue-v3.js";
import { hasLocalLearnerAuthority, localLearnerAuthority } from "../src/learning-control-v3.js";
import { learningContext, type LearningContextSnapshot } from "../src/learning-context.js";
import { lessonFor } from "../src/learning-episode.js";
import { learningExpertPrompt, parseExpertReview, type LearningExpertKind } from "../src/learning-experts.js";
import { TutorTaskCoordinator, type TaskTarget, type TutorTask, type AgentAdapter } from "../src/tutor-task.js";
import { TutorCollaboration } from "../src/tutor-collaboration.js";
import type { TutorRunnerInput } from "../src/tutor-conversation.js";

// Reproduction harness executes the actual host method. Only persistence and
// execution transport are test doubles; this is not a real-model acceptance.
const source=readFileSync(new URL("../src/main.ts",import.meta.url),"utf8"),start=source.indexOf("  private async runNaturalLearningExpert("),end=source.indexOf("\n  private async runTutorTransport(",start);
if(start<0||end<0)throw new Error("Expert host fixture needs updated method boundaries");
const module={exports:{}};
const dependencies={hasLocalLearnerAuthority,renderQuestionV3,lessonFor,learningExpertPrompt,parseExpertReview};
new Function("module",...Object.keys(dependencies),transformSync(`class Host {${source.slice(start,end)}}; module.exports=Host;`,{loader:"ts",format:"cjs"}).code)(module,...Object.values(dependencies));
type Scene={target:TaskTarget;objects:Array<Record<string,unknown>>;selection:string[]};
type Scope={signal?:AbortSignal;key?:string;evidenceRevision?:string;context:string;target:TaskTarget;current:()=>Promise<boolean>};
type Host={
  settings:{learningExpertsEnabled:boolean};learningDialogue:LearningDialogueV3;tutorConversation:{tasks:TutorTaskCoordinator};tutorResults?:{flush:()=>Promise<void>};
  learningContextSnapshot(query:{episodeId:string}):Promise<LearningContextSnapshot>;
  tutorContext(path:string,start:number,length:number):Promise<{source:string;start:number;end:number;text:string;revision:string}>;
  tutorSurfaces():Promise<Array<{id:string;read:()=>Promise<Scene>}>>;
  delegateTutorToCodex(prompt:string,selected:string[],scope:Scope):Promise<TutorTask>;
  runNaturalLearningExpert(episode:EpisodeV3,kind:LearningExpertKind,input:TutorRunnerInput):Promise<string|{text:string;commit?:LearningCommandResult}>;
};
const Host=module.exports as {new():Host};
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
async function fixture(){
  const files=new Map<string,string>();
  const io={read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+"/")),write:async(p:string,n:string)=>{files.set(p,n);},compareWrite:async(p:string,b:string|null,n:string)=>{if((files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};
  const store=new LearningV3Store(io,"learning/v3/episodes"),commands=new LearningCommandsV3(store),dialogue=new LearningDialogueV3(commands),authority=localLearnerAuthority(),conversationId=crypto.randomUUID(),source={path:"math.md",version:"v1"};
  const invitation=commands.offer({authority,conversationId,source,requestId:crypto.randomUUID(),concept:"value-limit"});
  let episode=(await commands.accept(invitation,{authority,conversationId,source,requestId:crypto.randomUUID()})).episode;
  episode.links.push({kind:"drawing",taskId:crypto.randomUUID(),targetId:"board:math",questionId:episode.currentQuestionId,at:new Date().toISOString(),state:"current",evidenceIds:[]});
  episode=await store.save(episode);
  const tasks=new TutorTaskCoordinator(),controller=new AbortController(),host=new Host();cleanups.push(()=>tasks.dispose());
  let version="v1";
  const scene:Scene={target:{id:"board:math",source:source.path,revision:"scene-v1",surface:"document"},objects:[{id:"line-1",type:"path",points:[[0,0],[1,1]]}],selection:[]};
  Object.assign(host,{settings:{learningExpertsEnabled:true},learningDialogue:dialogue,tutorConversation:{tasks},tutorResults:{flush:async()=>{}},
    learningContextSnapshot:async(query:{episodeId:string})=>{const read=await store.readEffectiveResult();return learningContext(read,query,read.protectionByEpisode);},
    tutorContext:async()=>({source:source.path,start:0,end:4,text:"Math",revision:version}),
    tutorSurfaces:async()=>[{id:scene.target.id,read:async()=>structuredClone(scene)}],
  });
  const review=JSON.stringify({version:1,verdict:"supported",evidence:[{claim:"The displayed relation agrees with the stated formula.",sourceRef:source.path}],suggestions:[],uncertainties:[]});
  const delegate=vi.fn(async(_prompt:string,_selected:string[],scope:Scope)=>{
    const task=tasks.start({clientId:"obsidian",target:scope.target,key:scope.key});
    tasks.complete(task.id,"obsidian",[{id:crypto.randomUUID(),type:"text",data:{text:review,reviewStatus:"current",evidenceRevision:scope.evidenceRevision}}]);
    return tasks.get(task.id,"obsidian");
  });
  host.delegateTutorToCodex=delegate;
  const input:TutorRunnerInput={text:"请专家核对这道题",history:[],historyOffset:0,signal:controller.signal,onReply:()=>true,onEvent:()=>{},
    options:{learningRequestId:crypto.randomUUID(),learningTurn:{entry:"sidebar",kind:"conversation",authority}}};
  const stored=()=>JSON.parse(files.get(`${store.root}/${episode.id}.json`)!) as EpisodeV3;
  return {host,episode,commands,store,controller,scene,delegate,input,stored,setVersion:(value:string)=>{version=value;}};
}

describe("S2 expert host release guards",()=>{
  it("links one validated, current result through the shared evidence command",async()=>{
    const f=await fixture(),result=await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input);
    expect(result).toMatchObject({text:expect.stringContaining("独立核对结果"),commit:{episode:{id:f.episode.id}}});
    expect(f.delegate).toHaveBeenCalledOnce();expect(f.stored().links.filter(link=>link.kind==="expert")).toHaveLength(1);
  });
  it("does not launch a model task when cancelled during an awaited source read",async()=>{
    const f=await fixture(),read=f.host.tutorContext.bind(f.host);
    vi.spyOn(f.host,"tutorContext").mockImplementation(async(...args)=>{const result=await read(...args);f.controller.abort();return result;});
    await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input).catch(()=>{});
    expect(f.delegate.mock.calls.length).toBe(0);expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
  });
  it("does not attach a current review after its source changed with delayed watch delivery",async()=>{
    const f=await fixture(),delegate=f.delegate.getMockImplementation()!;
    vi.spyOn(f.host,"delegateTutorToCodex").mockImplementation(async(...args)=>{const result=await delegate(...args);f.setVersion("v2");return result;});
    const result=await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input);
    expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
    expect(typeof result==="string"?result:result.text).not.toContain("独立核对结果");
  });
  it("does not attach a current diagram review after its selected scene changed",async()=>{
    const f=await fixture(),delegate=f.delegate.getMockImplementation()!;
    vi.spyOn(f.host,"delegateTutorToCodex").mockImplementation(async(...args)=>{const result=await delegate(...args);f.scene.target.revision="scene-v2";return result;});
    await f.host.runNaturalLearningExpert(f.episode,"diagram",f.input);
    expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
  });
  it("applies the object bound to the selected set as well as unselected scenes",async()=>{
    const f=await fixture();f.scene.objects=Array.from({length:129},(_,i)=>({id:`object-${i}`,type:"path"}));f.scene.selection=f.scene.objects.map(object=>String(object.id));
    await f.host.runNaturalLearningExpert(f.episode,"diagram",f.input);
    expect(f.delegate.mock.calls.length).toBe(0);expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
  });
  it("bounds serialized expert material even when a single path is selected",async()=>{
    const f=await fixture();f.scene.objects=[{id:"dense-path",type:"path",points:Array.from({length:6000},(_,i)=>({x:i,y:i/2}))}];f.scene.selection=["dense-path"];
    await f.host.runNaturalLearningExpert(f.episode,"diagram",f.input);
    expect(f.delegate.mock.calls.length).toBe(0);expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
  });
});

// The real delegate starts experts synchronously, then awaits result persistence.
// Keep the transport pending to observe cancellation during that exact interval.
const delegateStart=source.indexOf("  public async delegateTutorToCodex("),delegateEnd=source.indexOf("\n  public async recoverLocalDrawing(",delegateStart);
if(delegateStart<0||delegateEnd<0)throw new Error("Delegate host fixture needs updated method boundaries");
class WaitingAdapter implements AgentAdapter {
  id="codex";
  constructor(_config:unknown){}
  capabilities=async()=>({vision:false,tools:false,streaming:true});
  run(input:Parameters<AgentAdapter["run"]>[0]):ReturnType<AgentAdapter["run"]>{return new Promise((_resolve,reject)=>{const cancel=()=>reject(new DOMException("Cancelled","AbortError"));if(input.signal.aborted)cancel();else input.signal.addEventListener("abort",cancel,{once:true});});}
  dispose(){}
}
const delegateModule={exports:{}};
const delegateDependencies={TutorCollaboration,DirectTutorAdapter:WaitingAdapter,AcpTutorAdapter:WaitingAdapter,CodexAppServerAdapter:WaitingAdapter,A2AAgentAdapter:WaitingAdapter,tmpdir:()=>"/tmp",nodeHttpStream:()=>{},resolveBoardConnection:()=>({engine:"api",model:"test"})};
new Function("module",...Object.keys(delegateDependencies),transformSync(`class Host {${source.slice(delegateStart,delegateEnd)}}; module.exports=Host;`,{loader:"ts",format:"cjs"}).code)(delegateModule,...Object.values(delegateDependencies));
const DelegateHost=delegateModule.exports as {prototype:{delegateTutorToCodex:Host["delegateTutorToCodex"]}};
function barrier(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});return {entered,release,wait:async()=>{enter();await released;}};}
it("cancels an already launched expert while initial result persistence is still pending",async()=>{
  const f=await fixture(),blocked=barrier();
  Object.assign(f.host,{app:{workspace:{getActiveFile:()=>null}},settings:{learningExpertsEnabled:true,chatEngine:"api",apiModel:"test"},agentSpawnEnv:()=>({}),recoveredExpertRoots:new Set<string>(),saveExpertResult:()=>blocked.wait()});
  f.host.delegateTutorToCodex=DelegateHost.prototype.delegateTutorToCodex;
  const pending=f.host.runNaturalLearningExpert(f.episode,"explanation",f.input).catch(()=>{});
  await blocked.entered;f.controller.abort();
  const roots=f.host.tutorConversation.tasks.list("obsidian").filter(task=>!task.parentId);
  try{expect(roots).toHaveLength(1);expect(roots[0]!.state).toBe("cancelled");expect(f.host.tutorConversation.tasks.list("obsidian").every(task=>task.state==="cancelled")).toBe(true);}
  finally{blocked.release();await pending;}
});

it("keeps a delegated expert cancellable after initial persistence returns the handle",async()=>{
 const f=await fixture();Object.assign(f.host,{app:{workspace:{getActiveFile:()=>null}},settings:{learningExpertsEnabled:true,chatEngine:"api",apiModel:"test"},agentSpawnEnv:()=>({}),recoveredExpertRoots:new Set<string>(),saveExpertResult:async()=>{}});
 f.host.delegateTutorToCodex=DelegateHost.prototype.delegateTutorToCodex;
 const task=await f.host.delegateTutorToCodex("check",["codex"],{key:"live-scope",context:"authorized",target:{id:"lesson",source:f.episode.source.path,revision:"v1",surface:"document"},current:async()=>true,signal:f.controller.signal});
 expect(f.host.tutorConversation.tasks.get(task.id,"obsidian").state).toBe("working");f.controller.abort();
 expect(f.host.tutorConversation.tasks.list("obsidian").every(task=>task.state==="cancelled")).toBe(true);
});

describe("S2 expert explanation observation scope",()=>{
  it("checks explicitly selected current material without guessing its authorship or sharing unrelated context",async()=>{
    const f=await fixture(),selection="函数在该点的取值不同，但左右极限都等于 9。";
    f.input.text="请独立专家检查所选解释。CURRENT_INPUT_PRIVATE";
    const read=f.host.tutorContext.bind(f.host);vi.spyOn(f.host,"tutorContext").mockImplementation(async(...args)=>({...await read(...args),text:"UNSELECTED_SOURCE_PRIVATE"}));
    f.input.options.context={chat:{selectionBound:true,notePath:f.episode.source.path,selection,content:"INCIDENTAL_FULL_CONTEXT_PRIVATE",profileSummary:"PROFILE_PRIVATE",sceneSummary:"SCENE_PRIVATE",observation:{source:f.episode.source.path,version:"v1",scope:"selection",hasImage:false}}};
    const result=await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input);
    expect(f.delegate.mock.calls.length).toBe(1);
    const context=JSON.parse(f.delegate.mock.calls[0]![2].context) as Record<string,unknown>;
    expect(context.reviewSubject).toEqual({kind:"selected-material",source:f.episode.source.path,revision:"v1",text:selection});
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE/);
    expect(typeof result==="string"?result:result.text).toContain("所选材料");
  });
  it.each(["unbound","none"] as const)("keeps a %s selection out of the expert request and honestly reviews the source and question",async mode=>{
    const f=await fixture();f.input.text="ORDINARY_PRIVATE_TEXT";
    f.input.options.context={chat:mode==="unbound"?{selectionBound:false,notePath:f.episode.source.path,selection:"UNBOUND_PRIVATE_SELECTION",observation:{source:f.episode.source.path,version:"v1",scope:"selection",hasImage:false}}:{profileSummary:"PROFILE_PRIVATE"}};
    const result=await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input);
    expect(f.delegate.mock.calls.length).toBe(1);
    const [prompt,,scope]=f.delegate.mock.calls[0]!;const context=JSON.parse(scope.context) as Record<string,unknown>;
    expect(context.reviewSubject).toEqual({kind:"source-question",source:f.episode.source.path,revision:"v1",questionId:f.episode.currentQuestionId});
    expect(scope.context).not.toMatch(/PRIVATE/);expect(prompt).toMatch(/no learner explanation|not supplied|not provided/i);
    expect(typeof result==="string"?result:result.text).toContain("当前材料与题目");
  });
  it.each(["stale","wrong-source","oversized"] as const)("does not review a %s explicitly bound excerpt",async cause=>{
    const f=await fixture();const path=cause==="wrong-source"?"other.md":f.episode.source.path;
    f.input.options.context={chat:{selectionBound:true,notePath:path,selection:cause==="oversized"?"x".repeat(6001):"explicit selected explanation",observation:{source:path,version:cause==="stale"?"old":"v1",scope:"selection",hasImage:false}}};
    await f.host.runNaturalLearningExpert(f.episode,"explanation",f.input).catch(()=>{});
    expect(f.delegate.mock.calls.length).toBe(0);expect(f.stored().links.filter(link=>link.kind==="expert")).toEqual([]);
  });
});
