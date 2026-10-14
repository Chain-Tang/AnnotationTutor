import { describe, expect, it } from "vitest";
import { LearningFlow } from "../src/learning-flow.js";
import { LearningEpisodeStore, type LearningIO } from "../src/learning-episode-store.js";
import { evidenceSummary, type ConceptId } from "../src/learning-episode.js";

async function fixture(concept:ConceptId="value-limit"){
  const files=new Map<string,string>();
  const io:LearningIO={read:async p=>files.get(p)??null,list:async root=>[...files.keys()].filter(p=>p.startsWith(root+"/")),write:async(p,raw)=>{files.set(p,raw);},compareWrite:async(p,b,n)=>{if((files.get(p)??null)!==b)throw new Error("conflict");files.set(p,n);}};
  const store=new LearningEpisodeStore(io,"learning/v1/episodes"),flow=new LearningFlow(store);
  await flow.start({path:"Synthetic/math.md",version:"v1"},concept);
  return {files,store,flow};
}
const privateText="SYNTHETIC_PRIVATE_DISCLOSURE";

describe("legacy card automatic evidence privacy",()=>{
  it.each([privateText,`4, ${privateText}`,"2+2","NaN","Infinity","1e100","0 ".repeat(40)])("leaves ambiguous input ungraded and writes no primary or sidecar: %s",async answer=>{
    const {files,flow}=await fixture(),before=new Map(files),episode=structuredClone(flow.active);
    const result=await flow.answer(answer);
    expect(result).toMatchObject({status:"clarification-needed",message:expect.any(String)});
    expect(result.message?.length).toBeGreaterThan(30);expect(result.message).not.toContain(answer);
    expect(files).toEqual(before);expect(flow.active).toEqual(episode);expect(flow.busy).toBe(false);
  });
  it.each([[" 8 / 2 ","4","correct"],["−0","0","incorrect"],["4e0","4","correct"]])("stores only the bounded canonical value for %s",async(input,value,outcome)=>{
    const {files,flow}=await fixture();expect(await flow.answer(input)).toEqual({status:"saved"});
    expect(flow.active?.evidence[0]).toMatchObject({answer:value,outcome});
    expect([...files.values()].join("\n")).not.toContain(input);
  });
  it("accepts exactly the authored choice, without saving surrounding prose",async()=>{
    const {files,flow}=await fixture("jump"),before=new Map(files);
    expect(await flow.answer(`不能 ${privateText}`)).toMatchObject({status:"clarification-needed"});expect(files).toEqual(before);
    expect(await flow.answer(" 不能 ")).toEqual({status:"saved"});expect(flow.active?.evidence[0]).toMatchObject({answer:"不能",outcome:"correct"});
    expect([...files.values()].join("\n")).not.toContain(privateText);
  });
  it("records only the disputed evidence reference and fixed state, never the reason",async()=>{
    const {files,flow}=await fixture();await flow.answer("4");const original=structuredClone(flow.active!.evidence[0]!);
    await flow.correct(original.id,privateText);
    expect(flow.active!.evidence[0]).toEqual(original);
    expect(flow.active!.evidence[1]).toMatchObject({corrects:original.id,answer:"",evaluator:"learner",outcome:"unreviewed"});
    expect(evidenceSummary(flow.active!).independent).toBe(0);
    expect([...files.values()].join("\n")).not.toContain(privateText);
  });
  it("keeps free explanations and model feedback out of every automatic file",async()=>{
    const {files,flow}=await fixture(),before=new Map(files),episode=structuredClone(flow.active);
    expect(await flow.explanation(privateText,"SYNTHETIC_PRIVATE_MODEL_FEEDBACK")).toMatchObject({status:"display-only"});
    expect(files).toEqual(before);expect(flow.active).toEqual(episode);
  });
  it("finishes and schedules review without saving a new reflection",async()=>{
    const {files,flow,store}=await fixture();await flow.answer("4");await flow.answer("7");await flow.finish(privateText);
    expect(flow.active).toMatchObject({status:"completed",reflection:"",reviewDue:expect.any(String)});
    expect([...files.values()].join("\n")).not.toContain(privateText);
    const reopened=new LearningFlow(store);await reopened.load();expect(reopened.active).toMatchObject({status:"completed",reflection:""});
  });
  it("preserves a pre-existing reflection instead of replacing or deleting it",async()=>{
    const {files,flow,store}=await fixture();await flow.answer("4");await flow.answer("7");
    await store.save({...flow.active!,reflection:"LEGACY_REFLECTION_KEEP_LOCAL"});await flow.load();
    await flow.finish(privateText);
    expect(flow.active!.reflection).toBe("LEGACY_REFLECTION_KEEP_LOCAL");
    expect([...files.values()].join("\n")).not.toContain(privateText);
    expect((await store.list())[0]!.reflection).toBe("LEGACY_REFLECTION_KEEP_LOCAL");
  });
});
