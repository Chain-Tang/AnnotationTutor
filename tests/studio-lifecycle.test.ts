// @vitest-environment happy-dom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {WorkspaceLeaf} from 'obsidian';
vi.mock('obsidian',()=>({
  ItemView:class {contentEl=document.createElement('div');containerEl=this.contentEl;async setState(){}},
  Modal:class{},Notice:class{},Menu:class{},setIcon:vi.fn(),
}));
import {StandaloneBoardView} from '../src/views/board-view.js';
import {createBoardDocument} from '../src/board-model.js';
import type {BoardBundle} from '../src/board-types.js';
import type {BoardHistory} from '../src/board-model.js';
import type {BoardSpatialIndex} from '../src/board-spatial.js';
import {setLocale} from '../src/i18n.js';
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const bundle=(source:string):BoardBundle=>({document:createBoardDocument(source,'standalone',`BOARD-${source.replace(/\W/g,"-")}`),ink:{}});
const views:StandaloneBoardView[]=[];
beforeEach(()=>{
  setLocale('en');
  const create=function(this:HTMLElement,tag:string,opts?:{cls?:string;text?:string}){const e=document.createElement(tag);if(opts?.cls)e.className=opts.cls;if(opts?.text)e.textContent=opts.text;this.append(e);return e;};
  Object.assign(HTMLElement.prototype,{empty(this:HTMLElement){this.replaceChildren();},addClass(this:HTMLElement,cls:string){this.classList.add(cls);},createEl:create,createDiv(this:HTMLElement,opts:object){return create.call(this,'div',opts);}});
});
afterEach(async()=>{for(const view of views.splice(0))await view.onClose();document.body.replaceChildren();vi.restoreAllMocks();});
function view(open:(source:string)=>Promise<BoardBundle>,assets=async()=>[]){
  const save=vi.fn(async(_bundle:BoardBundle,_preview?:string)=>{}),v=new StandaloneBoardView({} as WorkspaceLeaf,{open,save,assets});
  const internal=v as unknown as {renderShell():void;preview():string};
  const render=vi.spyOn(internal,'renderShell').mockImplementation(()=>{v.contentEl.empty();v.contentEl.textContent='canvas';});
  vi.spyOn(internal,'preview').mockReturnValue('<svg/>');
  document.body.append(v.contentEl);views.push(v);return {v,save,render};
}
it('restores a journaled scene as dirty with one undo to its saved baseline',async()=>{
  const data=bundle('Recovery.md'),baseline=structuredClone(data.document);
  data.document.title='Unsaved title';data.document.revision++;
  data.recovery={baseline,conflicted:false};
  const {v,save}=view(async()=>structuredClone(data));await v.setState({sourceFile:'Recovery.md'},{history:false});
  const internal=v as unknown as {sceneDirty:boolean;history:BoardHistory};
  expect(internal.sceneDirty).toBe(true);expect(internal.history.canUndo).toBe(true);
  internal.history.undo();expect(internal.history.document.title).toBe(baseline.title);
  await v.flush();expect(save).toHaveBeenCalledOnce();expect(internal.sceneDirty).toBe(false);
});
it('a throwing derived preview cannot block flush of the authoritative scene',async()=>{
  const {v,save}=view(async()=>bundle('Preview.md'));await v.setState({sourceFile:'Preview.md'},{history:false});
  const internal=v as unknown as {sceneDirty:boolean;preview():string};internal.sceneDirty=true;
  vi.spyOn(internal,'preview').mockImplementation(()=>{throw new Error('SVG unavailable');});
  await v.flush();expect(save).toHaveBeenCalledOnce();expect(save.mock.calls[0]?.[1]).toBeUndefined();expect(internal.sceneDirty).toBe(false);
});
it('waits for both document and assets; concurrent restoration of the same source loads once',async()=>{
  const data=deferred<BoardBundle>(),assets=deferred<[]>(),open=vi.fn(()=>data.promise);
  const {v,render}=view(open,()=>assets.promise);
  const state=v.setState({sourceFile:'A.md'},{history:false}),again=v.setState({sourceFile:'A.md'},{history:false});
  let ready=false;const waiting=v.whenReady().then(()=>{ready=true;});
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());
  data.resolve(bundle('A.md'));await Promise.resolve();expect(ready).toBe(false);expect(render).not.toHaveBeenCalled();
  assets.resolve([]);await Promise.all([state,again,waiting]);expect(ready).toBe(true);
  expect((await v.toolSurface().read()).target.source).toBe('A.md');expect(render).toHaveBeenCalledOnce();
});
it('a late result for another source cannot overwrite the current scene or save it under the old name',async()=>{
  const a=deferred<BoardBundle>(),open=vi.fn((source:string)=>source==='A.md'?a.promise:Promise.resolve(bundle(source)));
  const {v,save}=view(open);const first=v.setState({sourceFile:'A.md'},{history:false});
  await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());
  await v.setState({sourceFile:'B.md'},{history:false});a.resolve(bundle('A.md'));await first;await v.whenReady();
  expect((await v.toolSurface().read()).target.source).toBe('B.md');expect(save).not.toHaveBeenCalled();
});
it('closing during asset loading cannot revive the closed canvas',async()=>{
  const assets=deferred<[]>();const {v,render,save}=view(async()=>bundle('A.md'),()=>assets.promise);
  const state=v.setState({sourceFile:'A.md'},{history:false});await vi.waitFor(()=>expect(v.contentEl.textContent).toContain('Opening'));
  await v.onClose();assets.resolve([]);await state;
  expect(render).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(v.contentEl.textContent).toBe('');
  await expect(v.whenReady()).rejects.toThrow('studio-not-ready');
});
it('a failed restore preserves saved data and offers a retry that can become healthy',async()=>{
  const open=vi.fn().mockRejectedValueOnce(new Error('offline-read')).mockResolvedValue(bundle('A.md'));
  const {v,save}=view(open);await expect(v.setState({sourceFile:'A.md'},{history:false})).rejects.toThrow('offline-read');
  expect(v.contentEl.querySelector('[role="alert"]')).not.toBeNull();expect(save).not.toHaveBeenCalled();
  v.contentEl.querySelector('button')!.click();await v.whenReady();
  expect((await v.toolSurface().read()).target.source).toBe('A.md');expect(save).not.toHaveBeenCalled();
});
it('invalidates a previous tool handle after closing and reopening the same drawing',async()=>{
  const {v}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});const old=v.toolSurface();
  await v.onClose();await v.onOpen();await v.whenReady();
  await expect(old.read()).rejects.toThrow('surface-closed');expect(()=>old.preview()).toThrow('surface-closed');expect((await v.toolSurface().read()).target.source).toBe('A.md');
});

type Scene = {
  history:BoardHistory;bundle:BoardBundle;sourceFile:string;closed:boolean;raf:number;
  gesture:null|{pointerId:number;mode:'pen'|'select';startClient:{x:number;y:number};startWorld:{x:number;y:number};lastClient:{x:number;y:number};points:{x:number;y:number;pressure?:number;t?:number}[];seed:number};
  draftObjects:BoardBundle['document']['objects']|null;visibleObjects:BoardBundle['document']['objects'];
  spatial:BoardSpatialIndex;minimapObjectCache:unknown;backgroundCanvas?:HTMLCanvasElement;draftCanvas?:HTMLCanvasElement;
  embeddedImages:Map<string,string>;paintAssets:Map<string,Uint8Array>;restoredTiles:Map<string,unknown>;
  checkpointService:unknown;statusEl:HTMLElement;activeLayerId:string;
  finish(id:number):void;schedule():void;draw():void;commit():void;
  restorePaintTiles(viewport:{x:number;y:number;width:number;height:number}):Promise<void>;
  maybeCheckpointPaintLayer(layer:string,force?:boolean):Promise<void>;
};
const scene=(v:StandaloneBoardView)=>v as unknown as Scene;
function pen(v:StandaloneBoardView){const s=scene(v);s.gesture={pointerId:7,mode:'pen',startClient:{x:10,y:20},startWorld:{x:10,y:20},lastClient:{x:20,y:30},points:[{x:10,y:20,pressure:.2,t:0},{x:20,y:30,pressure:.8,t:16}],seed:77};}

it('releases closed scene references and owned pixels, resets the cancelled frame and can schedule after reopening',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});const s=scene(v);
  const objects=[{id:'draft',kind:'rect' as const,anchor:{kind:'canvas' as const,pageId:'main'},x:0,y:0,width:20,height:20,color:'#111',strokeWidth:1,groupId:'draft',createdBy:'human' as const,editedBy:'human' as const,revision:1}];
  s.bundle.ink={raw:{id:'raw',createdAt:'',points:[{x:0,y:0},{x:10,y:10}]}};
  s.spatial.rebuild(objects,'draft',s.bundle.ink);s.visibleObjects=objects;s.draftObjects=objects;s.minimapObjectCache={objects};
  const canvas=document.createElement('canvas');canvas.width=200;canvas.height=100;s.backgroundCanvas=canvas;
  s.embeddedImages.set('synthetic','data:image/png;base64,AA==');s.paintAssets.set('synthetic',new Uint8Array(2));
  const frame=vi.spyOn(globalThis,'requestAnimationFrame').mockReturnValue(123),cancel=vi.spyOn(globalThis,'cancelAnimationFrame').mockImplementation(()=>{});
  s.schedule();await v.onClose();
  expect(cancel).toHaveBeenCalledWith(123);expect(s.raf).toBe(0);expect(s.visibleObjects).toEqual([]);expect(s.draftObjects).toBeNull();expect(s.minimapObjectCache).toBeNull();
  expect(s.spatial.search({kind:'canvas',pageId:'main'},{x:0,y:0,width:100,height:100})).toEqual([]);
  expect(canvas.width*canvas.height).toBe(0);expect(s.backgroundCanvas).toBeUndefined();expect(s.embeddedImages.size+s.paintAssets.size).toBe(0);
  s.schedule();expect(frame).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();
  await v.onOpen();const requests=frame.mock.calls.length;s.schedule();expect(s.raf).toBe(123);expect(frame).toHaveBeenCalledTimes(requests+1);
});

it('finishes an unlifted pen on its original source before switching, preserving raw samples and one undo',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});const old=scene(v).history;pen(v);
  await v.setState({sourceFile:'B.md'},{history:false});
  expect(save).toHaveBeenCalledOnce();const saved=save.mock.calls[0]![0] as unknown as BoardBundle;
  expect(saved.document.sourceFile).toBe('A.md');expect(saved.document.objects).toHaveLength(1);
  const object=saved.document.objects[0]!;expect(saved.ink[object.inkId!]!.points).toEqual([{x:0,y:0,pressure:.2,t:0},{x:10,y:10,pressure:.8,t:16}]);
  expect(old.undo()!.objects).toHaveLength(0);expect(old.canUndo).toBe(false);expect(scene(v).history.document.objects).toHaveLength(0);
});

it('settles a moving-object draft before closing without changing its object identity',async()=>{
  const data=bundle('A.md');data.document.objects.push({id:'keep-id',kind:'rect',anchor:{kind:'canvas',pageId:'main'},x:0,y:0,width:20,height:20,color:'#111',strokeWidth:1,layerId:'layer-default',groupId:'group',createdBy:'human',editedBy:'human',revision:1});
  const {v,save}=view(async()=>data);await v.setState({sourceFile:'A.md'},{history:false});const s=scene(v);
  s.draftObjects=s.history.document.objects.map(o=>({...o,x:50,y:70}));s.gesture={pointerId:7,mode:'select',startClient:{x:0,y:0},startWorld:{x:0,y:0},lastClient:{x:50,y:70},points:[],seed:0};
  await v.onClose();expect(save).toHaveBeenCalledOnce();const saved=save.mock.calls[0]![0] as unknown as BoardBundle;
  expect(saved.document.objects[0]).toMatchObject({id:'keep-id',x:50,y:70});
});

it('keeps a failed-close drawing recoverable, and retries its save before releasing it',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);save.mockRejectedValueOnce(new Error('disk-full'));
  await expect(v.onClose()).rejects.toThrow('disk-full');const s=scene(v);expect(s.history.document.objects).toHaveLength(1);expect(Object.keys(s.bundle.ink)).toHaveLength(1);
  const inkId=s.history.document.objects[0]!.inkId;
  await v.onClose();expect(save).toHaveBeenCalledTimes(2);expect((save.mock.calls[1]![0] as unknown as BoardBundle).document.objects[0]!.inkId).toBe(inkId);expect(s.history).toBeNull();
});

it('keeps the original source on a failed switch and saves the same ink on retry',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});pen(v);save.mockRejectedValueOnce(new Error('disk-full'));
  await expect(v.setState({sourceFile:'B.md'},{history:false})).rejects.toThrow('disk-full');expect(scene(v).sourceFile).toBe('A.md');const inkId=scene(v).history.document.objects[0]!.inkId;
  await v.setState({sourceFile:'B.md'},{history:false});expect(save).toHaveBeenCalledTimes(2);expect((save.mock.calls[1]![0] as unknown as BoardBundle).document.objects[0]!.inkId).toBe(inkId);
});

it('retries a failed autosave on close even after its timer has already fired',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});save.mockRejectedValueOnce(new Error('offline'));pen(v);scene(v).finish(7);
  await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce());await Promise.resolve();await v.onClose();
  expect(save).toHaveBeenCalledTimes(2);expect((save.mock.calls[1]![0] as unknown as BoardBundle).document.objects[0]!.inkId).toBe((save.mock.calls[0]![0] as unknown as BoardBundle).document.objects[0]!.inkId);
});

it('reopens the retained failed-close scene rather than loading over unsaved ink',async()=>{
  const open=vi.fn(async()=>bundle('A.md'));const {v,save}=view(open);await v.setState({sourceFile:'A.md'},{history:false});pen(v);save.mockRejectedValueOnce(new Error('offline'));
  await expect(v.onClose()).rejects.toThrow('offline');const before=scene(v).history,ink=scene(v).bundle.ink;
  await v.onOpen();await v.whenReady();expect(open).toHaveBeenCalledOnce();expect(scene(v).history).toBe(before);expect(scene(v).bundle.ink).toBe(ink);expect((await v.toolSurface().read()).objects).toHaveLength(1);
  await v.onClose();expect(save).toHaveBeenCalledTimes(2);
});

it('waits for a closing save before reopening and rejects tools while the transition is pending',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});const old=v.toolSurface();pen(v);
  const pending=deferred<void>();save.mockImplementationOnce(()=>pending.promise);const close=v.onClose();await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce());
  let opened=false;const reopen=v.onOpen().then(()=>{opened=true;});await Promise.resolve();expect(opened).toBe(false);await expect(old.read()).rejects.toThrow('surface-closed');expect(v.contentEl.inert).toBe(true);
  pending.resolve();await Promise.all([close,reopen]);expect(v.contentEl.inert).toBe(false);expect(scene(v).closed).toBe(false);
});

it('releases draft caches on source change and never persists an uncommitted AI preview',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});const s=scene(v);
  const canvas=document.createElement('canvas');canvas.width=100;canvas.height=200;s.draftCanvas=canvas;
  s.draftObjects=[{id:'preview',kind:'rect',anchor:{kind:'canvas',pageId:'main'},x:0,y:0,width:20,height:20,color:'#111',strokeWidth:1,groupId:'preview',createdBy:'tutor',editedBy:'tutor',revision:1}];
  s.spatial.rebuild(s.draftObjects,'preview',{raw:{id:'raw',createdAt:'',points:[{x:0,y:0},{x:20,y:20}]}});s.visibleObjects=s.draftObjects;
  await v.setState({sourceFile:'B.md'},{history:false});expect(s.draftObjects).toBeNull();expect(s.visibleObjects).toEqual([]);expect(canvas.width*canvas.height).toBe(0);
  expect((save.mock.calls[0]![0] as unknown as BoardBundle).document.objects).toEqual([]);
});

it('serializes an in-flight save, flushes the latest revision, and only loads the last requested source',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});pen(v);scene(v).finish(7);
  const pending=deferred<void>();save.mockImplementationOnce(()=>pending.promise);const flush=v.flush();await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce());
  scene(v).history.transact(d=>{d.objects[0]!.color='#ff0000';});scene(v).commit();
  const b=v.setState({sourceFile:'B.md'},{history:false}),c=v.setState({sourceFile:'C.md'},{history:false});
  await Promise.resolve();expect(save).toHaveBeenCalledOnce();pending.resolve();await Promise.all([flush,b,c]);
  expect(scene(v).sourceFile).toBe('C.md');const snapshots=save.mock.calls.map(call=>call[0] as unknown as BoardBundle);expect(snapshots.every(s=>s.document.sourceFile==='A.md')).toBe(true);expect(snapshots.at(-1)!.document.objects[0]!.color).toBe('#ff0000');
});

it('retains a failed gesture transaction and does not publish orphan ink',async()=>{
  const {v}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);const s=scene(v),gesture=s.gesture;
  const original=s.history.transact.bind(s.history);vi.spyOn(s.history,'transact').mockImplementationOnce((mutator)=>{original(d=>{mutator(d);throw new Error('invalid-geometry');});return s.history.document;});
  await expect(v.flush()).rejects.toThrow('invalid-geometry');expect(s.gesture).toBe(gesture);expect(s.bundle.ink).toEqual({});expect(s.history.document.objects).toEqual([]);
});

it.each(['switch','close'] as const)('drops tile restores that arrive after %s even if the next revision is identical',async action=>{
  const {v}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});const s=scene(v),tiles=deferred<[]>();s.checkpointService={restoreVisible:()=>tiles.promise,dispose:vi.fn()};
  const pending=s.restorePaintTiles({x:0,y:0,width:50,height:50});
  if(action==='switch')await v.setState({sourceFile:'B.md'},{history:false});else await v.onClose();
  // A sentinel must not be removed by an old request's manifest reconciliation.
  s.restoredTiles.set('new-target',{});tiles.resolve([]);await pending;expect(s.restoredTiles.has('new-target')).toBe(true);s.restoredTiles.clear();
});

it('drops late checkpoint manifests and errors rather than modifying the next target',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});const s=scene(v),result=deferred<BoardBundle['document']['tileManifest']>();
  s.checkpointService={checkpoint:()=>result.promise,dispose:vi.fn()};const pending=s.maybeCheckpointPaintLayer('layer-default',true);
  await v.setState({sourceFile:'B.md'},{history:false});const before=s.history.document.tileManifest;save.mockClear();result.resolve({format:'board-tiles-v1',tileSize:512,gutter:2,checkpointRevision:1,compression:'deflate-rgba-v1',tiles:[]});await pending;
  expect(s.history.document.tileManifest).toEqual(before);expect(save).not.toHaveBeenCalled();
  const rejected=deferred<BoardBundle['document']['tileManifest']>();s.checkpointService={checkpoint:()=>rejected.promise,dispose:vi.fn()};const old=s.maybeCheckpointPaintLayer('layer-default',true);
  await v.setState({sourceFile:'C.md'},{history:false});s.statusEl=document.createElement('div');s.statusEl.textContent='current-status';rejected.reject(new Error('old-tile-error'));await old;expect(s.statusEl.textContent).toBe('current-status');
});

it('hands a failed-save Studio scene to its new locator without releasing pixels, ink or undo',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});
  const old=v.toolSurface(),history=scene(v).history;pen(v);save.mockRejectedValueOnce(new Error('disk-full'));
  const participant=v.sourceMoveParticipant('A.md')!,snapshot=await participant.prepare();
  expect(v.contentEl.inert).toBe(true);await expect(old.read()).rejects.toThrow('surface-closed');
  const moved={...snapshot,document:{...snapshot.document,sourceFile:'B.md',revision:snapshot.document.revision+1}};
  participant.accept(moved,{boardId:moved.document.id,from:'A.md',to:'B.md',durability:'recovery-only'});participant.release();
  expect(scene(v).history).toBe(history);expect(v.getState()).toEqual({sourceFile:'B.md'});
  expect(scene(v).bundle.ink).toEqual(snapshot.ink);expect(v.contentEl.inert).toBe(false);
  await expect(old.read()).rejects.toThrow('surface-closed');expect((await v.toolSurface().read()).target.source).toBe('B.md');
  history.undo();expect(history.document.objects).toEqual([]);expect(history.document.sourceFile).toBe('B.md');history.redo();
  await v.flush();expect(save.mock.calls.at(-1)![0].document.sourceFile).toBe('B.md');
});
it('does not hide a failed gesture behind a successful source recovery',async()=>{
  const {v}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);
  const s=scene(v),gesture=s.gesture,participant=v.sourceMoveParticipant('A.md')!;
  vi.spyOn(s.history,'transact').mockImplementationOnce(()=>{throw new Error('invalid-geometry');});
  await expect(participant.prepare()).rejects.toThrow('invalid-geometry');participant.release();
  expect(s.gesture).toBe(gesture);expect(s.bundle.ink).toEqual({});expect(s.history.document.objects).toEqual([]);
  expect(v.getState()).toEqual({sourceFile:'A.md'});expect(v.contentEl.inert).toBe(false);
});
it('serializes a requested Studio source switch behind a verified relocation',async()=>{
  const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});pen(v);
  const participant=v.sourceMoveParticipant('A.md')!,snapshot=await participant.prepare();
  let switched=false;const switching=v.setState({sourceFile:'C.md'},{history:false}).then(()=>{switched=true;});
  await Promise.resolve();expect(switched).toBe(false);
  const moved={...snapshot,document:{...snapshot.document,sourceFile:'B.md',revision:snapshot.document.revision+1}};
  participant.accept(moved,{boardId:moved.document.id,from:'A.md',to:'B.md',durability:'committed'});participant.release();
  await switching;expect(v.getState()).toEqual({sourceFile:'C.md'});
  expect(save.mock.calls.map(call=>call[0].document.sourceFile)).toEqual(['A.md','B.md']);
});
it('does not release a closing Studio until the source handoff settles, then saves the new locator',async()=>{
  const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);
  const participant=v.sourceMoveParticipant('A.md')!,snapshot=await participant.prepare();
  let closed=false;const closing=v.onClose().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
  const moved={...snapshot,document:{...snapshot.document,sourceFile:'B.md',revision:snapshot.document.revision+1}};
  participant.accept(moved,{boardId:moved.document.id,from:'A.md',to:'B.md',durability:'recovery-only'});participant.release();
  await closing;expect(scene(v).history).toBeNull();expect(save.mock.calls.at(-1)![0].document.sourceFile).toBe('B.md');
});
it('requires a successful save for a version choice and retains original ink on failure',async()=>{
 const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);const history=scene(v).history,participant=v.sourceMoveParticipant('A.md')!;save.mockRejectedValueOnce(new Error('disk-full'));
 await expect(participant.prepare(true)).rejects.toThrow('disk-full');participant.release();expect(scene(v).history).toBe(history);expect(history.document.objects).toHaveLength(1);expect(Object.keys(scene(v).bundle.ink)).toHaveLength(1);expect(v.contentEl.inert).toBe(false);
});
it('replaces a saved Studio version on its original source and releases old scene caches',async()=>{
 const {v,save}=view(async()=>bundle('A.md'));await v.setState({sourceFile:'A.md'},{history:false});pen(v);const history=scene(v).history,handle=v.toolSurface(),participant=v.sourceMoveParticipant('A.md')!;
 await participant.prepare(true);const s=scene(v),canvas=document.createElement('canvas');canvas.width=500;canvas.height=500;s.backgroundCanvas=canvas;s.paintAssets.set('old',new Uint8Array(3));
 const selected=bundle('A.md');selected.document.id='BOARD-selected';selected.document.title='Selected';await participant.replaceVersion!(selected);participant.release();
 expect(v.getState()).toEqual({sourceFile:'A.md'});expect(scene(v).history.document.id).toBe('BOARD-selected');expect(scene(v).history).not.toBe(history);expect(canvas.width*canvas.height).toBe(0);expect(scene(v).paintAssets.size).toBe(0);
 expect(save.mock.calls[0]![0].document.objects).toHaveLength(1);await expect(handle.read()).rejects.toThrow('surface-closed');expect((await v.toolSurface().read()).target.id).toBe('BOARD-selected');expect(v.contentEl.inert).toBe(false);
});
it('keeps a failed post-commit Studio load unavailable and retries the selected version',async()=>{
 const selected=bundle('A.md');selected.document.id='BOARD-selected';let current=bundle('A.md'),fail=false;
 const {v}=view(async()=>structuredClone(current),async()=>{if(fail)throw new Error('asset-load-unavailable');return[];});await v.setState({sourceFile:'A.md'},{history:false});
 const participant=v.sourceMoveParticipant('A.md')!;await participant.prepare(true);current=selected;fail=true;
 await expect(participant.replaceVersion!(selected)).rejects.toThrow('asset-load-unavailable');participant.release();expect(scene(v).history).toBeNull();expect(v.contentEl.querySelector('[role="alert"]')).not.toBeNull();await expect(v.whenReady()).rejects.toThrow('asset-load-unavailable');
 fail=false;v.contentEl.querySelector('button')!.click();await v.whenReady();expect(scene(v).history.document.id).toBe('BOARD-selected');expect(v.getState()).toEqual({sourceFile:'A.md'});
});
it('does not redirect a selected Studio load when a subsequent source switch is queued',async()=>{
 const {v,save}=view(async source=>bundle(source));await v.setState({sourceFile:'A.md'},{history:false});const participant=v.sourceMoveParticipant('A.md')!;await participant.prepare(true);
 let finished=false;const switching=v.setState({sourceFile:'B.md'},{history:false}).then(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);
 const selected=bundle('A.md');selected.document.id='BOARD-selected';await participant.replaceVersion!(selected);participant.release();await switching;expect(v.getState()).toEqual({sourceFile:'B.md'});
 expect(save.mock.calls.some(call=>call[0].document.id==='BOARD-selected'&&call[0].document.sourceFile==='A.md')).toBe(true);expect(save.mock.calls.every(call=>call[0].document.sourceFile==='A.md')).toBe(true);
});
