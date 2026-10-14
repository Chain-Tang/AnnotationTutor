import {expect,it} from 'vitest';
import {BoardRepository,type BoardStorageAdapter} from '../src/board-store.js';
import {BoardDraftStore,type BoardDraftIO} from '../src/board-draft.js';
import {createBoardDocument} from '../src/board-model.js';
import type {BoardBundle} from '../src/board-types.js';
class IO implements BoardDraftIO {
  files=new Map<string,string>();fail=false;
  async read(path:string){return this.files.get(path)??null;}
  async compareWrite(path:string,before:string|null,next:string){if(this.fail)throw new Error('private-store-unavailable');if(await this.read(path)!==before)throw new Error('state-file-conflict');this.files.set(path,next);}
}
class Vault implements BoardStorageAdapter {
  files=new Map<string,string>();folders=new Set<string>();
  async exists(path:string){return this.files.has(path)||this.folders.has(path);}
  async read(path:string){const raw=this.files.get(path);if(raw===undefined)throw new Error('missing');return raw;}
  async write(path:string,raw:string){this.files.set(path,raw);}
  async mkdir(path:string){this.folders.add(path);}
  async list(path:string){return{files:[...this.files.keys()].filter(file=>file.startsWith(path+'/')&&!file.slice(path.length+1).includes('/')),folders:[]};}
}
const root='Identity Memory',source='Lesson.md';
const rect=(id:string)=>({id,kind:'rect' as const,anchor:{kind:'markdown' as const,key:'p',quote:'Synthetic'},x:20,y:30,width:40,height:40,color:'#446677',strokeWidth:2,createdBy:'human' as const,editedBy:'human' as const,revision:1,groupId:'GROUP-'+id});
function setup(){const vault=new Vault(),io=new IO();return{vault,io,repo:()=>new BoardRepository(vault,root,new BoardDraftStore(io))};}
for(const type of ['markdown','pdf','standalone'] as const)it(`atomically gives two first ${type} opens the same source identity`,async()=>{
 const f=setup(),a=f.repo(),b=f.repo();const[first,second]=await Promise.all([a.open(source,type),b.open(source,type)]);
 expect(second.document.id).toBe(first.document.id);expect(first.document.objects).toEqual([]);expect(second.document.objects).toEqual([]);
 first.document.title='First writer';first.document.revision++;await a.save(first.document,first.ink);
 second.document.title='Second writer';second.document.revision++;await expect(b.save(second.document,second.ink)).rejects.toThrow();
 const primary=[...f.vault.files.keys()].filter(path=>/\/[^.]+\.board\.json$/.test(path));expect(primary).toHaveLength(1);expect(JSON.parse(await f.vault.read(primary[0]!)).title).toBe('First writer');
});
it('does not allocate an unprotected identity if the private reservation cannot be saved',async()=>{
 const f=setup();f.io.fail=true;await expect(f.repo().open(source,'markdown')).rejects.toThrow('private-store-unavailable');expect(f.vault.files.size).toBe(0);
});
it('detects both historical sources rather than silently returning the first matching work',async()=>{
 const f=setup();await f.vault.mkdir(root+'/boards');
 for(const id of ['BOARD-a','BOARD-b']){const document=createBoardDocument(source,'markdown',id);document.objects.push(rect('OBJ-'+id));await f.vault.write(root+'/boards/'+id+'.board.json',JSON.stringify(document));}
 await expect(f.repo().open(source,'markdown')).rejects.toThrow('board-source-branches');
 await expect(f.repo().read(source,'markdown')).rejects.toThrow('board-source-branches');expect(f.io.files.size).toBe(0);
});
async function legacy(f: ReturnType<typeof setup>) {
 await f.vault.mkdir(root+'/boards');
 for (const id of ['BOARD-a','BOARD-b']) { const document=createBoardDocument(source,'markdown',id);document.objects.push(rect('OBJ-'+id));await f.vault.write(root+'/boards/'+id+'.board.json',JSON.stringify(document)); }
 const error=await f.repo().open(source,'markdown').catch(error=>error);
 expect(error.message).toBe('board-source-branches');return error as import('../src/board-store.js').BoardSourceBranchesError;
}
it('explicitly selects either historical work without rewriting or merging the other',async()=>{
 const f=setup(),error=await legacy(f),original=new Map(f.vault.files),repo=f.repo();
 expect((await repo.inspectSourceBranch(source,'markdown',error.branches[1]!)).document.objects[0]!.id).toBe('OBJ-BOARD-b');
 const chosen=await repo.selectSourceBranch(source,'markdown','BOARD-b',error.branches,error.identityRevision);
 expect(chosen.document.id).toBe('BOARD-b');expect(f.vault.files).toEqual(original);
 expect((await f.repo().open(source,'markdown')).document.id).toBe('BOARD-b');
 const identity=await new BoardDraftStore(f.io).identities.get(root,source,'markdown');
 const other=await repo.selectSourceBranch(source,'markdown','BOARD-a',error.branches,identity!.revision);
 expect(other.document.id).toBe('BOARD-a');expect(f.vault.files).toEqual(original);
});
it('rejects a stale choice after any historical branch changes and keeps both files',async()=>{
 const f=setup(),error=await legacy(f),path=root+'/boards/BOARD-a.board.json';
 const changed=JSON.parse(f.vault.files.get(path)!);changed.objects[0].color='#ff0000';f.vault.files.set(path,JSON.stringify(changed));
 const original=new Map(f.vault.files);
 await expect(f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,error.identityRevision)).rejects.toThrow('board-source-choice-stale');
 expect(f.vault.files).toEqual(original);expect(f.io.files.size).toBe(0);
});
it('requires a fresh choice if an unselected historical version changes after selection',async()=>{
 const f=setup(),error=await legacy(f);await f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,null);
 const path=root+'/boards/BOARD-a.board.json',changed=JSON.parse(f.vault.files.get(path)!);changed.title='External change';f.vault.files.set(path,JSON.stringify(changed));
 await expect(f.repo().open(source,'markdown')).rejects.toThrow('board-source-branches');
});
it('never abandons the pending recovery of a different branch to apply a choice',async()=>{
 const f=setup(),error=await legacy(f),doc=JSON.parse(f.vault.files.get(root+'/boards/BOARD-a.board.json')!);
 const draft=new BoardDraftStore(f.io);doc.revision++;await draft.capture(root,{document:doc,ink:{}},doc,null,[]);
 const before=new Map(f.io.files);
 await expect(f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,null)).rejects.toThrow('board-source-choice-pending-work');
 expect(f.io.files).toEqual(before);
});
it('rejects a second choice with an old index revision',async()=>{
 const f=setup(),error=await legacy(f);await f.repo().selectSourceBranch(source,'markdown','BOARD-a',error.branches,null);
 await expect(f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,null)).rejects.toThrow('board-source-choice-stale');
 expect((await f.repo().open(source,'markdown')).document.id).toBe('BOARD-a');
});
it('does not recreate an empty drawing when published work and its backup are missing',async()=>{
 const f=setup(),a=f.repo(),bundle=await a.open(source,'markdown');bundle.document.objects.push(rect('OBJ-published'));await a.save(bundle.document,bundle.ink);
 for(const path of [...f.vault.files.keys()])if(path.endsWith('.board.json'))f.vault.files.delete(path);
 const before=new Map(f.io.files);await expect(f.repo().open(source,'markdown')).rejects.toThrow('board-source-data-missing');expect(f.io.files).toEqual(before);
});
it('restores the same reserved identity after an empty first view closes without saving',async()=>{
 const f=setup(),first=await f.repo().open(source,'markdown'),second=await f.repo().open(source,'markdown');
 expect(second.document.id).toBe(first.document.id);expect(f.vault.files.size).toBe(0);
});
it('rejects corrupt and unknown identity records without allocating a new board',async()=>{
 for(const raw of ['{broken',JSON.stringify({format:'tutor-board-source-v999'})]){
  const f=setup(),draft=new BoardDraftStore(f.io),path=await draft.identities.path(root,source,'markdown');f.io.files.set(path,raw);
  await expect(f.repo().open(source,'markdown')).rejects.toThrow('board-source-record-invalid');expect(f.io.files.get(path)).toBe(raw);expect(f.vault.files.size).toBe(0);
 }
});
it('keeps a complete draft if authority saves but source confirmation fails, and recovers cleanly',async()=>{
 const f=setup(),repo=f.repo(),draft=new BoardDraftStore(f.io),bundle=await repo.open(source,'markdown');bundle.document.objects.push(rect('OBJ-confirmation'));
 const identityPath=await draft.identities.path(root,source,'markdown'),write=f.io.compareWrite.bind(f.io);
 f.io.compareWrite=async(path,before,next)=>{if(path===identityPath&&JSON.parse(next).hasWork)throw new Error('identity-confirmation-unavailable');return write(path,before,next);};
 await expect(repo.save(bundle.document,bundle.ink)).rejects.toThrow('Board saved; source identity could not be confirmed');
 expect(JSON.parse(f.vault.files.get(repo.boardPath(bundle.document.id))!).objects[0].id).toBe('OBJ-confirmation');
 expect(await draft.read(root,source,'markdown')).not.toBeNull();
 f.io.compareWrite=write;const restored=await f.repo().open(source,'markdown');expect(restored.document.objects).toEqual(bundle.document.objects);expect(await draft.read(root,source,'markdown')).toBeNull();
});
it('preserves work when an existing branch selection cannot be recorded privately',async()=>{
 const f=setup(),error=await legacy(f),before=new Map(f.vault.files);f.io.fail=true;
 await expect(f.repo().selectSourceBranch(source,'markdown','BOARD-a',error.branches,null)).rejects.toThrow('private-store-unavailable');expect(f.vault.files).toEqual(before);
});
it('lists acknowledged historical choices without writing authority or expanding their contents',async()=>{
 const f=setup(),error=await legacy(f);await f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,null);
 const before=new Map(f.io.files),authority=new Map(f.vault.files),choices=await f.repo().sourceBranchChoices(source,'markdown');
 expect(choices!.selectedId).toBe('BOARD-b');expect(choices!.branches.map(b=>b.id)).toEqual(['BOARD-a','BOARD-b']);expect(choices!.branches.every(b=>/^[a-f0-9]{64}$/.test(b.hash))).toBe(true);
 expect(f.io.files).toEqual(before);expect(f.vault.files).toEqual(authority);
 choices!.branches[0]!.title='Client mutation';expect((await f.repo().sourceBranchChoices(source,'markdown'))!.branches[0]!.title).not.toBe('Client mutation');
});
it('stops a choice invalidated during validation before publishing the locator',async()=>{
 const f=setup(),error=await legacy(f),before=new Map(f.io.files);
 await expect(f.repo().selectSourceBranch(source,'markdown','BOARD-b',error.branches,null,()=>false)).rejects.toThrow('board-source-choice-stale');expect(f.io.files).toEqual(before);
});
