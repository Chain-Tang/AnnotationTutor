import {it,expect} from 'vitest';
import {TutorJournal} from '../src/tutor-journal.js';
import {TutorTaskCoordinator} from '../src/tutor-task.js';
import {tutorPairingSchema} from '../src/tutor-grant.js';
it('retains prior task metadata across reload, bounds remote handles and excludes sensitive artifacts',async()=>{
 const files=new Map<string,string>(),adapter={exists:async(p:string)=>files.has(p),read:async(p:string)=>files.get(p)!,write:async(p:string,v:string)=>{files.set(p,v);},mkdir:async(p:string)=>{files.set(p,'');},list:async()=>({files:[],folders:[]})};
 const tasks=new TutorTaskCoordinator(),one=tasks.start({clientId:'qa'});tasks.complete(one.id,'qa',[{id:'a',type:'text',data:'PRIVATE-ANSWER'}]);
 const first=new TutorJournal(adapter,'Memory');await first.record(tasks.get(one.id,'qa'));
 const second=new TutorJournal(adapter,'Memory'),two=tasks.start({clientId:'qa'});await second.record(two);
 const index=files.get('Memory/tasks/task-index.json')!;expect(JSON.parse(index).entries.map((t:{id:string})=>t.id)).toEqual([one.id,two.id]);expect(index).not.toContain('PRIVATE-ANSWER');
 let last='';for(let i=0;i<202;i++){last=crypto.randomUUID();await second.rememberRemote({localId:last,endpoint:'https://agent.test/',remoteId:`remote-${i}`,updatedAt:i});}
 expect(JSON.parse(files.get('Memory/tasks/remote-index.json')!).entries).toHaveLength(200);
 expect(await new TutorJournal(adapter,'Memory').remote(last)).toMatchObject({remoteId:'remote-201'});
 await expect(second.rememberRemote({localId:last,endpoint:'https://agent.test/?token=secret',remoteId:'bad',updatedAt:1})).rejects.toThrow();tasks.dispose();
});
it('rejects persisted truthy permission strings and traversal scopes',()=>{
 const value={tokenHash:'a'.repeat(64),grant:{clientId:'c',name:'C',createdAt:new Date().toISOString(),targets:[],documents:['note.md'],humanObjectIds:[],read:true,write:false,learningMemory:false}};
 expect(tutorPairingSchema.safeParse(value).success).toBe(true);
 expect(tutorPairingSchema.safeParse({...value,grant:{...value.grant,write:'false'}}).success).toBe(false);
 expect(tutorPairingSchema.safeParse({...value,grant:{...value.grant,documents:['../private']}}).success).toBe(false);
});
