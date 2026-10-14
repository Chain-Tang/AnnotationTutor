import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { installRelease, rollbackRelease, sealRelease, verifyRelease, withReleaseLock, installedProgramFiles, installedProgramMatches, inspectRollbackCredentials } from './release-transaction.mjs';
import { downgradeSettings, planCredentialTransition } from './release-state.mjs';
import { evaluateObsidian } from './obsidian-eval.mjs';
const arg = key => {const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];};
const root=path.resolve(import.meta.dirname,'..'),vault=arg('--vault');
if(!vault)throw new Error('Pass --vault /absolute/vault. Installation never guesses a target.');
const offline=process.argv.includes('--offline'),target=path.join(path.resolve(vault),'.obsidian/plugins/annotation-tutor-lite');
const backupRoot=path.join(os.homedir(),'Library/Application Support/Tutor/backups/installations');
const evalHost=code=>evaluateObsidian(code,{vault:path.basename(vault),timeout:60000});
async function install() {
let temporary;
let source=arg('--source');
let stopped=false;
let previousProgram;
try {
if(!arg('--rollback')){
 if(!source){temporary=path.join(root,'dist',`install-${randomUUID()}`);source=temporary;
  await withReleaseLock(path.join(root,'dist','artifacts'),async()=>{await mkdir(source,{recursive:true});
  for(const file of ['main.js','desktop.js','mobile.js','credential-compatibility.json'])await cp(path.join(root,'dist',file),path.join(source,file));
  for(const file of ['manifest.json','styles.css'])await cp(path.join(root,file),path.join(source,file));
  for(const file of ['assets','licenses'])await cp(path.join(root,'dist',file),path.join(source,file),{recursive:true});
  try{await cp(path.join(root,'extension/dist'),path.join(source,'web-clipper'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  await sealRelease(source);
  });
 }
 const release=await verifyRelease(source);
 await planCredentialTransition({current:target,source,files:release.files,requireReferences:process.argv.includes('--require-credential-refs')});
}else{
 if(process.argv.includes('--require-credential-refs'))throw new Error('Choose --source with --require-credential-refs to reconnect using a compatible program');
 await inspectRollbackCredentials({backup:path.resolve(arg('--rollback')),target});
}
 previousProgram=await installedProgramFiles(target).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
 if(!offline){await evalHost(`(async()=>{if(app.vault.adapter.getBasePath()!==${JSON.stringify(path.resolve(vault))})throw new Error('Vault identity mismatch');const p=app.plugins.plugins['annotation-tutor-lite'];if(p){if(p.prepareUpgrade)await p.prepareUpgrade();else{if(p.tutorConversation?.state.busy||p.runningAgents?.size)throw new Error('Tutor is busy');if([...p.tutorConversation.tasks.entries.values()].some(e=>!['completed','failed','cancelled'].includes(e.task.state)))throw new Error('External tasks are busy');await p.boards?.changeRoot();await p.tutorJournal?.flush();}await app.plugins.disablePlugin('annotation-tutor-lite');}return true;})()`);stopped=true;}
 const health=async receipt=>{
  if(offline)return;
  try{await evalHost(`(async()=>{await app.plugins.loadManifest(app.plugins.getPluginFolder()+'/annotation-tutor-lite');await app.plugins.enablePlugin('annotation-tutor-lite');const p=app.plugins.plugins['annotation-tutor-lite'];if(!p?.tutorConversation||p.manifest.version!==${JSON.stringify(receipt.version)})throw new Error('Plugin health check failed');if(${JSON.stringify(receipt.credentialCompatibility?.externalServices==='disabled')}&&(p.settings.webEnabled||p.settings.boardMcpEnabled||p.settings.webBridgeToken||p.settings.androidInkToken))throw new Error('Historical external service boundary was not retained');if(Object.entries(${JSON.stringify(receipt.credentialCompatibility?.mode==='legacy-local-only'?downgradeSettings:{})}).some(([key,value])=>p.settings[key]!==value))throw new Error('Historical local configuration boundary was not retained');const restoredStudios=await p.readyStudioViews?.();return {version:p.manifest.version,restoredStudios};})()`);}
  catch(e){await evalHost(`app.plugins.disablePlugin('annotation-tutor-lite').then(()=>true)`);throw e;}
 };
 const result=arg('--rollback')?await rollbackRelease({backup:path.resolve(arg('--rollback')),target,health}):await installRelease({source,target,backupRoot,health,requireReferences:process.argv.includes('--require-credential-refs')});
 console.log(JSON.stringify({...result,target,health:offline?'offline filesystem check':'Obsidian loaded'},null,2));
}catch(e){
 if(stopped&&!offline){
  if(previousProgram?.['main.js']&&await installedProgramMatches(target,previousProgram))
   await evalHost(`(async()=>{await app.plugins.loadManifest(app.plugins.getPluginFolder()+'/annotation-tutor-lite');await app.plugins.enablePlugin('annotation-tutor-lite');return true;})()`).catch(()=>{});
  else throw new Error('Installation failed and the previous program is not confirmed; automatic plugin restart was blocked. Use the recovery command.',{cause:e});
 }
 throw e;
}
finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
// Acquire before even asking the host to flush/disable, not just during file copying.
await withReleaseLock(`${target}.lifecycle`, install);
