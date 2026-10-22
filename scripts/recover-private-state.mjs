import { lstat, readdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecoveryFile, refuseSymlinks } from './release-state.mjs';
import { withReleaseLock } from './release-transaction.mjs';

function lockKind(file) {
  if (path.basename(file) === 'data.json.credentials-write.lock') return 'credential-settings';
  if(path.basename(path.dirname(file))==='state'&&new Set([
    'surface-transactions-v1.json.lock','surface-transactions-v1.json.initialized.lock',
    'clipper-policy-v2.json.lock','clipper-clients-v2.json.lock','clipper-requests-v2.json.lock',
  ]).has(path.basename(file)))return 'plugin-state';
  if(path.basename(file)==='support-write.lock'&&/^[a-f0-9]{32}$/.test(path.basename(path.dirname(file)))&&
    path.basename(path.dirname(path.dirname(file)))==='private-support'&&
    path.basename(path.dirname(path.dirname(path.dirname(file))))==='Tutor')return 'private-support';
  if (file.endsWith('.tutor-release-lock')) return 'release';
  throw new Error('Only an exact Tutor credential-settings, known plugin-state, private-support or release lock can be diagnosed');
}
function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'running'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}
async function snapshot(file) {
  file = path.resolve(file);
  const kind = lockKind(file); await refuseSymlinks(file);
  const stat = await lstat(file);
  if (kind === 'release' ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unexpected lock type; no recovery performed');
  let bytes = Buffer.alloc(0), valid = true;
  if (kind === 'release') {
    const names = await readdir(file);
    if (names.length !== 1 || names[0] !== 'owner.json') valid = false;
  }
  try { bytes = await readRecoveryFile(kind === 'release' ? path.join(file, 'owner.json') : file, 4096); }
  catch (error) { if (error.code === 'ENOENT') valid = false; else throw error; }
  let owner;
  try { owner = JSON.parse(bytes.toString('utf8')); } catch { valid = false; }
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(owner.nonce) ||
      Object.keys(owner).some(key => !['version', 'nonce', 'pid', 'startedAt'].includes(key))) valid = false;
  if (kind !== 'release' && owner?.version !== 1) valid = false;
  const ownerState = valid ? processState(owner.pid) : 'unknown';
  const fingerprint = createHash('sha256').update(`${kind}:${stat.dev}:${stat.ino}:`).update(bytes).digest('hex');
  return { file, kind, ownerPid: valid ? owner.pid : null, ownerState, valid, recoverable: valid && ownerState === 'absent', fingerprint };
}

/** Metadata only: no settings, credential records, process arguments or secrets. */
export async function diagnoseTutorLock(file) {
  const result = await snapshot(file);
  return { ...result, action: result.recoverable
    ? 'Exit all Obsidian windows and Tutor installers/builders, then explicitly recover this exact fingerprint.'
    : 'Keep the lock. A live, unknown or malformed owner is never overridden automatically.' };
}

/** No age threshold or force option. Owner exit, exact identity and an explicit
 * stopped-host acknowledgement are all required. Preserve the lock as evidence. */
export async function recoverTutorLock(file, { expected, confirmStopped = false } = {}) {
  if (!confirmStopped || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Recovery requires --confirm-stopped and the exact --expected fingerprint from diagnosis');
  // Two explicit recoveries must never let the later operation rename a new
  // writer's lock after the first operation releases the abandoned one.
  await refuseSymlinks(file); lockKind(path.resolve(file));
  return withReleaseLock(`${path.resolve(file)}.recovery`, async () => {
  const before = await snapshot(file);
  if (before.fingerprint !== expected) throw new Error('Lock changed since diagnosis; no recovery performed');
  if (!before.recoverable) throw new Error('Lock owner is live or unknown; no recovery performed');
  const check = await snapshot(file);
  if (check.fingerprint !== expected || !check.recoverable) throw new Error('Lock changed before recovery; no recovery performed');
  const quarantine = `${check.file}.recovered-${randomUUID()}`;
  await rename(check.file, quarantine);
  // Nothing under data.json or private-credentials is opened or deleted. A new
  // lock created after this rename belongs to its new owner and is left alone.
  return { recovered: true, kind: check.kind, original: check.file, quarantine, fingerprint: expected,
    next: 'Retry the managed installer or restart the plugin. Retain the quarantined lock until verification succeeds.' };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  try {
    const file = arg('--lock');
    if (!file || !path.isAbsolute(file)) throw new Error('Pass --lock /absolute/path/to/the/exact/Tutor/lock');
    const result = process.argv.includes('--recover')
      ? await recoverTutorLock(file, { expected: arg('--expected'), confirmStopped: process.argv.includes('--confirm-stopped') })
      : await diagnoseTutorLock(file);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
