import { constants } from 'node:fs';
import { lstat, open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const credentialCompatibilityFile = 'credential-compatibility.json';
export const credentialRecoveryFile = 'state/credential-reference-recovery-v1.json';
const secretSlots = ['apiKey', 'boardImageApiKey', 'tutorRemoteToken', 'mcpServersJson'];
const programNames = ['main.js', 'desktop.js', 'mobile.js'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const localOnlySettings = {
  learningFlowEnabled: false, supportCheckinEnabled: false, learningExpertsEnabled: false,
  webEnabled: false, webOfficialIntegrationEnabled: false, boardMcpEnabled: false,
  webBridgeToken: '', androidInkToken: '',
};
/** Only enums and booleans may enter the recovery snapshot. Models, endpoints,
 * commands, shell paths and credentials remain outside this record. */
export const downgradeSettings = {
  chatEngine: 'api', boardEngine: 'api', reviewEngine: 'api', webEngine: 'api',
  boardImageProvider: 'disabled', boardImageUseSharedApiKey: false, boardCloudRecognitionConsent: false,
  autoRunAgent: false, pretranslateOnOpen: false, webAutoAnalyze: false,
  learningFlowEnabled: false, supportCheckinEnabled: false, learningExpertsEnabled: false,
  enableWeaknessTraining: false, enableLearningSummary: false, enableStrengthReinforcement: false,
};
function validProtectedValue(key, value) {
  return value === null || (key === 'boardImageProvider' ? ['disabled', 'qwen-compatible', 'openai'].includes(value)
    : key.endsWith('Engine') ? ['api', 'opencode'].includes(value) : typeof value === 'boolean');
}
function configurationSnapshot(config) {
  const snapshot = {};
  for (const key of Object.keys(downgradeSettings)) {
    const value = Object.hasOwn(config, key) ? config[key] : null;
    if (!validProtectedValue(key, value)) throw new Error(`Invalid protected configuration: ${key}`);
    snapshot[key] = value;
  }
  return snapshot;
}
function validateSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(downgradeSettings).length &&
    Object.entries(value).every(([key, entry]) => Object.hasOwn(downgradeSettings, key) && validProtectedValue(key, entry));
}

export async function refuseSymlinks(file) {
  let current = path.resolve(file);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Recovery refuses symbolic links'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (current === parent) break; current = parent;
  }
}
export async function readRecoveryFile(file, maximum = 16 * 1024 * 1024) {
  await refuseSymlinks(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid recovery file');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function readObject(file) {
  let bytes;
  try { bytes = await readRecoveryFile(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Recovery configuration is invalid; original file retained'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery configuration is invalid; original file retained');
  return value;
}
async function programIdentity(directory) {
  const files = {};
  for (const name of programNames) {
    try { files[name] = digest(await readRecoveryFile(path.join(directory, name), 64 * 1024 * 1024)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}
function validProgram(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && /^[a-f0-9]{64}$/.test(value['main.js']) &&
    Object.entries(value).every(([name, hash]) => programNames.includes(name) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}
function referenceList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid credential references; recovery stopped');
  const seen = new Set();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || ref.version !== 1 || !secretSlots.includes(ref.slot) ||
      typeof ref.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ref.id) ||
      typeof ref.binding !== 'string' || !/^[a-f0-9]{64}$/.test(ref.binding) || Object.keys(ref).some(key => !['version', 'id', 'slot', 'binding'].includes(key)))
      throw new Error('Invalid credential references; recovery stopped');
    const key = `${ref.slot}:${ref.binding}`;
    if (seen.has(key)) throw new Error('Conflicting credential references; recovery stopped');
    seen.add(key); return { version: 1, id: ref.id, slot: ref.slot, binding: ref.binding };
  });
}
const sortedReferences = refs => [...refs].sort((a, b) => `${a.slot}:${a.binding}`.localeCompare(`${b.slot}:${b.binding}`));
function matchingReferences(a, b) { return same(sortedReferences(a), sortedReferences(b)); }
function journalIdentity(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw new Error('Invalid surface journal identity; automatic recovery stopped');
  return value;
}

/** Generated only by the current build, tied to program bytes; versions alone
 * cannot distinguish historical 0.5.3 from a credential-aware 0.5.3 candidate. */
export async function writeCredentialCompatibility(directory) {
  const programFiles = await programIdentity(directory);
  if (!validProgram(programFiles)) throw new Error('Cannot describe a missing program');
  await writeFile(path.join(directory, credentialCompatibilityFile), JSON.stringify({
    format: 1, credentialReferences: 1, plaintextFallback: false, externalAuthorization: 1, programFiles,
  }, null, 2));
}
export async function supportsCredentialReferences(directory, files) {
  if (!files?.[credentialCompatibilityFile]) return false;
  const bytes = await readRecoveryFile(path.join(directory, credentialCompatibilityFile), 16384);
  if (digest(bytes) !== files[credentialCompatibilityFile]) throw new Error('Credential compatibility checksum mismatch');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid credential compatibility declaration'); }
  if (value.format !== 1 || value.credentialReferences !== 1 || value.plaintextFallback !== false || value.externalAuthorization !== 1 || !validProgram(value.programFiles))
    throw new Error('Unsupported credential compatibility declaration');
  const actual = await programIdentity(directory);
  if (!same(actual, value.programFiles) || Object.entries(actual).some(([name, hash]) => files[name] !== hash))
    throw new Error('Credential compatibility does not match the sealed program');
  return true;
}
async function installedSupportsReferences(directory) {
  const receipt = await readObject(path.join(directory, 'release-files.json'));
  return supportsCredentialReferences(directory, receipt?.files);
}
async function readCapsule(directory) {
  const value = await readObject(path.join(directory, credentialRecoveryFile));
  if (!value) return undefined;
  if (value.format !== 1 || !validProgram(value.legacyProgram) || typeof value.createdAt !== 'string' ||
    Object.keys(value).some(key => !['format', 'legacyProgram', 'createdAt', 'credentialRefs', 'configuration', 'surfaceTransactionJournalId'].includes(key)) ||
    value.configuration !== undefined && !validateSnapshot(value.configuration))
    throw new Error('Invalid credential recovery record; original file retained');
  return { ...value, credentialRefs: referenceList(value.credentialRefs), surfaceTransactionJournalId: journalIdentity(value.surfaceTransactionJournalId) };
}

/** Read-only preflight, repeated under the release lock before any swap. Never
 * opens the system credential store or reads an installation backup's secrets. */
export async function planCredentialTransition({ current, source, files, forceLocal = false, requireReferences = false }) {
  await refuseSymlinks(path.join(current, 'data.json'));
  try { await lstat(path.join(current, 'data.json.credentials-write.lock')); throw new Error('Credential settings are locked; use the explicit lock diagnosis/recovery command'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const compatible = await supportsCredentialReferences(source, files);
  if (requireReferences && !compatible) throw new Error('Selected program does not support credential references; choose a verified compatible release');
  const config = await readObject(path.join(current, 'data.json')) ?? {};
  let refs = referenceList(config.credentialRefs);
  let surfaceTransactionJournalId = journalIdentity(config.surfaceTransactionJournalId);
  const capsule = await readCapsule(current), currentProgram = await programIdentity(current);
  const fromCompatible = await installedSupportsReferences(current);
  let recovered = false;
  let journalRecovered = false;
  if (capsule && !fromCompatible) {
    if (!same(currentProgram, capsule.legacyProgram)) throw new Error('Credential recovery program identity changed; explicit review is required');
    if (refs.length && !matchingReferences(refs, capsule.credentialRefs)) throw new Error('Current and preserved credential references conflict; automatic recovery stopped');
    if (surfaceTransactionJournalId && capsule.surfaceTransactionJournalId && surfaceTransactionJournalId !== capsule.surfaceTransactionJournalId)
      throw new Error('Current and preserved surface journal identities conflict; automatic recovery stopped');
    if (!surfaceTransactionJournalId && capsule.surfaceTransactionJournalId) { surfaceTransactionJournalId = capsule.surfaceTransactionJournalId; journalRecovered = true; }
    refs = capsule.credentialRefs; recovered = true;
  }
  const hasPlaintext = secretSlots.some(slot => typeof config[slot] === 'string' && config[slot].trim());
  const protectedState = refs.length > 0 || !!capsule || !!surfaceTransactionJournalId;
  if ((refs.length || surfaceTransactionJournalId || capsule && !fromCompatible) && hasPlaintext)
    throw new Error('Credential references conflict with plaintext entered in the old program; automatic merge is blocked. Use the private storage recovery guide');
  const localOnly = !compatible && (forceLocal || protectedState);
  const next = { ...config, ...(localOnly || forceLocal ? localOnlySettings : {}), ...(protectedState ? { credentialRefs: refs } : {}),
    ...(surfaceTransactionJournalId ? { surfaceTransactionJournalId } : {}) };
  if (protectedState) for (const slot of secretSlots) delete next[slot];
  if (compatible && recovered && capsule.configuration) {
    const conflicts = Object.keys(downgradeSettings).filter(key => config[key] !== downgradeSettings[key]);
    if (conflicts.length) throw new Error(`Protected downgrade configuration changed; automatic restoration stopped: ${conflicts.join(', ')}`);
    for (const [key, before] of Object.entries(capsule.configuration)) {
      if (before === null) delete next[key]; else next[key] = before;
    }
  }
  const configuration = !compatible && protectedState
    ? capsule && !fromCompatible ? capsule.configuration ?? configurationSnapshot(config) : configurationSnapshot(config)
    : undefined;
  if (!compatible && protectedState) Object.assign(next, downgradeSettings);
  const preserve = !compatible && protectedState ? {
    format: 1, createdAt: new Date().toISOString(), legacyProgram: await programIdentity(source), credentialRefs: refs, configuration,
    ...(surfaceTransactionJournalId ? { surfaceTransactionJournalId } : {}),
  } : undefined;
  return { settings: next, capsule: preserve, report: {
    mode: compatible ? 'credential-references' : protectedState ? 'legacy-local-only' : 'legacy-unmigrated',
    referenceCount: refs.length, referenceRecovery: recovered && compatible ? 'restored' : preserve ? 'preserved' : 'not-needed',
    surfaceJournalIdentity: journalRecovered && compatible ? 'restored' : preserve?.surfaceTransactionJournalId ? 'preserved' : 'unchanged',
    externalServices: localOnly || forceLocal ? 'disabled' : 'unchanged',
    protectedConfiguration: !compatible && !!preserve ? 'isolated' : recovered && capsule?.configuration ? 'restored-if-unchanged' : 'unchanged',
    ...(preserve ? { limitations: ['managed-configuration-protection-only', 'legacy-manual-expert-command-has-no-global-disable-switch', 'not-a-network-sandbox'] } : {}),
    notice: compatible ? 'Credentials remain references; resolution requires the original host secure store.' : protectedState
      ? 'This historical program cannot use credential references. Local features remain available. Do not enter secrets in its settings; install a verified credential-compatible release to reconnect.'
      : 'Existing unmigrated configuration is retained. No backup credentials were restored.',
  } };
}

/** Stage is not running. The containing release transaction performs its swap. */
export async function applyCredentialTransition(stage, plan) {
  const file = path.join(stage, 'data.json'); await refuseSymlinks(file);
  await writeFile(file, JSON.stringify(plan.settings, null, 2), { mode: 0o600 });
  if (plan.capsule) {
    const file = path.join(stage, credentialRecoveryFile);
    await refuseSymlinks(file); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(plan.capsule, null, 2), { mode: 0o600 });
  }
}
