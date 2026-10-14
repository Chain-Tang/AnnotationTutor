import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installRelease, rollbackRelease, sealRelease } from './release-transaction.mjs';
import { credentialCompatibilityFile, credentialRecoveryFile, downgradeSettings, planCredentialTransition, supportsCredentialReferences, writeCredentialCompatibility } from './release-state.mjs';
import { diagnoseTutorLock, recoverTutorLock } from './recover-private-state.mjs';

const temporary = async () => realpath(await mkdtemp(path.join(tmpdir(), 'tutor-private-recovery-')));
const reference = (slot = 'apiKey', binding = 'a') => ({ version: 1, slot, id: randomUUID(), binding: binding.repeat(64) });
const readSettings = async target => JSON.parse(await readFile(path.join(target, 'data.json'), 'utf8'));
async function writeSettings(target, value) { await writeFile(path.join(target, 'data.json'), JSON.stringify(value)); }
async function program(directory, body, compatible = false) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'main.js'), body);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '0.5.3' }));
  if (compatible) await writeCredentialCompatibility(directory);
  return sealRelease(directory);
}
async function scenario() {
  const root = await temporary(), target = path.join(root, 'plugin'), source = path.join(root, 'compatible'), backupRoot = path.join(root, 'backups');
  await program(target, 'historical 0.5.3'); await program(source, 'compatible 0.5.3', true);
  await writeSettings(target, { apiKey: 'OBSOLETE-BACKUP-KEY-FIXTURE' });
  const installed = await installRelease({ source, target, backupRoot });
  const refs = [reference(), reference('apiKey', 'b'), reference('boardImageApiKey', 'c'), reference('tutorRemoteToken', 'd'), reference('mcpServersJson', 'e')];
  const journalId = randomUUID();
  await writeSettings(target, { credentialRefs: refs, surfaceTransactionJournalId: journalId, apiModel: 'kept', apiBaseUrl: 'https://fixture.test/v1', agentCommand: 'kept-command',
    chatEngine: 'opencode', boardEngine: 'opencode', pretranslateOnOpen: true, supportCheckinEnabled: true,
    boardImageProvider: 'qwen-compatible', webEnabled: true, boardMcpEnabled: true,
    webBridgeToken: 'REVOKED-SHARED-TOKEN-FIXTURE', androidInkToken: 'REVOKED-INK-TOKEN-FIXTURE', tutorPairings: [{ id: 'revoked', revoked: true }] });
  await mkdir(path.join(target, 'state'), { recursive: true });
  await writeFile(path.join(target, 'state', 'revocations.json'), '{"revoked":["client-fixture"]}');
  await writeFile(path.join(target, 'new-artwork.svg'), '<svg>new artwork</svg>');
  return { root, target, source, backupRoot, installed, refs, journalId };
}
test('same-version legacy rollback preserves all references, disables old services and restores after old settings rewrite', async () => {
  const f = await scenario();
  try {
    const result = await rollbackRelease({ backup: f.installed.backup, target: f.target });
    assert.equal(result.version, '0.5.3'); assert.equal(result.credentialCompatibility.mode, 'legacy-local-only');
    const settings = await readSettings(f.target); assert.deepEqual(settings.credentialRefs, f.refs);
    for (const key of ['apiKey', 'boardImageApiKey', 'tutorRemoteToken', 'mcpServersJson']) assert.equal(settings[key], undefined);
    assert.equal(settings.webEnabled, false); assert.equal(settings.boardMcpEnabled, false);
    assert.equal(settings.webBridgeToken, ''); assert.equal(settings.androidInkToken, '');
    for (const [key, value] of Object.entries(downgradeSettings)) assert.equal(settings[key], value);
    const capsule = await readFile(path.join(f.target, credentialRecoveryFile), 'utf8');
    assert.deepEqual(JSON.parse(capsule).credentialRefs, f.refs); assert.equal(capsule.includes('TOKEN-FIXTURE'), false); assert.equal(capsule.includes('KEY-FIXTURE'), false);
    assert.equal(JSON.parse(capsule).surfaceTransactionJournalId, f.journalId);
    assert.equal(capsule.includes('kept-command'), false); assert.equal(capsule.includes('https://fixture.test'), false);
    // Historical code can drop unknown fields and write empty legacy defaults.
    const rewritten = { ...settings, apiKey: '', mcpServersJson: '', apiModel: 'chosen-in-old' }; delete rewritten.credentialRefs; delete rewritten.surfaceTransactionJournalId;
    await writeSettings(f.target, rewritten);
    const upgraded = await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot, requireReferences: true });
    assert.equal(upgraded.credentialCompatibility.referenceRecovery, 'restored');
    assert.equal(upgraded.credentialCompatibility.surfaceJournalIdentity, 'restored');
    assert.equal((await readSettings(f.target)).surfaceTransactionJournalId, f.journalId);
    assert.deepEqual((await readSettings(f.target)).credentialRefs, f.refs); assert.equal((await readSettings(f.target)).apiModel, 'chosen-in-old');
    assert.equal((await readSettings(f.target)).chatEngine, 'opencode'); assert.equal((await readSettings(f.target)).pretranslateOnOpen, true);
    assert.equal((await readSettings(f.target)).boardImageProvider, 'qwen-compatible');
    assert.equal((await readSettings(f.target)).agentCommand, 'kept-command'); assert.equal((await readSettings(f.target)).apiBaseUrl, 'https://fixture.test/v1');
    assert.equal((await readSettings(f.target)).webEnabled, false); assert.equal((await readSettings(f.target)).boardMcpEnabled, false);
    assert.equal((await readFile(path.join(f.target, 'data.json'), 'utf8')).includes('OBSOLETE-BACKUP-KEY'), false);
    assert.equal(await readFile(path.join(f.target, 'state', 'revocations.json'), 'utf8'), '{"revoked":["client-fixture"]}');
    assert.equal(await readFile(path.join(f.target, 'new-artwork.svg'), 'utf8'), '<svg>new artwork</svg>');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('journal identity is preserved through an old settings rewrite without any credential references', async () => {
  const f = await scenario();
  try {
    await writeSettings(f.target, { surfaceTransactionJournalId: f.journalId, credentialRefs: [], chatEngine: 'opencode' });
    const rolledBack = await rollbackRelease({ backup: f.installed.backup, target: f.target });
    assert.equal(rolledBack.credentialCompatibility.surfaceJournalIdentity, 'preserved');
    const capsule = JSON.parse(await readFile(path.join(f.target, credentialRecoveryFile), 'utf8'));
    assert.equal(capsule.surfaceTransactionJournalId, f.journalId); assert.deepEqual(capsule.credentialRefs, []);
    const rewritten = await readSettings(f.target); delete rewritten.surfaceTransactionJournalId; delete rewritten.credentialRefs;
    await writeSettings(f.target, rewritten);
    const upgraded = await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot });
    assert.equal(upgraded.credentialCompatibility.surfaceJournalIdentity, 'restored');
    assert.equal((await readSettings(f.target)).surfaceTransactionJournalId, f.journalId);
    assert.deepEqual((await readSettings(f.target)).credentialRefs, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a conflicting nonempty journal identity in the historical program stops restoration before mutation', async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    const changed = { ...await readSettings(f.target), surfaceTransactionJournalId: randomUUID() }; await writeSettings(f.target, changed);
    await assert.rejects(installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot }), /journal identities conflict/);
    assert.deepEqual(await readSettings(f.target), changed);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'historical 0.5.3');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
for (const update of ['delete', 'empty', 'replace']) test(`compatible journal identity ${update} is authoritative over an older capsule`, async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot });
    const replacement = update === 'replace' ? randomUUID() : undefined, changed = await readSettings(f.target);
    if (update === 'delete') delete changed.surfaceTransactionJournalId; else changed.surfaceTransactionJournalId = replacement ?? '';
    await writeSettings(f.target, changed);
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    const capsule = JSON.parse(await readFile(path.join(f.target, credentialRecoveryFile), 'utf8'));
    assert.equal(capsule.surfaceTransactionJournalId, replacement);
    const rewritten = await readSettings(f.target); delete rewritten.surfaceTransactionJournalId; await writeSettings(f.target, rewritten);
    await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot });
    assert.equal((await readSettings(f.target)).surfaceTransactionJournalId, replacement);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('restoring protected modes stops when the user changed any forced downgrade value', async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    const changed = { ...await readSettings(f.target), chatEngine: 'opencode' }; await writeSettings(f.target, changed);
    await assert.rejects(installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot }), /configuration changed.*chatEngine/);
    assert.deepEqual(await readSettings(f.target), changed);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'historical 0.5.3');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('journal identity survives legacy settings rewrites even without credential references', async () => {
  const f=await scenario(),journalId=randomUUID();
  try {
    await writeSettings(f.target,{surfaceTransactionJournalId:journalId,credentialRefs:[],chatEngine:'api'});
    await rollbackRelease({backup:f.installed.backup,target:f.target});
    const capsule=JSON.parse(await readFile(path.join(f.target,credentialRecoveryFile),'utf8'));
    assert.equal(capsule.surfaceTransactionJournalId,journalId);assert.deepEqual(capsule.credentialRefs,[]);
    const rewritten=await readSettings(f.target);delete rewritten.surfaceTransactionJournalId;delete rewritten.credentialRefs;await writeSettings(f.target,rewritten);
    const result=await installRelease({source:f.source,target:f.target,backupRoot:f.backupRoot});
    assert.equal(result.credentialCompatibility.surfaceJournalIdentity,'restored');
    assert.equal((await readSettings(f.target)).surfaceTransactionJournalId,journalId);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
test('journal recovery rejects conflicting current identity and never resurrects a cleared compatible identity', async () => {
  const f=await scenario(),journalId=randomUUID();
  try {
    await writeSettings(f.target,{surfaceTransactionJournalId:journalId,credentialRefs:[]});
    await rollbackRelease({backup:f.installed.backup,target:f.target});
    const settings=await readSettings(f.target),changed={...settings,surfaceTransactionJournalId:randomUUID()};await writeSettings(f.target,changed);
    await assert.rejects(installRelease({source:f.source,target:f.target,backupRoot:f.backupRoot}),/journal identities conflict/);
    assert.deepEqual(await readSettings(f.target),changed);
    await writeSettings(f.target,settings);await installRelease({source:f.source,target:f.target,backupRoot:f.backupRoot});
    await writeSettings(f.target,{credentialRefs:[],surfaceTransactionJournalId:''});
    await rollbackRelease({backup:f.installed.backup,target:f.target});
    assert.equal(JSON.parse(await readFile(path.join(f.target,credentialRecoveryFile),'utf8')).surfaceTransactionJournalId,undefined);
    await installRelease({source:f.source,target:f.target,backupRoot:f.backupRoot});
    assert.ok(!(await readSettings(f.target)).surfaceTransactionJournalId);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
test('restoring references refuses newly entered plaintext and leaves both program and settings untouched', async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    await writeSettings(f.target, { apiKey: 'NEW-OLD-PROGRAM-PLAINTEXT-FIXTURE' });
    const before = await readFile(path.join(f.target, 'data.json'));
    await assert.rejects(installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot }), /plaintext.*automatic merge is blocked/);
    assert.equal(await readFile(path.join(f.target, 'main.js'), 'utf8'), 'historical 0.5.3');
    assert.deepEqual(await readFile(path.join(f.target, 'data.json')), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('reference recovery rejects conflicts and unknown program bytes without guessing a backup key', async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    await writeSettings(f.target, { credentialRefs: [reference()] });
    await assert.rejects(installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot }), /references conflict/);
    await writeSettings(f.target, {}); await writeFile(path.join(f.target, 'main.js'), 'manual program replacement');
    await assert.rejects(installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot }), /program identity changed/);
    assert.deepEqual(await readSettings(f.target), {});
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a compatible program clearing refs is authoritative and does not resurrect a previous capsule', async () => {
  const f = await scenario();
  try {
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot });
    await writeSettings(f.target, { credentialRefs: [] });
    await rollbackRelease({ backup: f.installed.backup, target: f.target });
    assert.deepEqual(JSON.parse(await readFile(path.join(f.target, credentialRecoveryFile), 'utf8')).credentialRefs, []);
    await installRelease({ source: f.source, target: f.target, backupRoot: f.backupRoot });
    assert.deepEqual((await readSettings(f.target)).credentialRefs, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('compatibility requires a sealed declaration bound to actual code rather than a version or a copied marker', async () => {
  const root = await temporary();
  try {
    const source = path.join(root, 'source'), current = path.join(root, 'current');
    const legacy = await program(source, 'legacy'); await program(current, 'current');
    assert.equal(await supportsCredentialReferences(source, legacy.files), false);
    await assert.rejects(planCredentialTransition({ current, source, files: legacy.files, requireReferences: true }), /does not support credential references/);
    await writeCredentialCompatibility(source); const sealed = await sealRelease(source);
    assert.equal(await supportsCredentialReferences(source, sealed.files), true);
    await writeFile(path.join(source, 'main.js'), 'other program'); const copied = await sealRelease(source);
    await assert.rejects(supportsCredentialReferences(source, copied.files), /does not match the sealed program/);
    assert.ok(copied.files[credentialCompatibilityFile]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failed health after migration retains refs and isolates the restored legacy program', async () => {
  const root = await temporary();
  try {
    const target = path.join(root, 'plugin'), source = path.join(root, 'new'), backupRoot = path.join(root, 'backups');
    await program(target, 'historical'); await program(source, 'new', true); const refs = [reference()];
    await writeSettings(target, { apiKey: 'BEFORE-MIGRATION-FIXTURE' });
    await assert.rejects(installRelease({ source, target, backupRoot, health: async () => {
      await writeSettings(target, { credentialRefs: refs, webEnabled: true, boardMcpEnabled: true, webBridgeToken: 'OLD-SHARED-FIXTURE' });
      throw new Error('host-health-failed');
    } }), /host-health-failed/);
    assert.equal(await readFile(path.join(target, 'main.js'), 'utf8'), 'historical');
    assert.deepEqual((await readSettings(target)).credentialRefs, refs); assert.equal((await readSettings(target)).webEnabled, false);
    assert.equal((await readSettings(target)).webBridgeToken, ''); assert.equal((await readSettings(target)).apiKey, undefined);
    assert.deepEqual(JSON.parse(await readFile(path.join(target, credentialRecoveryFile), 'utf8')).credentialRefs, refs);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing current and interrupted directories never silently restore the backup data.json', async () => {
  const f = await scenario();
  try {
    await rm(f.target, { recursive: true });
    await assert.rejects(rollbackRelease({ backup: f.installed.backup, target: f.target }), /automatic restoration of backup settings is blocked/);
    await assert.rejects(readFile(path.join(f.target, 'data.json')), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a credential writer lock blocks installation before backup or setting changes', async () => {
  const root = await temporary();
  try {
    const target = path.join(root, 'plugin'), source = path.join(root, 'source'), backupRoot = path.join(root, 'backups');
    await program(target, 'old'); await program(source, 'new', true); await writeSettings(target, {});
    await writeFile(path.join(target, 'data.json.credentials-write.lock'), JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() }));
    await assert.rejects(installRelease({ source, target, backupRoot }), /Credential settings are locked/);
    assert.equal(await readFile(path.join(target, 'main.js'), 'utf8'), 'old');
    await assert.rejects(readdir(backupRoot), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit'); return child.pid;
}
test('known state locks recover without modifying journal bytes, unknown state names are refused',async()=>{
  const root=await temporary();try{
    const state=path.join(root,'state');await mkdir(state);const journal=path.join(state,'surface-transactions-v1.json');await writeFile(journal,'{"synthetic":"retained"}');
    const lock=journal+'.lock';await writeFile(lock,JSON.stringify({version:1,pid:await exitedPid(),nonce:randomUUID()}));
    const diagnosis=await diagnoseTutorLock(lock);assert.equal(diagnosis.kind,'plugin-state');assert.equal(diagnosis.recoverable,true);
    await recoverTutorLock(lock,{expected:diagnosis.fingerprint,confirmStopped:true});assert.equal(await readFile(journal,'utf8'),'{"synthetic":"retained"}');
    const unknown=path.join(state,'unrelated.json.lock');await writeFile(unknown,'{}');await assert.rejects(diagnoseTutorLock(unknown),/Only an exact/);assert.equal(await readFile(unknown,'utf8'),'{}');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('explicit lock recovery requires absent owner, exact fingerprint and stopped-host acknowledgement', async () => {
  const root = await temporary();
  try {
    const lock = path.join(root, 'data.json.credentials-write.lock');
    await writeFile(path.join(root, 'data.json'), '{"kept":true}');
    await writeFile(lock, JSON.stringify({ version: 1, pid: await exitedPid(), nonce: randomUUID() }));
    const diagnosis = await diagnoseTutorLock(lock); assert.equal(diagnosis.recoverable, true);
    await assert.rejects(recoverTutorLock(lock, { expected: diagnosis.fingerprint }), /confirm-stopped/);
    await assert.rejects(recoverTutorLock(lock, { expected: 'a'.repeat(64), confirmStopped: true }), /changed since diagnosis/);
    const recovered = await recoverTutorLock(lock, { expected: diagnosis.fingerprint, confirmStopped: true });
    assert.equal(recovered.recovered, true); await assert.rejects(readFile(lock), { code: 'ENOENT' });
    assert.ok(await readFile(recovered.quarantine)); assert.equal(await readFile(path.join(root, 'data.json'), 'utf8'), '{"kept":true}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('live, changed, malformed and unexpected release locks remain in place', async () => {
  const root = await temporary();
  try {
    const lock = path.join(root, 'install.tutor-release-lock'); await mkdir(lock);
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: randomUUID(), startedAt: 'old' }));
    let diagnosis = await diagnoseTutorLock(lock); assert.equal(diagnosis.recoverable, false);
    await assert.rejects(recoverTutorLock(lock, { expected: diagnosis.fingerprint, confirmStopped: true }), /owner is live or unknown/);
    await writeFile(path.join(lock, 'owner.json'), '{partial'); diagnosis = await diagnoseTutorLock(lock); assert.equal(diagnosis.ownerState, 'unknown');
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: await exitedPid(), nonce: randomUUID() }));
    diagnosis = await diagnoseTutorLock(lock);
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: await exitedPid(), nonce: randomUUID() }));
    await assert.rejects(recoverTutorLock(lock, { expected: diagnosis.fingerprint, confirmStopped: true }), /changed since diagnosis/);
    await writeFile(path.join(lock, 'unexpected.txt'), 'user file'); diagnosis = await diagnoseTutorLock(lock); assert.equal(diagnosis.recoverable, false);
    await assert.rejects(recoverTutorLock(lock, { expected: diagnosis.fingerprint, confirmStopped: true }), /owner is live or unknown/);
    assert.equal(await readFile(path.join(lock, 'unexpected.txt'), 'utf8'), 'user file');
    await rm(path.join(lock, 'unexpected.txt')); diagnosis = await diagnoseTutorLock(lock);
    assert.equal((await recoverTutorLock(lock, { expected: diagnosis.fingerprint, confirmStopped: true })).recovered, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('overlapping explicit recoveries cannot move a replacement lock', async () => {
  const root = await temporary();
  try {
    const lock = path.join(root, 'data.json.credentials-write.lock');
    await writeFile(lock, JSON.stringify({ version: 1, pid: await exitedPid(), nonce: randomUUID() }));
    const diagnosis = await diagnoseTutorLock(lock), options = { expected: diagnosis.fingerprint, confirmStopped: true };
    const outcomes = await Promise.allSettled([recoverTutorLock(lock, options), recoverTutorLock(lock, options)]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal((await readdir(root)).filter(name => name.includes('.recovered-')).length, 1);
    await writeFile(lock, JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() }));
    await assert.rejects(recoverTutorLock(lock, options), /changed since diagnosis/);
    assert.equal((await diagnoseTutorLock(lock)).ownerState, 'running');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('recovery refuses symlink directories and never moves the linked lock', async () => {
  const root = await temporary();
  try {
    const real = path.join(root, 'real'), linked = path.join(root, 'linked'); await mkdir(real);
    await writeFile(path.join(real, 'data.json.credentials-write.lock'), JSON.stringify({ version: 1, pid: await exitedPid(), nonce: randomUUID() }));
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(diagnoseTutorLock(path.join(linked, 'data.json.credentials-write.lock')), /symbolic links/);
    assert.ok(await readFile(path.join(real, 'data.json.credentials-write.lock')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
