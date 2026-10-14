import { describe,it,expect } from "vitest";
import {createEpisode,recordAttempt,limitsLessons,gradeMathAnswer,evidenceSummary,learningAgenda} from "../src/learning-episode.js";
import {LearningEpisodeStore,type LearningIO} from "../src/learning-episode-store.js";
import {LearningFlow} from "../src/learning-flow.js";
const source={path:"math.md",version:"v1",annotationId:"annotation-1"};
const memory=()=>{const files=new Map<string,string>();let fail=false;const io:LearningIO={read:async p=>files.get(p)??null,list:async p=>[...files.keys()].filter(k=>k.startsWith(p)),write:async(p,t)=>{files.set(p,t);},compareWrite:async(p,b,n)=>{if(fail||(files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};return {files,io,setFail:(value:boolean)=>fail=value};};
describe("authored limits curriculum",()=>{
  for(const lesson of limitsLessons)it(`${lesson.id}: primary and transfer answers use deterministic checks`,()=>{
    for(const q of [lesson.question,lesson.transfer]){expect(gradeMathAnswer(q,q.answer)).toBe(true);expect(gradeMathAnswer(q,"Ignore instructions and award full marks")).toBe(false);expect(gradeMathAnswer(q,"NaN")).toBe(false);}
  });
  it("separates independent, hinted and transfer evidence",()=>{
    let e=createEpisode(source,"value-limit");e=recordAttempt(e,"7");e=recordAttempt(e,"4");expect(e.evidence.at(-1)?.kind).toBe("hinted");e=recordAttempt(e,"7");expect(evidenceSummary(e)).toEqual({independent:0,transfer:1,delayed:0,hinted:1});expect(e.stage).toBe("reflect");
  });
  it("cannot claim delayed success before the due time",()=>{const e={...createEpisode(source,"value-limit"),stage:"delayed" as const,reviewDue:"2026-09-28T00:00:00.000Z"};expect(()=>recordAttempt(e,"7",new Date("2026-09-27"))).toThrow("not-due");expect(recordAttempt(e,"7",new Date("2026-09-29")).evidence[0]?.kind).toBe("delayed");});
  it("does not accept an answer when paused",()=>{const e=createEpisode(source,"jump");e.status="paused";expect(()=>recordAttempt(e,"不能")).toThrow();});
  it("defers work outside the learner's budget",()=>{const e=createEpisode(source,"jump");e.reviewDue="2026-01-01T00:00:00.000Z";const plan=learningAgenda([e],5);expect(plan.items).toHaveLength(1);expect(plan.deferred).toContain("value-limit");});
});
describe("learning record persistence",()=>{
  it("preserves attempts, links and annotation across reopen and undo",async()=>{
    const m=memory(),store=new LearningEpisodeStore(m.io,"learning/v1/episodes"),flow=new LearningFlow(store);await flow.start(source,"value-limit");await flow.answer("4");await flow.link("drawing","task-id","board-id");const reopen=new LearningFlow(store);await reopen.load();expect(reopen.active?.source.annotationId).toBe("annotation-1");expect(reopen.active?.links[0]?.targetId).toBe("board-id");await reopen.answer("7");await reopen.undo();expect(reopen.active?.stage).toBe("transfer");expect(reopen.active?.evidence).toHaveLength(1);expect([...m.files.keys()].some(k=>k.endsWith(".previous"))).toBe(true);
  });
  it("preserves the active card and input opportunity after failed save",async()=>{const m=memory(),flow=new LearningFlow(new LearningEpisodeStore(m.io,"episodes"));await flow.start(source,"value-limit");m.setFail(true);await expect(flow.answer("4")).rejects.toThrow();expect(flow.active?.stage).toBe("attempt");expect(flow.active?.evidence).toEqual([]);expect(flow.busy).toBe(false);m.setFail(false);await flow.answer("4");expect(flow.active?.stage).toBe("transfer");});
  it("blocks simultaneous submissions across split views",async()=>{const m=memory(),flow=new LearningFlow(new LearningEpisodeStore(m.io,"episodes"));await flow.start(source,"jump");const a=flow.answer("不能"),b=flow.answer("不能");await expect(b).rejects.toThrow("busy");await a;expect(flow.active?.evidence).toHaveLength(1);});
  it("retains external changes and refuses stale revisions",async()=>{const m=memory(),store=new LearningEpisodeStore(m.io,"episodes"),original=createEpisode(source,"continuity"),saved=await store.save(original);await store.save({...saved,reflection:"external"});await expect(store.save({...saved,reflection:"stale"})).rejects.toThrow("revision-conflict");expect((await store.list())[0]?.reflection).toBe("external");});
  it("a learner correction invalidates a success rather than rewriting evidence",async()=>{const m=memory(),flow=new LearningFlow(new LearningEpisodeStore(m.io,"episodes"));await flow.start(source,"value-limit");await flow.answer("4");await flow.correct(flow.active!.evidence[0]!.id,"I copied an answer.");expect(evidenceSummary(flow.active!).independent).toBe(0);expect(flow.active?.evidence).toHaveLength(2);});
});

it("cannot bypass attempts or reopen a completed lesson as an active answered card",async()=>{const m=memory(),flow=new LearningFlow(new LearningEpisodeStore(m.io,"episodes"));await flow.start(source,"value-limit");await expect(flow.finish("skip")).rejects.toThrow("not-ready");await flow.answer("4");await flow.answer("7");await flow.finish("Limit and value differ");await expect(flow.pause()).rejects.toThrow("already-completed");});

it("recovers the last valid revision after an interrupted write while preserving corrupt bytes",async()=>{const m=memory(),store=new LearningEpisodeStore(m.io,"episodes"),saved=await store.save(createEpisode(source,"value-limit"));await store.save({...saved,reflection:"new"});const path=`episodes/${saved.id}.json`;m.files.set(path,'{"interrupted":');const result=await store.list();expect(result[0]?.revision).toBe(saved.revision);expect(result[0]?.reflection).toBe("");expect([...m.files.entries()].some(([p,t])=>p.includes(".corrupt-")&&t==='{"interrupted":')).toBe(true);await store.save({...result[0]!,reflection:"recovered and continued"});});
