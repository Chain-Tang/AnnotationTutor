import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateTutorCommunicationPeers } from "../src/tutor-communication-credentials.js";
import type { TutorCommunicationPeerCredential } from "../src/tutor-communication-peer.js";
import type { SupportCipher } from "../src/support-private-store.js";

const idA = "a".repeat(24), idB = "b".repeat(24);
const credential: TutorCommunicationPeerCredential = { token: "1".repeat(64), clientId: "paired-client", hostIdentity: { agentId: "host-alpha", vaultId: "alpha", kind: "tutor" } };
const cipher: SupportCipher = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(Buffer.from(text).map(byte => byte ^ 173)), decryptString: bytes => Buffer.from(bytes.map(byte => byte ^ 173)).toString("utf8") };
async function fixture(run: (options: { root: string; appData: string; vaultPath: string; store: PrivateTutorCommunicationPeers }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tutor-peer-credentials-")));
  const appData = join(root, "app-data"), vaultPath = join(root, "vault");
  await mkdir(vaultPath);
  try { await run({ root, appData, vaultPath, store: new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher }) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function fileUnder(root: string): Promise<string> {
  const files = await readdir(root, { recursive: true });
  return join(root, files.find(file => file.endsWith("peers.json"))!);
}

describe("encrypted private Tutor peer credentials", () => {
  it("persists only bounded encrypted values and routing metadata outside the vault, and can restart/revoke", async () => fixture(async ({ appData, vaultPath, store }) => {
    expect(await store.list()).toEqual([]);
    await store.write(idA, credential, "Alpha"); await store.flush();
    expect(await store.list()).toEqual([{ instanceId: idA, name: "Alpha" }]);
    expect(await store.read(idA)).toEqual(credential);
    const file = await fileUnder(appData), raw = await readFile(file, "utf8");
    expect(file).toContain("Tutor/private-communication-peers/");
    expect(raw).not.toContain(credential.token); expect(raw).not.toContain("host-alpha");
    expect(JSON.parse(raw).entries[0]).toEqual({ instanceId: idA, name: "Alpha", encrypted: expect.any(String) });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(vaultPath)).toEqual([]);
    const restarted = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher });
    expect(await restarted.read(idA)).toEqual(credential);
    await restarted.write(idA, { ...credential, token: "2".repeat(64) });
    expect(await restarted.list()).toEqual([{ instanceId: idA, name: "Alpha" }]);
    await restarted.revoke(idA); await restarted.flush();
    expect(await restarted.read(idA)).toBeUndefined(); expect(await restarted.list()).toEqual([]);
  }));

  it("refuses unavailable/basic_text/plaintext encryption and unsafe roots without writing a fallback", async () => fixture(async ({ root, appData, vaultPath }) => {
    const options = [
      { appData, vaultPath, cipher: undefined }, { appData, vaultPath, cipher: { ...cipher, isEncryptionAvailable: () => false } },
      { appData, vaultPath, cipher: { ...cipher, getSelectedStorageBackend: () => "basic_text" } },
      { appData, vaultPath, cipher: { ...cipher, getSelectedStorageBackend: () => "plaintext" } },
      { appData: vaultPath, vaultPath, cipher }, { appData: "relative/path", vaultPath, cipher }, { appData: "/", vaultPath, cipher },
    ];
    for (const option of options) {
      const store = new PrivateTutorCommunicationPeers(option);
      expect(store.available()).toBe(false); await expect(store.write(idA, credential)).rejects.toThrow("communication-peer-credentials-unavailable");
      await expect(store.list()).rejects.toThrow("communication-peer-credentials-unavailable");
    }
    const plaintext = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher: { ...cipher, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() } });
    await expect(plaintext.write(idA, credential)).rejects.toThrow("communication-peer-credentials-encryption-failed");
    expect(await readdir(root)).toEqual(["vault"]);
  }));

  it("keeps corrupt JSON untouched and never reinitializes it through read, write or revoke", async () => fixture(async ({ appData, store }) => {
    await store.write(idA, credential);
    const file = await fileUnder(appData); await writeFile(file, "{corrupt-existing-state");
    await expect(store.list()).rejects.toThrow("state-record-invalid");
    await expect(store.write(idB, credential)).rejects.toThrow("state-record-invalid");
    await expect(store.revoke(idA)).rejects.toThrow("state-record-invalid");
    expect(await readFile(file, "utf8")).toBe("{corrupt-existing-state");
  }));

  it("fails closed on decryption/binding errors and does not replace the existing registry", async () => fixture(async ({ appData, vaultPath, store }) => {
    await store.write(idA, credential);
    const file = await fileUnder(appData), original = await readFile(file, "utf8");
    const broken = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher: { ...cipher, decryptString: () => { throw Error("SECRET-CIPHER-DETAIL"); } } });
    await expect(broken.read(idA)).rejects.toThrow(/^communication-peer-credentials-unreadable$/);
    await expect(broken.write(idB, credential)).rejects.toThrow(/^communication-peer-credentials-unreadable$/);
    expect(await readFile(file, "utf8")).toBe(original);
    const tampered = JSON.parse(original); tampered.entries[0].instanceId = idB;
    const bytes = JSON.stringify(tampered); await writeFile(file, bytes);
    await expect(store.read(idB)).rejects.toThrow("communication-peer-credentials-unreadable");
    await expect(store.revoke(idB)).rejects.toThrow("communication-peer-credentials-unreadable");
    expect(await readFile(file, "utf8")).toBe(bytes);
  }));

  it("serializes distinct store objects for the same vault and merges their separately queued changes", async () => fixture(async ({ appData, vaultPath, store }) => {
    const second = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher });
    await Promise.all([store.write(idA, credential, "Alpha"), second.write(idB, { ...credential, token: "2".repeat(64) }, "Beta")]);
    expect(await store.list()).toEqual([{ instanceId: idA, name: "Alpha" }, { instanceId: idB, name: "Beta" }]);
    await Promise.all([store.revoke(idA), second.write(idB, { ...credential, token: "3".repeat(64) }, "Beta revised")]);
    expect(await second.list()).toEqual([{ instanceId: idB, name: "Beta revised" }]);
    expect((await store.read(idB))?.token).toBe("3".repeat(64));
  }));

  it("rejects an external CAS change and preserves the competing committed content", async () => fixture(async ({ appData, vaultPath, store }) => {
    await store.write(idA, credential, "Original");
    const file = await fileUnder(appData), initial = JSON.parse(await readFile(file, "utf8"));
    const external = JSON.stringify({ ...initial, revision: initial.revision + 1, entries: [{ ...initial.entries[0], name: "External" }] });
    let replace = true;
    const competing = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher: { ...cipher, encryptString: text => {
      if (replace) { replace = false; writeFileSync(file, external); }
      return cipher.encryptString(text);
    } } });
    await expect(competing.write(idB, credential)).rejects.toThrow("state-file-conflict");
    expect(await readFile(file, "utf8")).toBe(external);
    expect(await store.list()).toEqual([{ instanceId: idA, name: "External" }]);
    expect((await readdir(join(file, ".."))).some(file => file.endsWith(".tmp") || file.endsWith(".lock"))).toBe(false);
  }));

  it("refuses missing-after-load, excessive cipher output and invalid credentials", async () => fixture(async ({ appData, vaultPath, store }) => {
    const invalid = { ...credential, token: "BAD-SECRET-TOKEN" };
    await expect(store.write(idA, invalid)).rejects.toThrow(/^communication-peer-credentials-invalid$/);
    const huge = new PrivateTutorCommunicationPeers({ appData, vaultPath, cipher: { ...cipher, encryptString: () => Buffer.alloc(9000) } });
    await expect(huge.write(idA, credential)).rejects.toThrow("communication-peer-credentials-encryption-failed");
    await store.write(idA, credential); const file = await fileUnder(appData); await rm(file);
    await expect(store.write(idB, credential)).rejects.toThrow("communication-peer-credentials-missing");
    await expect(store.list()).rejects.toThrow("communication-peer-credentials-missing");
    expect((await readdir(join(file, ".."))).includes("peers.json")).toBe(false);
  }));

  it("rejects symbolic-link directories instead of moving private state into an untrusted location", async () => fixture(async ({ root, vaultPath }) => {
    const actual = join(root, "actual"), linked = join(root, "linked"); await mkdir(actual); await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    const store = new PrivateTutorCommunicationPeers({ appData: linked, vaultPath, cipher });
    await expect(store.write(idA, credential)).rejects.toThrow("state-path-denied");
    expect(await readdir(actual)).toEqual([]);
  }));
});
