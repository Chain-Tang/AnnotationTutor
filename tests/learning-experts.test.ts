import {it,expect,vi} from "vitest";
import {createEpisode} from "../src/learning-episode.js";
import {learningExpertContext,learningExpertPrompt,parseExpertReview} from "../src/learning-experts.js";
import {TutorCollaboration} from "../src/tutor-collaboration.js";
import {TutorTaskCoordinator,type AgentAdapter} from "../src/tutor-task.js";
const episode=()=>createEpisode({path:"limits.md",version:"1"},"value-limit");
it("shares only the requested lesson, bounded excerpt and selected diagram objects",()=>{
  const e={...episode(),supportSummary:"NEVER_SHARE",profile:"private",chatHistory:["old"]};
  const context=learningExpertContext(e,{source:"limits.md",revision:"1",text:"authorized"},{target:{id:"b",revision:"r"},objects:[{id:"a",text:"chosen"},{id:"b",text:"unselected secret"}],selection:["a"]});
  expect(context).toContain("chosen");for(const secret of ["NEVER_SHARE","profile","chatHistory","unselected secret"])expect(context).not.toContain(secret);
});
it("rejects a wrong source or an unbounded scene",()=>{expect(()=>learningExpertContext(episode(),{source:"other.md",revision:"1",text:"wrong"})).toThrow("source-mismatch");expect(()=>learningExpertContext(episode(),{source:"limits.md",revision:"1",text:"ok"},{target:{id:"b",revision:"1"},objects:Array.from({length:129},(_,i)=>({id:String(i)})),selection:[]})).toThrow("smaller-region");});
it("requires separate evidence, suggestions and uncertainty without creating mastery scores",()=>{const review=parseExpertReview('{"version":1,"verdict":"needs-correction","evidence":[{"claim":"f(2) is not the limit","sourceRef":"limits.md"}],"suggestions":["Use the nearby values"],"uncertainties":[]}');expect(review.verdict).toBe("needs-correction");expect(()=>parseExpertReview('{"score":100}')).toThrow();expect(learningExpertPrompt("research")).toContain("no browsing");});
it("a failed expert cannot be passed off as a successful child; Tutor can retain a partial draft",async()=>{
  const tasks=new TutorTaskCoordinator(5000);const failed:AgentAdapter={id:"codex",capabilities:async()=>({vision:false,tools:false,streaming:true}),run:async()=>{throw new Error("offline");},dispose(){}};
  const lead:AgentAdapter={id:"tutor",capabilities:failed.capabilities,run:vi.fn(async()=>[{id:"draft",type:"text" as const,data:{text:"Expert unavailable; uncertain."}}]),dispose(){}};
  const root=new TutorCollaboration(tasks).start({clientId:"test",context:"scoped",prompt:"check",lead,experts:[failed]});
  await vi.waitFor(()=>expect(tasks.get(root.id,"test").state).toBe("completed"));const final=tasks.get(root.id,"test");expect(tasks.get(final.children[0]!,"test").state).toBe("failed");expect(final.artifacts).toHaveLength(1);tasks.dispose();
});
it("cancelling a learning check rejects late expert output",async()=>{
  const tasks=new TutorTaskCoordinator(5000);let finish:(value:[])=>void=()=>{};const expert:AgentAdapter={id:"codex",capabilities:async()=>({vision:false,tools:false,streaming:true}),run:()=>new Promise(r=>finish=r),dispose(){}};
  const lead={...expert,id:"tutor",run:vi.fn(async()=>[])};const task=new TutorCollaboration(tasks).start({clientId:"a",context:"",prompt:"",lead,experts:[expert]});tasks.cancel(task.id,"a");finish([]);await new Promise(r=>setTimeout(r,0));expect(tasks.get(task.id,"a").state).toBe("cancelled");expect(lead.run).not.toHaveBeenCalled();expect(tasks.get(task.id,"a").artifacts).toHaveLength(0);tasks.dispose();
});

it("keeps the caller cancellation bound after returning a task handle and rejects late expert products",async()=>{
 const tasks=new TutorTaskCoordinator(5000),controller=new AbortController();let finish!:(value:[])=>void,signal!:AbortSignal;
 const expert:AgentAdapter={id:"codex",capabilities:async()=>({vision:false,tools:false,streaming:true}),run:input=>{signal=input.signal;return new Promise(resolve=>{finish=resolve;});},dispose(){}};
 const lead={...expert,id:"tutor",run:vi.fn(async()=>[])};
 const task=new TutorCollaboration(tasks).start({clientId:"a",key:"cancel-scope",context:"scoped",prompt:"review",signal:controller.signal,lead,experts:[expert]});
 await Promise.resolve();controller.abort();expect(signal.aborted).toBe(true);expect(tasks.get(task.id,"a").state).toBe("cancelled");
 finish([]);await new Promise(resolve=>setTimeout(resolve,0));expect(lead.run).not.toHaveBeenCalled();expect(tasks.get(task.id,"a").artifacts).toEqual([]);tasks.dispose();
});
it("a cancelled scope cannot start a model or create a task, and cancellation after completion preserves results",async()=>{
 const tasks=new TutorTaskCoordinator(5000),cancelled=new AbortController();cancelled.abort();
 const adapter=(id:string):AgentAdapter=>({id,capabilities:async()=>({vision:false,tools:false,streaming:true}),run:vi.fn(async()=>[{id:"result",type:"text" as const,data:{text:"done"}}]),dispose:vi.fn()});
 const lead=adapter("tutor"),expert=adapter("codex");
 expect(()=>new TutorCollaboration(tasks).start({clientId:"a",prompt:"",context:"",signal:cancelled.signal,lead,experts:[expert]})).toThrow("Cancelled");expect(tasks.list("a")).toEqual([]);expect(lead.run).not.toHaveBeenCalled();expect(expert.dispose).toHaveBeenCalled();
 const controller=new AbortController(),root=new TutorCollaboration(tasks).start({clientId:"a",prompt:"",context:"",signal:controller.signal,lead,experts:[expert]});
 await vi.waitFor(()=>expect(tasks.get(root.id,"a").state).toBe("completed"));const before=tasks.get(root.id,"a");controller.abort();expect(tasks.get(root.id,"a")).toEqual(before);tasks.dispose();
});

it("normalizes model delimiter width without changing quoted evidence or accepting arbitrary fields",()=>{const review=parseExpertReview('{"version":1,"verdict":"needs-correction","evidence":[{"claim":"原文保留［中文］","sourceRef":"limits.md"}］,"suggestions":[],"uncertainties":[]}');expect(review.evidence[0]?.claim).toBe("原文保留［中文］");expect(()=>parseExpertReview('{"version":1,"verdict":"supported","evidence":[],"suggestions":[],"uncertainties":[],"override":true}')).toThrow();});
