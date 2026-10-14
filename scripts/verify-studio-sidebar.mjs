import {evaluateObsidian} from './obsidian-eval.mjs';import {writeFile,mkdir} from 'node:fs/promises';
const out=await evaluateObsidian(`(async()=>{
 const p=app.plugins.plugins['annotation-tutor-lite'],original=p.tutorConversation;if(original.state.busy)throw new Error('busy');
 const qa=new original.constructor({...original.host,persist:undefined,reset:undefined});
 const source=p.settings.memoryRoot+'/standalone/Upgrade-M0-QA.md';
 const leaf=app.workspace.getLeavesOfType('annotation-tutor-lite-board').find(l=>l.view.sourceFile===source)??app.workspace.getLeaf('tab');
 if(!leaf.view.history)await leaf.setViewState({type:'annotation-tutor-lite-board',active:true,state:{sourceFile:source}});
 const view=leaf.view;app.workspace.setActiveLeaf(leaf,{focus:true});await new Promise(r=>setTimeout(r,100));
 const otherSource=p.settings.memoryRoot+'/standalone/Upgrade-M3-QA.md';
 const other=app.workspace.getLeavesOfType('annotation-tutor-lite-board').find(l=>l!==leaf&&l.view.sourceFile===otherSource)??app.workspace.getLeaf('tab');
 if(!other.view.history)await other.setViewState({type:'annotation-tutor-lite-board',active:false,state:{sourceFile:otherSource}});
 app.workspace.setActiveLeaf(leaf,{focus:true});
 const surface=view.toolSurface(),before=await surface.read(),oldStudio=p.lastStudioView;
 p.tutorConversation=qa;p.lastStudioView=view;
 try{
 const start=Date.now();const pending=qa.submit('请直接在当前 Studio 上画出 y=x² 在 x=2 处的极限图，范围 x=[0,4]、y=[0,16]。标记趋近点与极限值4，使用数学图，不要生图。',{source:'chat',resolveIntent:true,mode:'ask'});
 await new Promise(r=>setTimeout(r,100));
 app.workspace.setActiveLeaf(other,{focus:true});
 await pending;if(qa.state.error)throw new Error(qa.state.error);
 const after=await surface.read(),added=after.objects.filter(o=>!before.objects.some(b=>b.id===o.id));
 if(added.length<3)throw new Error('missing mathematical objects');
 const task=qa.tasks.list('obsidian')[0];if(task.target.id!==surface.id||task.state!=='completed')throw new Error('target or completion mismatch');
 const recorded={passed:true,elapsedMs:Date.now()-start,addedObjects:added.length,target:task.target,route:task.route,switchedWindow:!!other,existingObjectsUnchanged:before.objects.every(b=>JSON.stringify(b)===JSON.stringify(after.objects.find(a=>a.id===b.id)))};
 await view.host.save({...view.bundle,document:view.history.document},view.preview());
 if(!recorded.existingObjectsUnchanged)throw new Error('pre-existing artwork changed');
 const svg=await surface.preview();require('fs').writeFileSync(${JSON.stringify(process.cwd()+'/docs/qa/upgrade-m0/sidebar-math.svg')},svg);
 view.history.undo();await view.host.save({...view.bundle,document:view.history.document},view.preview());
 if(view.history.document.objects.length!==before.objects.length)throw new Error('not single undo');recorded.singleUndo=true;return recorded;
 }finally{qa.tasks.dispose();p.tutorConversation=original;p.lastStudioView=oldStudio;}
})()`);await mkdir('docs/qa/upgrade-m0',{recursive:true});await writeFile('docs/qa/upgrade-m0/sidebar-math.json',JSON.stringify(out,null,2)+'\n');console.log(out);
