// @vitest-environment happy-dom
import {boardLayoutDigest} from "../src/board-layout-digest.js";
import {surfaceDigest} from "../src/tutor-surface.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {BoardLayoutState,boardLayoutSchema} from "../src/board-layout.js";
import {BoardLayoutStore} from "../src/board-layout-store.js";
import {BoardHistory,createBoardDocument} from "../src/board-model.js";
import {BoardRepository,type BoardStorageAdapter} from "../src/board-store.js";
import {createBoardSlotElement,projectBoardSlot,BoardSlotViews} from "../src/board-projection.js";
import type {BoardObject} from "../src/board-types.js";
import type {BoardSurface} from "../src/board-surfaces.js";
import {buildTutorBoardArchive} from "../src/board-share.js";
import {unzipSync,strFromU8} from "fflate";
const figure=(id="OBJ-figure",groupId="LAYOUT-figure"):BoardObject=>({id,kind:"rect",anchor:{kind:"markdown",key:"ANCHOR-p",quote:"Paragraph"},x:200,y:30,width:640,height:240,color:"#000000",strokeWidth:2,revision:1,createdBy:"tutor",editedBy:"tutor",groupId});
function scene(){const d=createBoardDocument("test.md","markdown");d.objects=[figure(),{...figure("OBJ-old","notes"),createdBy:"human",editedBy:"human",inkId:undefined}];d.revision++;return d;}
function storage(){const files=new Map<string,string>();let fail="";const adapter:BoardStorageAdapter={exists:async p=>files.has(p),read:async p=>files.get(p)!,write:async(p,v)=>{if(p===fail)throw Error("disk-failure");files.set(p,v);},mkdir:async()=>{},list:async()=>({files:[],folders:[]})};return {files,adapter,fail:(path:string)=>{fail=path;}};}
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren();});
describe("C60 layout authority",()=>{
 it.each([null,"",{z:1,a:"中文🐳",nested:{c:2,b:1}},"x".repeat(3000)])("matches desktop SHA-256 across mobile and desktop",value=>{expect(boardLayoutDigest(value)).toBe(surfaceDigest(value));});
 it("adopts only reliable, unplaced tutor groups and preserves legacy human notes and v5 geometry",()=>{
  const d=scene(),original=structuredClone(d),state=new BoardLayoutState(d.id);
  state.reconcile(d,false,new Set());expect(state.specs(d.objects)).toEqual([]);
  d.revision++;state.reconcile(d,false,new Set(["ANCHOR-p"]));
  expect(state.binding("OBJ-figure")).toBeDefined();expect(state.binding("OBJ-old")).toBeUndefined();expect(d.objects).toEqual(original.objects);
  expect(state.specs(d.objects)[0]).toMatchObject({width:668,height:268});
  expect(state.needsLegacyNotice(d.objects)).toBe(true);state.markNotice();expect(state.needsLegacyNotice(d.objects)).toBe(false);
  const moved=scene();moved.objects[0]!.editedBy="human";const other=new BoardLayoutState(moved.id);other.reconcile(moved);expect(other.specs(moved.objects)).toEqual([]);
 });
 it("does not activate stale object revisions or scan/digest objects on every layout frame",()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);const saved=state.snapshot();
  d.objects[0]!.x+=80;d.objects[0]!.revision++;d.revision++;
  const reopened=new BoardLayoutState(d.id,saved);reopened.reconcile(d);expect(reopened.binding("OBJ-figure")).toBeUndefined();
  const counted=new Proxy(d,{get(target,key){if(key==='objects')throw Error('rescanned');return Reflect.get(target,key);}});
  expect(()=>reopened.reconcile(counted)).not.toThrow();
 });
 it("associates old notes only after confirmation, preserving groups and supporting layout-only undo and redo",()=>{
  const d=scene(),original=structuredClone(d),state=new BoardLayoutState(d.id);state.reconcile(d);const slot=state.snapshot().slots[0]!;
  const history=new BoardHistory(d);history.attachCompanion({capture:()=>state.snapshot(),restore:value=>state.restore(value)});
  history.checkpoint();state.confirm([d.objects[1]!],slot.id,new Map([["OBJ-old",[1,0,0,1,-180,-18]]]));state.reconcile(history.renderDocument);
  expect(state.binding("OBJ-old")?.slot.id).toBe(slot.id);expect(d).toEqual(original);
  expect(history.undo()).not.toBeNull();state.reconcile(history.renderDocument);expect(state.binding("OBJ-old")).toBeUndefined();
  expect(history.redo()).not.toBeNull();state.reconcile(history.renderDocument);expect(state.binding("OBJ-old")).toBeDefined();
 });
 it("undoes drawing after association, then association, in order despite source revisions",()=>{
  const d=scene(),state=new BoardLayoutState(d.id),history=new BoardHistory(d);state.reconcile(d);
  history.attachCompanion({capture:()=>state.snapshot(),restore:value=>state.restore(value)});
  const slot=state.specs(d.objects)[0]!.id;history.checkpoint();state.confirm([d.objects[1]!],slot,new Map([["OBJ-old",[1,0,0,1,-180,-18]]]));
  history.transact(doc=>doc.objects.push({...figure('OBJ-new','human'),createdBy:'human',editedBy:'human'}));
  state.attach(history.renderDocument.objects.at(-1)!,slot,[1,0,0,1,0,0]);history.updateSourceRevision('changed-text');
  history.undo();state.reconcile(history.renderDocument,true);expect(state.binding('OBJ-old')).toBeDefined();expect(state.binding('OBJ-new')).toBeUndefined();
  history.undo();state.reconcile(history.renderDocument,true);expect(state.binding('OBJ-old')).toBeUndefined();expect(history.renderDocument.objects).toEqual(d.objects);
  history.redo();state.reconcile(history.renderDocument,true);expect(state.binding('OBJ-old')).toBeDefined();
  history.redo();state.reconcile(history.renderDocument,true);expect(state.binding('OBJ-new')?.slot.id).toBe(slot);
  expect(history.renderDocument.sourceRevision).toBe('changed-text');
 });
 it("discards association redo after a new drawing branch and bounds companion history",()=>{
  const d=scene(),state=new BoardLayoutState(d.id),history=new BoardHistory(d,2);state.reconcile(d);
  history.attachCompanion({capture:()=>state.snapshot(),restore:value=>state.restore(value)});
  const slot=state.specs(d.objects)[0]!.id;history.checkpoint();state.confirm([d.objects[1]!],slot,new Map([["OBJ-old",[1,0,0,1,-180,-18]]]));
  history.undo();state.reconcile(history.renderDocument,true);
  for(let i=0;i<3;i++)history.transact(doc=>{doc.objects[0]!.color=['#ff0000','#00ff00','#0000ff'][i]!;});
  expect(history.canRedo).toBe(false);history.undo();history.undo();expect(history.undo()).toBeNull();
  state.reconcile(history.renderDocument,true);expect(state.binding('OBJ-old')).toBeUndefined();
  history.replace(d);expect(history.canUndo).toBe(false);expect(history.canRedo).toBe(false);
 });
 it("removes empty drawing areas on object undo and restores the same identity on redo",()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);const id=state.specs(d.objects)[0]!.id;
  const object=d.objects.shift()!;d.revision++;state.reconcile(d,true);expect(state.specs(d.objects)).toEqual([]);
  d.objects.push(object);d.revision++;state.reconcile(d,true);expect(state.specs(d.objects)[0]!.id).toBe(id);
 });
 it("rejects duplicate bindings, singular transforms and board identity mismatches",()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);const saved=state.snapshot();
  saved.slots[0]!.bindings.push(structuredClone(saved.slots[0]!.bindings[0]!));expect(()=>boardLayoutSchema.parse(saved)).toThrow('duplicate-layout-binding');
  saved.slots[0]!.bindings.pop();saved.slots[0]!.bindings[0]!.matrix=[0,0,0,0,0,0];expect(()=>boardLayoutSchema.parse(saved)).toThrow('singular-layout-binding');
  expect(()=>new BoardLayoutState('BOARD-other',state.snapshot())).toThrow('layout-board-mismatch');
 });
 it("recovers interrupted layout only for the exact durable scene, retaining external changes",async()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);const {files,adapter}=storage(),store=new BoardLayoutStore(adapter,"Memory");
  const manifest=state.snapshot();await store.load(d.id,d);await store.prepare(manifest,d);
  expect(await new BoardLayoutStore(adapter,'Memory').load(d.id,{...d,revision:d.revision+1})).toBeUndefined();
  expect(await new BoardLayoutStore(adapter,'Memory').load(d.id,d)).toEqual(manifest);
  await store.commit(manifest);state.markNotice();await store.prepare(state.snapshot(),d);
  files.set(store.path(d.id),JSON.stringify({...manifest,revision:999}));await expect(store.commit(state.snapshot())).rejects.toThrow('layout-external-conflict');
  expect(JSON.parse(files.get(store.path(d.id))!).revision).toBe(999);
 });
 it("keeps the last valid manifest after corruption and refuses unknown future formats",async()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);const {files,adapter}=storage(),store=new BoardLayoutStore(adapter,"Memory"),path=store.path(d.id);
  await store.prepare(state.snapshot(),d);await store.commit(state.snapshot());state.markNotice();await store.prepare(state.snapshot(),d);await store.commit(state.snapshot());
  const previous=JSON.parse(files.get(path+'.previous')!);files.set(path,'{interrupted');expect(await store.load(d.id)).toEqual(previous);
  files.set(path,JSON.stringify({...state.snapshot(),format:'future-v2'}));await expect(store.load(d.id)).rejects.toThrow('layout-unsupported-format');
 });
 it("saves assets and scene before the layout commit and detects external layout writes",async()=>{
  const {adapter,files,fail}=storage(),repo=new BoardRepository(adapter,"Memory"),bundle=await repo.open('test.md','markdown'),d=bundle.document;
  d.objects=[figure()];d.revision++;const state=new BoardLayoutState(d.id);state.reconcile(d);fail(repo.layouts.path(d.id));
  await expect(repo.save(d,{},undefined,state.snapshot())).rejects.toThrow('disk-failure');
  const durable=JSON.parse(files.get(repo.boardPath(d.id))!);expect(durable.objects[0].id).toBe('OBJ-figure');
  const restored=await new BoardLayoutStore(adapter,'Memory').load(d.id,durable);expect(restored).toEqual(state.snapshot());
  fail('');await repo.save(d,{},undefined,state.snapshot());files.set(repo.layouts.path(d.id),JSON.stringify({...state.snapshot(),revision:999}));
  expect((await repo.onExternalChange(repo.layouts.path(d.id)))?.affectedBoardIds).toContain(d.id);
 });
 it("includes the unmodified geometry, ink and versioned layout in editable export",async()=>{
  const d=scene(),state=new BoardLayoutState(d.id);state.reconcile(d);
  const files=unzipSync(await buildTutorBoardArchive({document:d,ink:{},layout:state.snapshot()}));
  expect(JSON.parse(strFromU8(files['board.json']!)).objects).toEqual(d.objects);
  expect(JSON.parse(strFromU8(files['layout.json']!))).toEqual(state.snapshot());
 });
});
describe("C60 view-local projection",()=>{
 it("preserves dimensions and aligns inverse mapping after reflow and independent horizontal scroll",()=>{
  const doc=scene(),state=new BoardLayoutState(doc.id);state.reconcile(doc);const binding=state.binding('OBJ-figure')!,spec=state.specs(doc.objects)[0]!;
  const source=document.createElement('p'),viewport=document.createElement('div');document.body.append(viewport);viewport.append(source);
  vi.spyOn(viewport,'getBoundingClientRect').mockReturnValue(new DOMRect(10,0,340,900));
  const base={id:'p',kind:'markdown',anchor:doc.objects[0]!.anchor,element:source,viewportElement:viewport,getLayoutVersion:()=>'',text:'Paragraph'} as unknown as BoardSurface;
  const first=createBoardSlotElement(document,spec),second=createBoardSlotElement(document,spec);viewport.append(first,second);
  let top=124;for(const el of [first,second]){vi.spyOn(el,'getBoundingClientRect').mockImplementation(()=>new DOMRect(10,top,340,spec.height));vi.spyOn(el.firstElementChild!,'getBoundingClientRect').mockImplementation(()=>new DOMRect(10-el.scrollLeft,top,spec.width,spec.height));}
  const a=projectBoardSlot(base,first,binding.matrix,state.revision),b=projectBoardSlot(base,second,binding.matrix,state.revision),object=doc.objects[0]!;
  const initial=a.project(object);expect(a.width).toBe(668);top+=24;first.scrollLeft=180;
  const after=a.project(object);expect(after.x-initial.x).toBe(-180);expect(after.y-initial.y).toBe(24);expect(b.project(object).x).toBe(initial.x);
  expect(a.unproject(after).x).toBeCloseTo(object.x,10);expect(a.unproject(after).y).toBeCloseTo(object.y,10);expect(a.clipRect().width).toBe(340);
 });
 it("inserts temporary reading blocks in creation order, excludes deleted anchors and removes all on close",()=>{
  const container=document.createElement('div'),p=document.createElement('p');p.textContent='Original';document.body.append(container);container.append(p);
  const base={anchor:{kind:'markdown',key:'p'},element:p} as unknown as BoardSurface,views=new BoardSlotViews(container,()=>{});
  views.sync([base],[{id:'SLOT-a',anchorKey:'p',width:640,height:240},{id:'SLOT-b',anchorKey:'p',width:420,height:200}],false);
  expect([...container.children].map(el=>el.getAttribute('data-board-slot'))).toEqual([null,'SLOT-a','SLOT-b']);expect(p.textContent).toBe('Original');
  views.sync([],[],false);expect(container.children).toHaveLength(1);views.sync([base],[{id:'SLOT-a',anchorKey:'p',width:640,height:240}],false);
  views.clear();expect(container.innerHTML).toBe('<p>Original</p>');
 });
});
