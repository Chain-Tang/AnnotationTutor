import {execFileSync} from 'node:child_process';import {mkdir,writeFile} from 'node:fs/promises';
const output=`${process.cwd()}/docs/qa/upgrade-m4`;await mkdir(output,{recursive:true});
const code=`(async()=>{
const p=app.plugins.plugins['annotation-tutor-lite'];if(p.tutorConversation.state.busy)throw new Error('busy');
const source=p.settings.memoryRoot+'/standalone/Upgrade-M4-QA.md',leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}});let v=leaf.view;
const panel=v.contentEl.querySelector('.atl-vector-inspector');const insert=[...panel.querySelectorAll('button')].find(b=>b.textContent.includes('圆团'));if(!insert)throw new Error('insert UI missing');insert.click();await new Promise(r=>setTimeout(r,40));
const before=v.history.document,object=before.objects.find(o=>o.id===v.selectedId),asset=before.vectorAssets.find(a=>a.id===object.vectorAssetId&&a.version===object.vectorAssetVersion);
const surface=v.toolSurface(),scene=await surface.read(),tasks=p.tutorConversation.tasks,task=tasks.start({clientId:'obsidian',target:scene.target});tasks.phase(task.id,'obsidian','precise-edit');
const started=Date.now();let plan;
try{plan=await v.host.vectorPlan({scene,instruction:'请只把这个角色的 clothes 部件改为蓝色 #2255dd；不要移动轮廓，不要改变眼睛或嘴巴，也不要创建新角色。',signal:tasks.signal(task.id,'obsidian'),task});
if(plan.operations.length!==1||plan.operations[0].nodes.some(n=>n.id!=='clothes'))throw new Error('model edited unrelated parts');
await surface.commit({id:crypto.randomUUID(),taskId:task.id,targetId:scene.target.id,baseRevision:scene.target.revision,operations:plan.operations,dependencies:[]},{clientId:'obsidian',targets:[surface.id],read:true,write:true,humanObjectIds:scene.selection,learningMemory:false},tasks.signal(task.id,'obsidian'));tasks.complete(task.id,'obsidian');}catch(e){tasks.fail(task.id,'obsidian','qa-failed',String(e));throw e;}
const after=v.history.document,changed=after.objects.find(o=>o.id===object.id),next=after.vectorAssets.find(a=>a.id===changed.vectorAssetId&&a.version===changed.vectorAssetVersion);
for(const node of next.nodes){const original=asset.nodes.find(n=>n.id===node.id);if(JSON.stringify(node.id==='clothes'?{...node,fill:original.fill}:node)!==JSON.stringify(original))throw new Error('unrelated property changed');}
if(next.nodes.find(n=>n.id==='clothes').fill.color.toLowerCase()!=='#2255dd')throw new Error('color mismatch');
if(JSON.stringify(after.vectorAssets.find(a=>a.id===asset.id&&a.version===asset.version))!==JSON.stringify(asset))throw new Error('history mutated');
v.history.undo();if(v.history.document.objects.find(o=>o.id===object.id).vectorAssetVersion!==asset.version)throw new Error('undo');v.history.redo();v.commit();
v.selectedId=object.id;v.refreshVectorInspector();const save=[...v.contentEl.querySelectorAll('.atl-vector-inspector button')].find(b=>b.textContent==='保存角色版本');save.click();await new Promise(r=>setTimeout(r,500));if(!v.profiles.some(a=>a.id==='parts-'+asset.id))throw new Error('character version not saved');
await v.host.save({...v.bundle,document:v.history.document},v.preview());const rendered=v.renderArtboardCanvas();require('fs').writeFileSync(${JSON.stringify(output+'/character.png')},Buffer.from(rendered.toDataURL('image/png').split(',')[1],'base64'));
await leaf.detach();const reopened=app.workspace.getLeaf('tab');await reopened.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}});v=reopened.view;if(!v.history.document.objects.some(o=>o.id===object.id&&o.vectorAssetVersion===next.version))throw new Error('reopen');
return {passed:true,source,route:v.host.connection(),elapsedMs:Date.now()-started,objectsChanged:1,nodesChanged:1,checks:['real model clothes-only edit','geometry preserved','history preserved','single undo','character version saved','reopen'],scope:'one live case; not the 95% release benchmark'};
})()`;
const result=execFileSync('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',['vault=Documents','eval',`code=${code}`],{encoding:'utf8',timeout:180000});await writeFile(output+'/host-result.txt',result);console.log(result);if(result.includes('Error'))process.exitCode=1;
