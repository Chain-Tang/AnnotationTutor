import { createHash } from "node:crypto";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DesktopStateIO, DesktopStateRecord } from "./desktop-state-io.js";
import { privateEncryptionAvailable } from "./desktop-private-storage.js";
import type { SupportCipher } from "./support-private-store.js";
import { communicationIdentitySchema } from "./tutor-communication.js";
import type { TutorCommunicationPeerCredential } from "./tutor-communication-peer.js";

const FORMAT = "tutor-communication-peer-credentials-v1";
const MAX_PEERS = 64, MAX_ENCRYPTED_BYTES = 8192, MAX_STORE_BYTES = 1024 * 1024;
const peerId = z.string().regex(/^[a-f0-9]{24}$/);
const label = z.string().min(1).max(100).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const credentialSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), clientId: z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)).optional(), hostIdentity: communicationIdentitySchema }).strict();
const entrySchema = z.object({ instanceId: peerId, name: label, encrypted: z.string().min(4).max(Math.ceil(MAX_ENCRYPTED_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const stateSchema = z.object({ format: z.literal(FORMAT), vaultBinding: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), entries: z.array(entrySchema).max(MAX_PEERS) }).strict().refine(value => new Set(value.entries.map(entry => entry.instanceId)).size === value.entries.length);
type PeerState = z.infer<typeof stateSchema>;
const queues = new Map<string, Promise<unknown>>();

/** Missing an already-observed file cannot turn a prior registry into an empty one. */
class PeerStateIO extends DesktopStateIO {
  private observed = false;
  override async read(name: string): Promise<string | null> {
    const value = await super.read(name);
    if (value === null && this.observed) throw new Error("communication-peer-credentials-missing");
    if (value !== null) this.observed = true;
    return value;
  }
  override async compareWrite(name: string, previous: string | null, next: string): Promise<void> {
    await super.compareWrite(name, previous, next);
    this.observed = true;
  }
}

/** Encrypted pairing registry outside the vault. The host injects Electron safeStorage;
 * lack of secure encryption, corruption and CAS conflicts never fall back to plaintext or reset. */
export class PrivateTutorCommunicationPeers {
  private readonly directory?: string;
  private readonly vaultBinding: string;
  private readonly record?: DesktopStateRecord<PeerState>;
  private readonly cipher?: SupportCipher;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: { appData: string | undefined; vaultPath: string; cipher: SupportCipher | undefined }) {
    this.cipher = options.cipher;
    this.vaultBinding = createHash("sha256").update(resolve(options.vaultPath)).digest("hex");
    const { appData, vaultPath } = options;
    if (!appData || !isAbsolute(appData) || !isAbsolute(vaultPath) || appData.includes("\0") || vaultPath.includes("\0") || resolve(appData) === parsePath(resolve(appData)).root) return;
    const directory = join(resolve(appData), "Tutor", "private-communication-peers", this.vaultBinding.slice(0, 32));
    const fromVault = relative(resolve(vaultPath), directory);
    if (!fromVault || !(fromVault === ".." || fromVault.startsWith(`..${sep}`) || isAbsolute(fromVault))) return;
    this.directory = directory;
    this.record = new DesktopStateRecord(new PeerStateIO(directory, MAX_STORE_BYTES), "peers.json", value => {
      const state = stateSchema.parse(value);
      if (state.vaultBinding !== this.vaultBinding) throw new Error("communication-peer-credentials-binding");
      return state;
    }, () => ({ format: FORMAT, vaultBinding: this.vaultBinding, revision: 0, entries: [] }));
  }

  available(): boolean {
    if (!this.record || !privateEncryptionAvailable(this.cipher)) return false;
    try { return !["basic_text", "plaintext", "plain_text"].includes(this.cipher?.getSelectedStorageBackend?.() ?? ""); } catch { return false; }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (!this.available()) return Promise.reject(new Error("communication-peer-credentials-unavailable"));
    const key = this.directory!;
    const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(key, task); this.tail = task;
    const release = () => { if (queues.get(key) === task) queues.delete(key); };
    void task.then(release, release);
    return task;
  }

  private decode(entry: PeerState["entries"][number]): TutorCommunicationPeerCredential {
    if (!this.available()) throw new Error("communication-peer-credentials-unavailable");
    try {
      const encrypted = Buffer.from(entry.encrypted, "base64");
      if (!encrypted.length || encrypted.length > MAX_ENCRYPTED_BYTES || encrypted.toString("base64") !== entry.encrypted) throw new Error();
      const text = this.cipher!.decryptString(encrypted);
      if (Buffer.byteLength(text) > MAX_ENCRYPTED_BYTES) throw new Error();
      const payload = z.object({ format: z.literal(FORMAT), vaultBinding: z.literal(this.vaultBinding), instanceId: z.literal(entry.instanceId), credential: credentialSchema }).strict().parse(JSON.parse(text));
      return payload.credential;
    } catch { throw new Error("communication-peer-credentials-unreadable"); }
  }

  private async load(): Promise<{ state: PeerState; credentials: Map<string, TutorCommunicationPeerCredential> }> {
    if (!this.available()) throw new Error("communication-peer-credentials-unavailable");
    const state = await this.record!.load();
    const credentials = new Map(state.entries.map(entry => [entry.instanceId, this.decode(entry)]));
    return { state, credentials };
  }

  list(): Promise<{ instanceId: string; name: string }[]> {
    return this.enqueue(async () => (await this.load()).state.entries.map(({ instanceId, name }) => ({ instanceId, name })));
  }

  read(instanceId: string): Promise<TutorCommunicationPeerCredential | undefined> {
    return this.enqueue(async () => { peerId.parse(instanceId); const value = (await this.load()).credentials.get(instanceId); return value ? structuredClone(value) : undefined; });
  }

  write(instanceId: string, credential: TutorCommunicationPeerCredential, name?: string): Promise<void> {
    return this.enqueue(async () => {
      let checked: z.infer<typeof credentialSchema>;
      try { peerId.parse(instanceId); checked = credentialSchema.parse(credential); if (name !== undefined) label.parse(name); }
      catch { throw new Error("communication-peer-credentials-invalid"); }
      const { state } = await this.load();
      const existing = state.entries.find(entry => entry.instanceId === instanceId);
      if (!existing && state.entries.length >= MAX_PEERS) throw new Error("communication-peer-credentials-limit");
      const plaintext = JSON.stringify({ format: FORMAT, vaultBinding: this.vaultBinding, instanceId, credential: checked });
      let encrypted: Buffer;
      if (!this.available()) throw new Error("communication-peer-credentials-unavailable");
      try {
        encrypted = this.cipher!.encryptString(plaintext);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_ENCRYPTED_BYTES || encrypted.includes(Buffer.from(checked.token)) || encrypted.equals(Buffer.from(plaintext)) || this.cipher!.decryptString(encrypted) !== plaintext) throw new Error();
      } catch { throw new Error("communication-peer-credentials-encryption-failed"); }
      const next = { instanceId, name: name ?? existing?.name ?? instanceId, encrypted: encrypted.toString("base64") };
      if (existing) state.entries.splice(state.entries.indexOf(existing), 1, next); else state.entries.push(next);
      state.entries.sort((a, b) => a.instanceId.localeCompare(b.instanceId)); state.revision++;
      await this.record!.save(state);
    });
  }

  revoke(instanceId: string): Promise<void> {
    return this.enqueue(async () => {
      peerId.parse(instanceId);
      const { state } = await this.load(), index = state.entries.findIndex(entry => entry.instanceId === instanceId);
      if (index < 0) return;
      state.entries.splice(index, 1); state.revision++;
      await this.record!.save(state);
    });
  }

  async flush(): Promise<void> { await this.tail; await this.record?.flush(); }
}
