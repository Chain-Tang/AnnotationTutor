import { describe, expect, it } from "vitest";
import { canonicalMathAnswer, gradeCanonicalAnswer } from "../src/learning-answer.js";
import { createEpisodeV3, LEARNING_V3_MAX_BYTES, LearningV3Store, parseEpisodeV3, questionRefV3, renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import type { LearningIO } from "../src/learning-record-read.js";

function fixture(){
  const files=new Map<string,string>();
  const io:LearningIO={read:async path=>files.get(path)??null,list:async root=>[...files.keys()].filter(path=>path.startsWith(root+"/")),write:async(path,raw)=>{files.set(path,raw);},compareWrite:async(path,previous,next)=>{if((files.get(path)??null)!==previous)throw new Error("external-conflict");files.set(path,next);}};
  const root="learning/v3/episodes",store=new LearningV3Store(io,root);
  const episode=createEpisodeV3({path:"Synthetic/math.md",version:"v1"},questionRefV3("value-limit","practice",0),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),invitationId:crypto.randomUUID()});
  return {files,io,root,store,episode,path:`${root}/${episode.id}.json`};
}
function addAnswer(e:EpisodeV3,sequence=1,helpIds:string[]=[]){
  const q=renderQuestionV3(e.questions[0]!),answer=canonicalMathAnswer(q,q.answer);if(!answer)throw new Error("invalid fixture");
  const requestId=crypto.randomUUID();e.requests.push(requestId);
  e.evidence.push({id:crypto.randomUUID(),requestId,questionId:q.id,at:e.createdAt,sequence,type:"answer",answer,evaluator:"deterministic",outcome:gradeCanonicalAnswer(q,answer)?"correct":"incorrect",independence:helpIds.length?"unknown":"no-plugin-help",helpIds});
  return e;
}

describe("v3 frozen storage boundary audit",()=>{
  it("cannot reinterpret old evidence by changing the question behind its existing ID",async()=>{
    const f=fixture(),saved=await f.store.save(addAnswer(f.episode));
    const replacement=questionRefV3("value-limit","practice",15,saved.currentQuestionId);
    expect(renderQuestionV3(replacement).answer).toBe(renderQuestionV3(saved.questions[0]!).answer);
    expect(renderQuestionV3(replacement).prompt).not.toBe(renderQuestionV3(saved.questions[0]!).prompt);
    const before=f.files.get(f.path);
    await expect(f.store.save({...saved,questions:[replacement]})).rejects.toThrow();
    expect(f.files.get(f.path)).toBe(before);
  });

  it("never writes a valid candidate into a file that exceeds its own reader limit",async()=>{
    const f=fixture(),e=f.episode;
    for(let i=0;i<50;i++){
      const requestId=crypto.randomUUID();e.requests.push(requestId);
      e.help.push({id:crypto.randomUUID(),requestId,questionId:e.currentQuestionId,at:e.createdAt,sequence:i+1,kind:"hint",state:"prepared",presentationId:crypto.randomUUID()});
    }
    for(let i=0;i<195;i++)addAnswer(e,51+i,e.help.map(item=>item.id));
    expect(()=>parseEpisodeV3(e)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThan(LEARNING_V3_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(e,null,2))).toBeGreaterThan(LEARNING_V3_MAX_BYTES);
    // Either compactly save a readable record or reject before any sidecar write.
    const outcome=await f.store.save(e).then(()=>"saved",()=>"rejected");
    if(outcome==="rejected"){expect(f.files.size).toBe(0);return;}
    expect(Buffer.byteLength(f.files.get(f.path)!)).toBeLessThanOrEqual(LEARNING_V3_MAX_BYTES);
    expect((await f.store.listResult()).records[0]?.evidence).toHaveLength(e.evidence.length);
  });

  it("does not overwrite an externally changed primary when its candidate loses CAS",async()=>{
    const f=fixture(),saved=await f.store.save(f.episode),external=JSON.stringify({...saved,revision:saved.revision+1,status:"paused"});
    const compare=f.io.compareWrite;f.io.compareWrite=async(path,previous,next)=>{if(path===f.path)f.files.set(path,external);return compare(path,previous,next);};
    await expect(f.store.save({...saved,status:"completed"})).rejects.toThrow("external-conflict");
    expect(f.files.get(f.path)).toBe(external);
  });

  it("a durable deletion barrier wins even when the final primary write fails",async()=>{
    const f=fixture(),saved=await f.store.save(addAnswer(f.episode));
    f.io.compareWrite=async()=>{throw new Error("write failed");};
    await expect(f.store.remove(saved.id)).rejects.toThrow("write failed");
    expect(f.files.has(f.path+".deleted")).toBe(true);
    const reopened=new LearningV3Store(f.io,f.root);expect(await reopened.list()).toEqual([]);
    await expect(reopened.save(saved)).rejects.toThrow("deleted");
  });

  it("keeps future formats intact even when a valid v3 previous revision exists",async()=>{
    const f=fixture(),saved=await f.store.save(f.episode),raw=JSON.stringify({...saved,format:4});
    f.files.set(f.path+".previous",f.files.get(f.path)!);f.files.set(f.path,raw);
    const result=await f.store.listResult();expect(result.records).toEqual([]);expect(result.integrityIssues).toEqual([expect.objectContaining({category:"unsupported-format",recovered:false})]);
    expect(f.files.get(f.path)).toBe(raw);
  });

  it("rejects nested free prose before changing a primary or previous revision",async()=>{
    const f=fixture(),saved=await f.store.save(addAnswer(f.episode)),before=new Map(f.files);
    const candidate=structuredClone(saved);Object.assign(candidate.evidence[0]!,{notes:"SYNTHETIC_PRIVATE_PROSE"});
    await expect(async()=>f.store.save(candidate)).rejects.toThrow("schema");expect(f.files).toEqual(before);
  });
});
