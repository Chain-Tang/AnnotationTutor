import {describe,it,expect} from 'vitest';
import {applyVectorEdit} from '../src/board-vector-edit.js';
import {builtInPartCharacter} from '../src/board-character-parts.js';
import {createBoardDocument,BoardHistory} from '../src/board-model.js';
import {TutorBoardSurface} from '../src/tutor-board-surface.js';
import type {BoardDocument} from '../src/board-types.js';
import {memorySurfaceJournal} from './surface-journal-fixture.js';
function fixture(){const {asset}=builtInPartCharacter('round');const document=createBoardDocument('qa.md','standalone');document.schemaVersion=5;document.vectorAssets=[asset];document.objects=['a','b'].map(id=>({id,kind:'vector',anchor:{kind:'canvas',pageId:'main'},x:0,y:0,width:200,height:200,color:'#000',strokeWidth:1,vectorAssetId:asset.id,vectorAssetVersion:1,createdBy:'human',editedBy:'human',revision:1,groupId:'original'}));return document;}
const edit={type:'vector-edit' as const,objectId:'a',expectedRevision:1,nodes:[{id:'clothes',patch:{fill:{kind:'solid' as const,color:'#2244ee',opacity:1}}}]};
describe('precise vector transactions',()=>{
  it('checks host layout for preview and commit before touching history',async()=>{
    const history=new BoardHistory(fixture()),before=history.document;
    let reject=true;
    const surface=new TutorBoardSurface(before.id,'document',{
      history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>['a'],
      save:async()=>{},preview:async()=>'<svg/>',changed:()=>{},
      validateDraft:()=>{if(reject)throw new Error('layout-obstructed');},
    },memorySurfaceJournal());
    const scene=await surface.read(),grant={clientId:'qa',targets:[surface.id],read:true,write:true,humanObjectIds:['a'],learningMemory:false};
    const changes={id:'layout',taskId:'task',targetId:surface.id,baseRevision:scene.target.revision,dependencies:[],operations:[edit]};
    expect(()=>surface.preview(changes)).toThrow('layout-obstructed');
    await expect(surface.commit(changes,grant,new AbortController().signal)).rejects.toThrow('layout-obstructed');
    expect(history.document).toEqual(before);expect(history.canUndo).toBe(false);
    reject=false;await surface.commit(changes,grant,new AbortController().signal);
    history.undo();expect(history.document.objects.map(({revision,...rest})=>rest)).toEqual(before.objects.map(({revision,...rest})=>rest));
  });
  it('changes only clothing color in one instance, preserving identity, geometry and history',()=>{const d=fixture(),before=structuredClone(d);applyVectorEdit(d,edit);expect(d.objects[1]).toEqual(before.objects[1]);expect(d.vectorAssets![0]).toEqual(before.vectorAssets![0]);const next=d.vectorAssets![1]!;for(const node of next.nodes){const old=before.vectorAssets![0]!.nodes.find(n=>n.id===node.id)!;expect(node.id==='clothes'?{...node,fill:old.fill}:node).toEqual(old);}expect(d.objects[0]!.vectorAssetVersion).toBe(2);expect(d.objects[0]!.createdBy).toBe('human');});
  it('rejects locked ancestors, duplicate nodes and stale revisions',()=>{const d=fixture();d.vectorAssets![0]!.nodes.find(n=>n.id==='clothes')!.locked=true;expect(()=>applyVectorEdit(d,edit)).toThrow('locked');expect(()=>applyVectorEdit(fixture(),{...edit,expectedRevision:2})).toThrow('revision');expect(()=>applyVectorEdit(fixture(),{...edit,nodes:[...edit.nodes,...edit.nodes]})).toThrow('duplicate');});
  it('validates a whole batch before committing and groups it as one undo',async()=>{const history=new BoardHistory(fixture()),surface=new TutorBoardSurface(history.document.id,'studio',{history:()=>history,ink:()=>({}),alive:()=>true,selection:()=>['a'],save:async()=>{},preview:async()=>'<svg/>',changed:()=>{}},memorySurfaceJournal());const scene=await surface.read(),grant={clientId:'qa',targets:[surface.id],read:true,write:true,humanObjectIds:['a'],learningMemory:false};const changes={id:'one',taskId:'task',targetId:surface.id,baseRevision:scene.target.revision,dependencies:[],operations:[edit]};await expect(surface.commit({...changes,operations:[edit,{...edit,objectId:'b'}]},grant,new AbortController().signal)).rejects.toThrow('outside-grant');expect(history.document.vectorAssets).toHaveLength(1);await surface.commit(changes,grant,new AbortController().signal);expect(history.document.vectorAssets).toHaveLength(2);history.undo();expect(history.document.objects[0]!.vectorAssetVersion).toBe(1);expect(history.document.vectorAssets).toHaveLength(1);});
});
