import {it,expect} from 'vitest';
import {TutorResultStore} from '../src/tutor-result-store.js';
import {TutorTaskCoordinator} from '../src/tutor-task.js';
import {TutorCollaboration} from '../src/tutor-collaboration.js';
import type {TutorTask} from '../src/tutor-task.js';
const fixture=()=>{const files=new Map<string,string>();return {files,io:{read:async(p:string)=>files.get(p)??null,list:async(p:string)=>[...files.keys()].filter(k=>k.startsWith(p+'/')),write:async(p:string,t:string)=>{files.set(p,t);},compareWrite:async(p:string,b:string|null,n:string)=>{if((files.get(p)??null)!==b)throw Error('conflict');files.set(p,n);}}};};
it('restores scoped completed products and marks interrupted tasks failed without executing adapters',async()=>{
 const f=fixture(),store=new TutorResultStore(f.io,'results'),tasks=new TutorTaskCoordinator();
 const root=tasks.start({clientId:'a',key:'qa'}),child=tasks.start({clientId:'a',parentId:root.id,agent:'codex'});
 tasks.complete(child.id,'a',[{id:'artifact',type:'text',data:{text:'mathematical result',secret:'must not persist',threadId:'private'}}]);
 await store.save(tasks.get(root.id,'a'),[tasks.get(child.id,'a')]);expect([...f.files.values()].join()).not.toContain('must not persist');
 const restored=new TutorTaskCoordinator();restored.restore(await new TutorResultStore(f.io,'results').restore());
 expect(restored.get(root.id,'a')).toMatchObject({state:'failed',error:{code:'interrupted'}});expect(restored.get(child.id,'a').artifacts[0]?.data).toEqual({text:'mathematical result'});
 expect(restored.start({clientId:'a',key:'qa'}).id).toBe(root.id);expect(()=>restored.get(root.id,'b')).toThrow('not-found');
 tasks.dispose();restored.dispose();
});
it('completed result is durable, rejects cross-client children and recovers last-good bytes',async()=>{
 const f=fixture(),store=new TutorResultStore(f.io,'results'),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a'});
 await store.save(root,[]);tasks.complete(root.id,'a',[{id:'a',type:'text',data:{text:'done'}}]);await store.save(tasks.get(root.id,'a'),[]);
 const restored=new TutorTaskCoordinator();restored.restore(await store.restore());expect(restored.get(root.id,'a').artifacts[0]?.data).toEqual({text:'done'});
 const bad=tasks.start({clientId:'b'});expect(()=>store.save(root,[bad])).toThrow();
 f.files.set(`results/${root.id}.json`,'{broken');expect((await new TutorResultStore(f.io,'results').restore())[0]?.state).toBe('queued');expect([...f.files.keys()].some(p=>p.includes('.corrupt-'))).toBe(true);
 tasks.dispose();restored.dispose();
});
it('repeating an existing collaboration key never starts another paid call',async()=>{
 const tasks=new TutorTaskCoordinator();let calls=0;
 const adapter=(id:string)=>({id,capabilities:async()=>({vision:false,tools:false,streaming:false}),dispose:()=>{},run:async()=>{calls++;return [{id:'a',type:'text' as const,data:{text:'done'}}];}});
 const c=new TutorCollaboration(tasks),input={clientId:'a',key:'same',prompt:'check',context:'math',lead:adapter('tutor'),experts:[adapter('codex')]};
 const first=c.start(input);const second=c.start({...input,lead:adapter('tutor'),experts:[adapter('codex')]});expect(second.id).toBe(first.id);
 await new Promise(r=>setTimeout(r,5));expect(calls).toBe(2);expect(tasks.get(first.id,'a').state).toBe('completed');tasks.dispose();
});

function saved(task:TutorTask,children:TutorTask[]=[]){return JSON.stringify({format:1,root:task,children});}
const pathOf=(task:TutorTask)=>`results/${task.id}.json`;
it('isolates a corrupt task without a backup and keeps unrelated completed results readable',async()=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),bad=tasks.start({clientId:'a'}),good=tasks.start({clientId:'a'});
 tasks.complete(good.id,'a',[{id:'answer',type:'text',data:{text:'valid'}}]);
 f.files.set(pathOf(bad),'{broken');f.files.set(pathOf(good),saved(tasks.get(good.id,'a')));
 const result=await new TutorResultStore(f.io,'results').restoreResult();
 expect(result.tasks.map(task=>task.id)).toEqual([good.id]);expect(result.completeness).toBe('partial');expect(result.integrityIssues[0]?.category).toBe('corrupt');
 expect(f.files.get(pathOf(bad))).toBe('{broken');expect(result.tasks[0]?.artifacts[0]?.data).toEqual({text:'valid'});tasks.dispose();
});
it.each(['oversized','wrong-id','unsupported','bad-backup'] as const)('preserves a %s file while restoring other tasks',async cause=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),bad=tasks.start({clientId:'a'}),good=tasks.start({clientId:'a'}),wrong=tasks.start({clientId:'a'});
 const raw=cause==='oversized'?'x'.repeat(1_000_001):cause==='wrong-id'?saved(wrong):cause==='unsupported'?JSON.stringify({format:2,root:bad,children:[]}):'{broken';
 f.files.set(pathOf(bad),raw);f.files.set(pathOf(good),saved(good));
 if(cause==='unsupported')f.files.set(pathOf(bad)+'.previous',saved(bad));
 if(cause==='bad-backup')f.files.set(pathOf(bad)+'.previous',saved(wrong));
 const result=await new TutorResultStore(f.io,'results').restoreResult();expect(result.tasks.map(t=>t.id)).toEqual([good.id]);expect(result.completeness).toBe('partial');expect(f.files.get(pathOf(bad))).toBe(raw);
 expect(result.integrityIssues[0]?.category).toBe({oversized:'too-large','wrong-id':'identity-mismatch',unsupported:'unsupported-format','bad-backup':'corrupt'}[cause]);tasks.dispose();
});
it('reports an unreadable directory independently of a corrupt record',async()=>{
 const f=fixture(),store=new TutorResultStore({...f.io,list:async()=>{throw Error('private path should not appear');}},'results');
 const result=await store.restoreResult();expect(result.tasks).toEqual([]);expect(result.completeness).toBe('unavailable');expect(result.integrityIssues[0]?.category).toBe('directory-unreadable');expect(JSON.stringify(result)).not.toContain('private path');
});
it.each(['cycle','duplicate','missing-child','cross-client','cross-target'] as const)('rejects %s task graphs without restoring foreign handles',async cause=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a',target:{id:'board',source:'one.md',revision:'v1',surface:'document'}}),child=tasks.start({clientId:'a',parentId:root.id,agent:'codex',target:root.target});
 const main=tasks.get(root.id,'a'),expert=tasks.get(child.id,'a');let children=[expert];
 if(cause==='cycle')expert.parentId=expert.id;
 if(cause==='duplicate')children=[expert,expert];
 if(cause==='missing-child')main.children=[];
 if(cause==='cross-client')expert.clientId='b';
 if(cause==='cross-target')expert.target!.source='two.md';
 f.files.set(pathOf(root),saved(main,children));const result=await new TutorResultStore(f.io,'results').restoreResult();
 expect(result.tasks).toEqual([]);expect(result.integrityIssues[0]?.category).toBe('cross-reference');expect(f.files.get(pathOf(root))).toBe(saved(main,children));tasks.dispose();
});
it('isolates both valid groups when their child handles collide',async()=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a'}),child=tasks.start({clientId:'a',parentId:root.id,agent:'codex'}),other=tasks.start({clientId:'a'}),good=tasks.start({clientId:'a'});
 f.files.set(pathOf(root),saved(tasks.get(root.id,'a'),[child]));other.children=[child.id];f.files.set(pathOf(other),saved(other,[{...child,parentId:other.id}]));f.files.set(pathOf(good),saved(good));
 const result=await new TutorResultStore(f.io,'results').restoreResult();expect(result.tasks.map(t=>t.id)).toEqual([good.id]);expect(result.integrityIssues.filter(issue=>issue.category==='duplicate-id')).toHaveLength(2);tasks.dispose();
});
it('lets an external repair win a backup recovery race and never serves the stale backup',async()=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a'}),backup=saved(root);tasks.complete(root.id,'a',[{id:'new',type:'text',data:{text:'external repair'}}]);const latest=saved(tasks.get(root.id,'a'));
 f.files.set(pathOf(root),'{broken');f.files.set(pathOf(root)+'.previous',backup);
 const io={...f.io,compareWrite:async(p:string,_b:string|null,_n:string)=>{f.files.set(p,latest);throw Error('external repair won');}};
 const result=await new TutorResultStore(io,'results').restoreResult();expect(result.tasks[0]?.artifacts[0]?.data).toEqual({text:'external repair'});expect(result.integrityIssues[0]).toMatchObject({category:'recovery-conflict',recovered:true});expect(f.files.get(pathOf(root))).toBe(latest);expect([...f.files.keys()].some(p=>p.includes('.corrupt-'))).toBe(true);tasks.dispose();
});
it('does not revive a deleted result even when a previous version is valid',async()=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a'});f.files.set(pathOf(root),'{broken');f.files.set(pathOf(root)+'.previous',saved(root));f.files.set(pathOf(root)+'.deleted','deleted');
 const store=new TutorResultStore(f.io,'results');expect(await store.restore()).toEqual([]);await expect(store.save(root,[])).rejects.toThrow('expert-result-deleted');expect(f.files.get(pathOf(root))).toBe('{broken');tasks.dispose();
});
it('preserves the verified previous version when a save encounters corrupt or future data',async()=>{
 const f=fixture(),tasks=new TutorTaskCoordinator(),root=tasks.start({clientId:'a'}),store=new TutorResultStore(f.io,'results'),backup=saved(root);
 for(const raw of ['{broken',JSON.stringify({format:2,root,children:[]})]){
  f.files.set(pathOf(root),raw);f.files.set(pathOf(root)+'.previous',backup);await expect(store.save(root,[])).rejects.toThrow();expect(f.files.get(pathOf(root)+'.previous')).toBe(backup);expect(f.files.get(pathOf(root))).toBe(raw);
 }tasks.dispose();
});
