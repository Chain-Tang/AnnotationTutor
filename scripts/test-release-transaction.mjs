import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealRelease, installRelease, rollbackRelease, withReleaseLock, installedProgramFiles, installedProgramMatches } from './release-transaction.mjs';
const temporary = async prefix => realpath(await mkdtemp(path.join(tmpdir(), prefix)));
test('upgrade, failed install, rollback and re-upgrade preserve new learning data and keys', async () => {
  const root = await temporary('tutor-release-');
  try {
    const target = path.join(root, 'plugin'), source = path.join(root, 'release'), backupRoot = path.join(root, 'backups');
    await mkdir(target); await mkdir(source);
    for (const [dir, version] of [[target,'0.3.0'],[source,'0.3.1']]) {
      await writeFile(path.join(dir, 'main.js'), version);
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version }));
    }
    await writeFile(path.join(target,'data.json'), JSON.stringify({ apiKey:'fixture-secret' }));
    await writeFile(path.join(target,'user-artwork.svg'), '<svg/>');
    await sealRelease(source);
    for (const injectFailure of ['copy','health','journal-applied']) {
      await assert.rejects(installRelease({source,target,backupRoot,injectFailure}));
      assert.equal(await readFile(path.join(target,'main.js'),'utf8'), '0.3.0');
    }
    const installed = await installRelease({source,target,backupRoot});
    await writeFile(path.join(target,'new-learning.json'), '{"attempt":1}');
    const reference={version:1,id:'11111111-1111-4111-8111-111111111111',slot:'apiKey',binding:'a'.repeat(64)};
    await writeFile(path.join(target,'data.json'), JSON.stringify({learningFlowEnabled:true,
      webEnabled:true,webBridgeToken:'legacy-shared-token',boardMcpEnabled:true,
      credentialRefs:[reference],tutorPairings:[{tokenHash:'revoked-fixture',revoked:true}]}));
    await rollbackRelease({backup:installed.backup,target});
    assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'0.3.0');
    assert.equal(JSON.parse(await readFile(path.join(target,'data.json'),'utf8')).apiKey,undefined);
    const restored=JSON.parse(await readFile(path.join(target,'data.json'),'utf8'));
    assert.equal(restored.webEnabled,false);assert.equal(restored.boardMcpEnabled,false);assert.equal(restored.webBridgeToken,'');
    assert.deepEqual(restored.credentialRefs,[reference]);assert.equal(restored.tutorPairings[0].revoked,true);
    assert.equal(await readFile(path.join(target,'new-learning.json'),'utf8'),'{"attempt":1}');
    await installRelease({source,target,backupRoot});
    assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'0.3.1');
    assert.equal(await readFile(path.join(target,'user-artwork.svg'),'utf8'),'<svg/>');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('only one installer can own a target and the lock releases after failures', async () => {
  const root=await temporary('tutor-lock-');
  try {
    const target=path.join(root,'plugin');let release;
    const held=new Promise(resolve=>{release=resolve;});let entered;
    const ready=new Promise(resolve=>{entered=resolve;});
    const first=withReleaseLock(target,async()=>{entered();await held;});await ready;
    try {await assert.rejects(withReleaseLock(target,()=>assert.fail('second installer entered')),/locked/);}
    finally {release();await first;}
    await assert.rejects(withReleaseLock(target,()=>{throw Error('fixture failure');}),/fixture failure/);
    await withReleaseLock(target,async()=>{});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('failed health check preserves new and edited user assets with current settings', async () => {
  const root=await temporary('tutor-health-data-');
  try {
    const target=path.join(root,'plugin'),source=path.join(root,'release'),backupRoot=path.join(root,'backups');
    for(const [dir,version] of [[target,'old'],[source,'new']]){
      await mkdir(dir);await writeFile(path.join(dir,'main.js'),version);await writeFile(path.join(dir,'manifest.json'),JSON.stringify({version}));
    }
    await writeFile(path.join(target,'artwork.svg'),'old art');await writeFile(path.join(target,'deleted-learning.json'),'no longer authorized');await sealRelease(source);
    const before=await installedProgramFiles(target);
    await assert.rejects(installRelease({source,target,backupRoot,health:async()=>{
      await mkdir(path.join(target,'learning'));await writeFile(path.join(target,'learning/new.json'),'new learning');
      await writeFile(path.join(target,'artwork.svg'),'edited art');await writeFile(path.join(target,'data.json'),'{"credentialRef":"current"}');
      await rm(path.join(target,'deleted-learning.json'));
      throw Error('health failed');
    }}),/health failed/);
    assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'old');
    assert.equal(await readFile(path.join(target,'artwork.svg'),'utf8'),'edited art');
    assert.equal(await readFile(path.join(target,'learning/new.json'),'utf8'),'new learning');
    assert.equal(JSON.parse(await readFile(path.join(target,'data.json'),'utf8')).credentialRef,'current');
    await assert.rejects(readFile(path.join(target,'deleted-learning.json')), {code:'ENOENT'});
    assert.equal(await installedProgramMatches(target,before),true);
    await writeFile(path.join(target,'main.js'),'unverified program');
    assert.equal(await installedProgramMatches(target,before),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed final recovery journal reports its state and retains the previous program', async () => {
  const root=await temporary('tutor-final-journal-');
  try {
    const target=path.join(root,'plugin'),source=path.join(root,'release'),backupRoot=path.join(root,'backups');
    for(const [dir,version] of [[target,'old'],[source,'new']]){
      await mkdir(dir);await writeFile(path.join(dir,'main.js'),version);await writeFile(path.join(dir,'manifest.json'),JSON.stringify({version}));
    }
    await sealRelease(source);
    const result=await installRelease({source,target,backupRoot,injectFailure:'journal-final'});
    assert.equal(result.status,'health-passed-recovery-journal-pending');
    assert.equal(await readFile(path.join(result.retainedPrevious,'main.js'),'utf8'),'old');
    assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'new');
    const pending=JSON.parse(await readFile(path.join(result.backup,'transaction.json'),'utf8'));
    assert.equal(pending.completed,false);assert.equal(pending.phase,'applied');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('offline recovery restores config and unknown assets after interruption between directory swaps',async()=>{
 const root=await temporary('tutor-interrupt-');
 try {const target=path.join(root,'plugin'),source=path.join(root,'release'),backupRoot=path.join(root,'backups');await mkdir(target);await mkdir(source);
 for(const [dir,version]of [[target,'0.3.0'],[source,'0.4.2']]){await writeFile(path.join(dir,'main.js'),version);await writeFile(path.join(dir,'manifest.json'),JSON.stringify({version}));}
 await writeFile(path.join(target,'data.json'),JSON.stringify({apiKey:'fixture-kept-key'}));await writeFile(path.join(target,'new-art.svg'),'<svg>keep</svg>');await sealRelease(source);
 await assert.rejects(installRelease({source,target,backupRoot,injectFailure:'interrupted'}));const backup=path.join(backupRoot,(await readdir(backupRoot))[0]);
 await rollbackRelease({backup,target});assert.equal(JSON.parse(await readFile(path.join(target,'data.json'),'utf8')).apiKey,'fixture-kept-key');assert.equal(await readFile(path.join(target,'new-art.svg'),'utf8'),'<svg>keep</svg>');assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'0.3.0');
 }finally{await rm(root,{recursive:true,force:true});}
});
