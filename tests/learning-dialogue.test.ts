import { describe, it, expect } from "vitest";
import { LearningDialogue, TeachingStream, type TeachingAction } from "../src/learning-dialogue.js";
import { LearningV2Store } from "../src/learning-v2.js";
import { learningContext } from "../src/learning-context.js";
import { createEpisode, recordAttempt } from "../src/learning-episode.js";
import { tutorPairingSchema } from "../src/tutor-grant.js";
import { TutorMcpTools } from "../src/tutor-mcp.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
export function fixture(){
  const files=new Map<string,string>();let fail=false;
  const io={read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+'/')),write:async(p:string,t:string)=>{files.set(p,t);},compareWrite:async(p:string,b:string|null,n:string)=>{if(fail||(files.get(p)??null)!==b)throw new Error('conflict');files.set(p,n);}};
  const store=new LearningV2Store(io,'learning/v2/episodes'),legacy=[createEpisode({path:'old.md',version:'a'},'jump')];
  const dialogue=new LearningDialogue(store,async()=>legacy),conversationId=crypto.randomUUID();
  const prepare=(text='test',source='a.md',requestId:string=crypto.randomUUID())=>dialogue.prepare({conversationId,requestId,text,source:{path:source,version:'a'}});
  const run=async(action:TeachingAction,text='test',source='a.md')=>dialogue.apply(await prepare(text,source),action,new AbortController().signal);
  const begin=async()=>{await run({type:'invite',concept:'value-limit'});await run({type:'accept'},'好');};
  return {files,io,store,legacy,dialogue,prepare,run,begin,fail:(v:boolean)=>fail=v};
}
describe('natural learning protocol',()=>{
  it('streams prose and hides control at every possible chunk boundary',()=>{
    const source=JSON.stringify({action:{type:'invite',concept:'value-limit'},reply:'解释文字\n'});
    for(let n=1;n<source.length;n++){let shown='';const s=new TeachingStream(d=>shown+=d);s.push(source.slice(0,n));s.push(source.slice(n));expect(s.finish()).toMatchObject({type:'invite'});expect(shown).toBe('解释文字\n');}
  });
  it('rejects truncated/invalid/extra control without displaying JSON',()=>{
    for(const body of ['{"action":{','{"action":{"type":"write-file"},"reply":""}','no control header']){let text='';const stream=new TeachingStream(d=>text+=d);expect(()=>{stream.push(body);stream.finish();}).toThrow();expect(text).toBe('');}
  });
  it('creates nothing before conversational consent; ignoring means no acceptance',async()=>{
    const f=fixture();expect(await f.run({type:'invite',concept:'value-limit'})).toContain('保存');expect(await f.store.list()).toEqual([]);
    await f.run({type:'none'},'换个话题');await f.run({type:'accept'},'好');expect(await f.store.list()).toEqual([]);
    expect(await f.run({type:'invite',concept:'jump'})).toBe('');
  });
  it('does not carry an invitation across documents, conversation reset or restart',async()=>{
    const f=fixture();await f.run({type:'invite',concept:'value-limit'});await f.run({type:'accept'},'好','b.md');expect(await f.store.list()).toEqual([]);
    const fresh=new LearningDialogue(f.store,async()=>[]);const turn=await fresh.prepare({conversationId:crypto.randomUUID(),requestId:crypto.randomUUID(),text:'好',source:{path:'a.md',version:'a'}});await fresh.apply(turn,{type:'accept'},new AbortController().signal);expect(await f.store.list()).toEqual([]);
  });
  it('records hints and exposed solutions; casual or emotional text is not a wrong answer',async()=>{
    const f=fixture();await f.begin();await f.run({type:'answer'},'我今天很难受');expect((await f.store.list())[0]!.evidence).toHaveLength(0);
    await f.run({type:'solution'},'直接告诉我');await f.run({type:'answer'},'9');const e=(await f.store.list())[0]!;expect(e.evidence[0]).toMatchObject({kind:'hinted',help:{answerShown:true}});
  });
  it('rejects cancelled, stale and concurrent turns and preserves previous evidence',async()=>{
    const f=fixture();await f.begin();const a=await f.prepare('9'),b=await f.prepare('9');const abort=new AbortController();abort.abort();await expect(f.dialogue.apply(a,{type:'answer'},abort.signal)).rejects.toThrow();
    await f.dialogue.apply(a,{type:'answer'},new AbortController().signal);await expect(f.dialogue.apply(b,{type:'answer'},new AbortController().signal)).rejects.toThrow();expect((await f.store.list())[0]!.evidence).toHaveLength(1);
  });
  it('retry with the original request ID cannot create another attempt',async()=>{const f=fixture();await f.begin();const t=await f.prepare('9');await f.dialogue.apply(t,{type:'answer'},new AbortController().signal);const retry=await f.prepare('9','a.md',t.requestId);await f.dialogue.apply(retry,{type:'answer'},new AbortController().signal);expect((await f.store.list())[0]!.evidence).toHaveLength(1);});
  it('failed persistence preserves state for retry',async()=>{const f=fixture();await f.begin();f.fail(true);await expect(f.run({type:'answer'},'9')).rejects.toThrow();f.fail(false);expect((await f.store.list())[0]!.evidence).toHaveLength(0);await f.run({type:'answer'},'9');expect((await f.store.list())[0]!.evidence).toHaveLength(1);});
  it('continues v1 by reference, without rewriting or recounting old evidence',async()=>{const f=fixture();f.legacy[0]=recordAttempt(f.legacy[0]!,'不能');const before=JSON.stringify(f.legacy);await f.run({type:'resume'},'继续之前','old.md');const next=(await f.store.list())[0]!;expect(next.legacy?.evidenceIds).toHaveLength(1);expect(next.evidence).toEqual([]);expect(JSON.stringify(f.legacy)).toBe(before);});
  it('student correction changes the shared snapshot; deleting stops retrieval and late writes',async()=>{
    const f=fixture();await f.begin();await f.run({type:'answer'},'9');const e=(await f.store.list())[0]!,query={source:'a.md'};
    const before=learningContext([e],query);await f.run({type:'correct',evidenceId:e.evidence[0]!.id},'你记错了');const after=learningContext(await f.store.list(),query);expect(after.revision).not.toBe(before.revision);expect(after.episodes[0]!.evidenceIds).not.toContain(e.evidence[0]!.id);
    const stale=await f.prepare('7');await f.store.remove(e.id);expect(learningContext(await f.store.list(),query).episodes).toEqual([]);await expect(f.dialogue.apply(stale,{type:'answer'},new AbortController().signal)).rejects.toThrow();
  });
  it('keeps corrected facts, scope and bounded summaries identical across consumers',async()=>{const f=fixture();await f.begin();await f.run({type:'answer'},'9');const records=await f.store.list();const snapshot=learningContext(records,{source:'a.md'});for(const _ of ['sidebar','board','annotation'])expect(learningContext(records,{source:'a.md'})).toEqual(snapshot);expect(snapshot.summary.length).toBeLessThanOrEqual(2000);expect(learningContext(records,{source:'a.md',allowedSources:['b.md']}).episodes).toEqual([]);});
  it('retains corrupt bytes and last-good revision; old applications can ignore v2',async()=>{const f=fixture();await f.begin();await f.run({type:'hint'});const e=(await f.store.list())[0]!,path=`${f.store.root}/${e.id}.json`;f.files.set(path,'{partial');const recovered=(await new LearningV2Store(f.io,f.store.root).list())[0]!;expect(recovered.revision).toBe(e.revision-1);expect([...f.files.keys()].some(p=>p.includes('.corrupt-'))).toBe(true);});
  it('new MCP permission defaults off, and rejects unauthorized documents',async()=>{
    const f=fixture();await f.begin();const grant={clientId:'a',name:'Codex',createdAt:new Date().toISOString(),documents:['a.md'],targets:[],humanObjectIds:[],read:true,write:false,learningMemory:true};
    expect(tutorPairingSchema.parse({tokenHash:'a'.repeat(64),grant}).grant.learningEvidence).toBe(false);
    const tasks=new TutorTaskCoordinator(),tools=new TutorMcpTools({tasks,surfaces:async()=>[],context:async()=>{throw Error('unused');},memory:async()=>[],learningContext:async q=>learningContext(await f.store.list(),q),run:async()=>[]});
    await expect(tools.invoke(grant,'tutor_get_learning_context',{source:'a.md'})).rejects.toThrow('not-granted');
    expect((await tools.invoke({...grant,learningEvidence:true},'tutor_get_learning_context',{source:'a.md'})).summary).toBeTruthy();
    await expect(tools.invoke({...grant,learningEvidence:true},'tutor_get_learning_context',{source:'b.md'})).rejects.toThrow();tasks.dispose();
  });
});
it('shares a unique source episode with a new annotation; does not guess between multiple episodes',async()=>{
 const f=fixture();await f.begin();const records=await f.store.list();expect(learningContext(records,{source:'a.md',annotationId:'new'}).episodes).toEqual(learningContext(records,{source:'a.md'}).episodes);
 const other=structuredClone(records[0]!);other.id=crypto.randomUUID();expect(learningContext([...records,other],{source:'a.md',annotationId:'new'}).episodes).toEqual([]);
 const turn=await f.dialogue.prepare({conversationId:crypto.randomUUID(),requestId:crypto.randomUUID(),source:{path:'a.md',version:'a',annotationId:'new'},text:'继续'});expect(turn.episode?.id).toBe(records[0]!.id);
});
it('uses an explicit episode ID across views and invalidates external deletion barriers',async()=>{
 const f=fixture();await f.begin();const e=(await f.store.list())[0]!;
 const turn=await f.dialogue.prepare({conversationId:crypto.randomUUID(),requestId:crypto.randomUUID(),source:{path:'other.md',version:'b'},episodeId:e.id,text:'提示一下'});expect(turn.episode?.source.path).toBe('a.md');
 const path=`${f.store.root}/${e.id}.json.deleted`;f.files.set(path,JSON.stringify({id:e.id}));expect(await f.store.changed(path)).toBe(true);expect(await f.store.list()).toEqual([]);await expect(f.dialogue.apply(turn,{type:'hint'},new AbortController().signal)).rejects.toThrow();
});
it('responds supportively while pausing, without recording the personal disclosure',async()=>{
 const f=fixture();await f.begin();let shown='';const stream=new TeachingStream(d=>shown+=d,true);
 stream.push(JSON.stringify({action:{type:'pause'},reply:'听起来今天很累，可以先休息。'}));const action=stream.finish();expect(stream.text).toContain('休息');expect(shown).toBe('');
 await f.run(action,'我今天很难受');const e=(await f.store.list())[0]!;expect(e.status).toBe('paused');expect(e.evidence).toEqual([]);expect([...f.files.values()].join()).not.toContain('难受');
});
it('does not persist a disclosure misclassified as an explanation',async()=>{
 const f=fixture();await f.begin();await f.run({type:'explain',attempt:'我今天很难受',feedback:'情绪状态'},'我今天很难受');expect((await f.store.list())[0]!.evidence).toEqual([]);
 await f.run({type:'explain',attempt:'极限看附近的趋势',feedback:'解释区分了函数值与极限，仍需新题验证。'},'我有些焦虑，但极限看附近的趋势');expect((await f.store.list())[0]!.evidence).toEqual([]);expect([...f.files.values()].join()).not.toContain('焦虑');expect([...f.files.values()].join()).not.toContain('附近的趋势');
});
