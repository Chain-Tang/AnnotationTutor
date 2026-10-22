import { cp, mkdir, readFile, readdir, rename, rm, writeFile, chmod, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyCredentialTransition, credentialRecoveryFile, planCredentialTransition } from './release-state.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** A directory lock survives swaps and never guesses that another installer is stale. */
export async function withReleaseLock(target, operation) {
  const lock = `${path.resolve(target)}.tutor-release-lock`, nonce = randomUUID();
  await mkdir(path.dirname(lock), { recursive: true });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Tutor installation is locked; verify the other installer has stopped before recovering its lock'); throw error; }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    return await operation();
  } finally {
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8').catch(() => '{}'));
    if (owner.nonce === nonce) await rm(lock, { recursive: true, force: true });
  }
}

/** Retain data written during health checks, but never copy new program files over old code. */
async function preserveUnownedFiles(from, to, owned) {
  const present = new Set();
  const walk = async (dir, prefix = '') => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${item.name}`;
      if (item.isSymbolicLink()) throw new Error('Cannot safely recover a symbolic link written during installation');
      if (item.isDirectory()) await walk(path.join(dir, item.name), `${rel}/`);
      else if (item.isFile() && rel !== 'release-files.json' && !owned.has(rel)) {
        present.add(rel);
        await mkdir(path.dirname(path.join(to, rel)), { recursive: true });
        await cp(path.join(from, rel), path.join(to, rel));
      }
    }
  };
  await walk(from);
  const removeDeleted = async (dir, prefix = '') => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${item.name}`;
      if(item.isDirectory())await removeDeleted(path.join(dir,item.name),`${rel}/`);
      else if(item.isFile()&&rel!=='release-files.json'&&!owned.has(rel)&&!present.has(rel))await rm(path.join(dir,item.name));
    }
  };
  await removeDeleted(to);
}

/** Fingerprint only program files, so recovery may retain new user assets/settings. */
export async function installedProgramFiles(target) {
  let owned;
  try { owned = Object.keys(JSON.parse(await readFile(path.join(target, 'release-files.json'), 'utf8')).files); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  const all=await releaseFiles(target);
  return Object.fromEntries(Object.entries(all).filter(([rel])=>owned?owned.includes(rel):/^(main\.js|desktop\.js|mobile\.js|styles\.css|manifest\.json|assets\/fonts\/|assets\/web-clipper\/|licenses\/|web-clipper\/)/.test(rel)));
}
export async function installedProgramMatches(target, expected) {
  try {const actual=await installedProgramFiles(target);return Object.keys(actual).length===Object.keys(expected).length && Object.entries(expected).every(([rel,digest])=>actual[rel]===digest);}
  catch{return false;}
}
export async function releaseFiles(directory) {
  const files = {};
  async function walk(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${item.name}`;
      if (item.isSymbolicLink()) throw new Error('Release symlinks are not supported');
      if (item.isDirectory()) await walk(path.join(dir, item.name), `${rel}/`);
      else if (item.isFile() && rel !== 'release-files.json' && rel !== 'data.json') files[rel] = hash(await readFile(path.join(directory, rel)));
    }
  }
  await walk(directory); return files;
}
export async function sealRelease(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const receipt = { format: 1, version: manifest.version, buildId: `${Date.now()}-${randomUUID().slice(0, 8)}`, files: await releaseFiles(directory) };
  await writeFile(path.join(directory, 'release-files.json'), JSON.stringify(receipt, null, 2)); return receipt;
}
export async function verifyRelease(directory) {
  const receipt = JSON.parse(await readFile(path.join(directory, 'release-files.json'), 'utf8'));
  if (receipt.format !== 1 || !receipt.files?.['main.js'] || !receipt.files?.['manifest.json']) throw new Error('Unsealed release');
  for (const [rel, expected] of Object.entries(receipt.files)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(x => x === '..') || rel === 'data.json' || rel === credentialRecoveryFile) throw new Error('Invalid release path');
    if (hash(await readFile(path.join(directory, rel))) !== expected) throw new Error(`Release checksum mismatch: ${rel}`);
  }
  const actual = await releaseFiles(directory);
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(receipt.files).sort())) throw new Error('Unlisted release files');
  return receipt;
}

/** Stop the host before calling. Swap complete directories; preserve unowned files and current settings. */
export async function installRelease(options) {
  return withReleaseLock(options.target, () => installReleaseUnlocked(options));
}
async function installReleaseUnlocked({ source, target, backupRoot, health = async () => {}, injectFailure, forceLocal = false, requireReferences = false, removeOwned = [] }) {
  const release = await verifyRelease(source);
  const credentialPlan = await planCredentialTransition({ current: target, source, files: release.files, forceLocal, requireReferences });
  const id = `${Date.now()}-${randomUUID()}`, backup = path.join(backupRoot, id);
  await mkdir(backup, { recursive: true, mode: 0o700 }); await chmod(backup, 0o700);
  await mkdir(target, { recursive: true });
  await cp(target, path.join(backup, 'before'), { recursive: true });
  const found = await releaseFiles(target);
  let owned;
  try { owned = Object.keys(JSON.parse(await readFile(path.join(target, 'release-files.json'), 'utf8')).files); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const previous = Object.fromEntries(Object.entries(found).filter(([rel]) => owned ? owned.includes(rel) : /^(main\.js|desktop\.js|mobile\.js|styles\.css|manifest\.json|assets\/fonts\/|assets\/web-clipper\/|licenses\/|web-clipper\/)/.test(rel)));
  const stage = `${target}.next-${id}`, old = `${target}.previous-${id}`;
  await cp(target, stage, { recursive: true });
  try {
    for (const rel of [...Object.keys(previous).filter(rel => !release.files[rel]), ...removeOwned]) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel === 'data.json') throw new Error('Invalid removal path');
      await rm(path.join(stage, rel), { force: true });
    }
    for (const rel of [...Object.keys(release.files), 'release-files.json']) {
      await mkdir(path.dirname(path.join(stage, rel)), { recursive: true });
      await cp(path.join(source, rel), path.join(stage, rel));
    }
    if (injectFailure === 'copy') throw new Error('Injected copy failure');
    await applyCredentialTransition(stage, credentialPlan);
    for (const [rel, digest] of Object.entries(release.files)) if (hash(await readFile(path.join(stage, rel))) !== digest) throw new Error('Stage verification failed');
    const transaction = { id, target, release, previous, credentialCompatibility: credentialPlan.report, completed: false, phase: 'prepared' };
    const writeTransaction = () => writeFile(path.join(backup, 'transaction.json'), JSON.stringify(transaction, null, 2), { mode: 0o600 });
    await writeTransaction();
    await rename(target, old);
    if(injectFailure==='interrupted')throw new Error('Injected interruption between directory swaps');
    try { await rename(stage, target); } catch (e) { await rename(old, target); throw e; }
    try {
      transaction.phase = 'applied';
      if (injectFailure === 'journal-applied') throw new Error('Injected applied journal failure');
      await writeTransaction();
      if (injectFailure === 'health') throw new Error('Injected health failure');
      await health({ ...release, credentialCompatibility: credentialPlan.report });
    }
    catch (e) {
      // The new host must be stopped by health() before it reports failure.
      await preserveUnownedFiles(target, old, new Set([...Object.keys(release.files), ...Object.keys(previous)]));
      // A failed new host may already have migrated credentials. Returning to
      // old bytes must observe the same boundary as an explicit rollback.
      const recoveryPlan = await planCredentialTransition({ current: target, source: old, files: previous, forceLocal: true });
      await applyCredentialTransition(old, recoveryPlan);
      await rename(target, stage); await rename(old, target);
      transaction.phase = 'restored-after-health-failure'; await writeTransaction(); throw e;
    }

    transaction.completed = true; transaction.phase = 'healthy';
    try {
      if(injectFailure === 'journal-final')throw new Error('Injected final journal failure');
      await writeTransaction();
    } catch {
      // Health already succeeded. Keep both versions and report the missing
      // recovery confirmation instead of throwing into an unsafe host restart.
      return { id, backup, version: release.version, buildId: release.buildId,
        status: 'health-passed-recovery-journal-pending', retainedPrevious: old, credentialCompatibility: credentialPlan.report };
    }
    await rm(old, { recursive: true, force: true });
    return { id, backup, version: release.version, buildId: release.buildId, credentialCompatibility: credentialPlan.report };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function rollbackRelease(options) {
  return withReleaseLock(options.target, () => rollbackReleaseUnlocked(options));
}
/** Early read-only check before the installer asks Obsidian to stop. */
export async function inspectRollbackCredentials({ backup, target }) {
  const transaction = JSON.parse(await readFile(path.join(backup, 'transaction.json'), 'utf8'));
  if (path.resolve(target) !== path.resolve(transaction.target)) throw new Error('Rollback target mismatch');
  return (await planCredentialTransition({ current: target, source: path.join(backup, 'before'), files: transaction.previous, forceLocal: true })).report;
}
async function rollbackReleaseUnlocked({ backup, target, health = async () => {} }) {
  const transaction = JSON.parse(await readFile(path.join(backup, 'transaction.json'), 'utf8'));
  if (path.resolve(target) !== path.resolve(transaction.target)) throw new Error('Rollback target mismatch');
  // Recover a process interruption between the two renames. Restore the entire
  // previous directory first so configuration and unknown user files survive.
  try { await access(target); } catch(error) {
    if(error.code!=='ENOENT')throw error;
    if(!/^[\w-]+$/.test(transaction.id))throw new Error('Invalid transaction identity');
    if (transaction.phase !== 'prepared' || transaction.completed) throw new Error('Current installation is missing after activation; automatic restoration of backup settings is blocked');
    const old=`${target}.previous-${transaction.id}`;
    try { await access(old); await rename(old,target); }
    catch(oldError){if(oldError.code!=='ENOENT')throw oldError;throw new Error('Current and interrupted previous directories are missing; backup credentials will not be restored automatically');}
  }
  const stage = `${target}.rollback-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  try {
    for (const [rel, digest] of Object.entries(transaction.previous)) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel === 'data.json') throw new Error('Invalid backup path');
      const bytes = await readFile(path.join(backup, 'before', rel));
      if (hash(bytes) !== digest) throw new Error('Backup checksum mismatch');
      await mkdir(path.dirname(path.join(stage, rel)), { recursive: true }); await writeFile(path.join(stage, rel), bytes);
    }
    await rm(path.join(stage, 'release-files.json'), { force: true });
    await sealRelease(stage);
    const result = await installReleaseUnlocked({ source: stage, target, backupRoot: path.dirname(backup), health,
      forceLocal: true,
      removeOwned: Object.keys(transaction.release.files).filter(rel => !transaction.previous[rel]) });
    return result;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
