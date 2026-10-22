import { describe, expect, it } from "vitest";
import { createEpisodeV3, LearningV3Store, questionRefV3 } from "../src/learning-v3.js";
import { createEpisodeV2, LearningV2Store } from "../src/learning-v2.js";
import { instantiateQuestion } from "../src/learning-question-bank-v2-2.js";
import type { LearningIO } from "../src/learning-record-read.js";
import { createEpisode } from "../src/learning-episode.js";
import { LearningEpisodeStore } from "../src/learning-episode-store.js";

function memory(){
  const files=new Map<string,string>();
  const io:LearningIO={read:async p=>files.get(p)??null,list:async root=>[...files.keys()].filter(p=>p.startsWith(root+"/")),write:async(p,text)=>{files.set(p,text);},compareWrite:async(p,previous,next)=>{if((files.get(p)??null)!==previous)throw new Error("external-conflict");files.set(p,next);}};
  return {files,io};
}
const episode=()=>createEpisodeV3({path:"Synthetic/math.md",version:"v1"},questionRefV3("value-limit","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),invitationId:crypto.randomUUID()});

describe("learning cross-store durability audit",()=>{
  it("a stale failed writer cannot replace the newer acknowledged previous revision",async()=>{
    const {files,io}=memory(),root="v3",writer=new LearningV3Store(io,root),saved=await writer.save(episode()),path=`${root}/${saved.id}.json`;
    let notify=()=>{},release=()=>{};
    const reached=new Promise<void>(r=>notify=r),blocked=new Promise<void>(r=>release=r);
    let first=true;
    const staleIO:LearningIO={...io,read:async p=>{if(first&&p===path+".deleted"){first=false;notify();await blocked;}return io.read(p);}};
    const staleStore=new LearningV3Store(staleIO,root);
    const attempt=staleStore.save({...saved,status:"paused"});
    const rejected=expect(attempt).rejects.toThrow("external-conflict");await reached;
    const withHelp=structuredClone(saved),requestId=crypto.randomUUID();withHelp.requests.push(requestId);
    withHelp.help.push({id:crypto.randomUUID(),requestId,questionId:saved.currentQuestionId,at:saved.createdAt,sequence:1,kind:"hint",state:"prepared",presentationId:crypto.randomUUID()});
    const newer=await writer.save(withHelp);await writer.save({...newer,status:"paused"});
    const previous=files.get(path+".previous"),primary=files.get(path);
    release();await rejected;
    expect(files.get(path)).toBe(primary);
    expect(files.get(path+".previous")).toBe(previous);
    files.set(path,"{interrupted");
    const recovered=(await new LearningV3Store(io,root).list())[0]!;
    expect(recovered.revision).toBe(newer.revision);expect(recovered.help).toHaveLength(1);
  });

  it("does not archive a stale v2 candidate that rewrites historical unreceipted evidence",async()=>{
    const {files,io}=memory(),root="v2",q=instantiateQuestion("value-limit","practice"),now=new Date().toISOString();
    const old=createEpisodeV2({path:"Synthetic/math.md",version:"v1"},q,{at:now,requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()});
    old.revision=1;old.evidence.push({id:crypto.randomUUID(),requestId:crypto.randomUUID(),questionId:q.id,at:now,answer:"9",help:{hints:0,answerShown:false},kind:"unassisted",evaluator:"deterministic",outcome:"correct",feedback:"Canonical historical feedback"});
    const path=`${root}/${old.id}.json`;files.set(path,JSON.stringify(old));
    const a=new LearningV2Store(io,root),b=new LearningV2Store(io,root),stale=(await a.list())[0]!;
    await b.save({...stale,status:"paused"});
    const before=new Map(files);stale.evidence[0]!.answer="SYNTHETIC_NEW_PRIVATE_PROSE";
    await expect(a.save(stale)).rejects.toThrow();
    expect(files).toEqual(before);
  });

  it.each([1,2] as const)("v%i also protects the newest backup from a stale failed writer",async format=>{
    async function check<T extends {id:string;revision:number}>(initial:T,make:(io:LearningIO)=>{save:(record:T)=>Promise<T>}){
      const {files,io}=memory(),writer=make(io),saved=await writer.save(initial),path=`episodes/${saved.id}.json`;
      let notify=()=>{},release=()=>{},first=true;
      const reached=new Promise<void>(r=>notify=r),blocked=new Promise<void>(r=>release=r);
      const stale=make({...io,read:async p=>{if(first&&p===path+".deleted"){first=false;notify();await blocked;}return io.read(p);}});
      const attempt=stale.save(saved),rejected=expect(attempt).rejects.toThrow("external-conflict");await reached;
      const newer=await writer.save(saved);await writer.save(newer);
      const expected=files.get(path+".previous");release();await rejected;
      expect(files.get(path+".previous")).toBe(expected);expect(JSON.parse(expected!).revision).toBe(newer.revision);
    }
    if(format===1)await check(createEpisode({path:"Synthetic/math.md",version:"1"},"value-limit"),io=>new LearningEpisodeStore(io,"episodes"));
    else await check(createEpisodeV2({path:"Synthetic/math.md",version:"1"},instantiateQuestion("value-limit","practice"),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()}),io=>new LearningV2Store(io,"episodes"));
  });

  it("preserves an unknown newer backup and refuses to overwrite it",async()=>{
    const {files,io}=memory(),store=new LearningV3Store(io,"v3"),saved=await store.save(episode()),path=`v3/${saved.id}.json`;
    const future=JSON.stringify({...saved,format:4,revision:90});files.set(path+".previous",future);const primary=files.get(path);
    await expect(store.save({...saved,status:"paused"})).rejects.toThrow("unsupported-format");
    expect(files.get(path)).toBe(primary);expect(files.get(path+".previous")).toBe(future);
  });

  it("cannot replace a backup that becomes a deleted record at the backup CAS boundary",async()=>{
    const {files,io}=memory(),store=new LearningV3Store(io,"v3"),saved=await store.save(episode()),path=`v3/${saved.id}.json`;
    const deleted=JSON.stringify({...saved,revision:saved.revision+1,status:"deleted"}),compare=io.compareWrite;
    io.compareWrite=async(p,previous,next)=>{if(p===path+".previous"){files.set(path+".deleted","barrier");files.set(p,deleted);}await compare(p,previous,next);};
    await expect(store.save({...saved,status:"paused"})).rejects.toThrow("external-conflict");
    expect(files.get(path+".previous")).toBe(deleted);expect(await new LearningV3Store(io,"v3").list()).toEqual([]);
  });

  it("a preallocated episode ID prevents concurrent first acceptance from creating two records",async()=>{
    const {files,io}=memory(),root="v3",one=episode(),two=structuredClone(one);
    two.consent.requestId=crypto.randomUUID();two.requests=[two.consent.requestId];
    const results=await Promise.allSettled([new LearningV3Store(io,root).save(one),new LearningV3Store(io,root).save(two)]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const records=await new LearningV3Store(io,root).list();expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({id:one.id,currentQuestionId:one.currentQuestionId,consent:{invitationId:one.consent.invitationId}});
    expect([...files.keys()].filter(p=>p.startsWith(root+"/")&&!p.slice(root.length+1).includes("/")&&p.endsWith(".json"))).toHaveLength(1);
  });

  it("the deletion barrier prevents a late CAS from resurrecting an in-flight record",async()=>{
    const {files,io}=memory(),root="v3",store=new LearningV3Store(io,root),saved=await store.save(episode()),path=`${root}/${saved.id}.json`;
    const compare=io.compareWrite;
    io.compareWrite=async(p,previous,next)=>{files.set(path+".deleted",JSON.stringify({id:saved.id,at:saved.updatedAt}));await compare(p,previous,next);};
    await store.save({...saved,status:"paused"}).catch(()=>{});
    const reopened=new LearningV3Store(io,root);expect(await reopened.list()).toEqual([]);
    await expect(reopened.save(saved)).rejects.toThrow("deleted");
  });
});
