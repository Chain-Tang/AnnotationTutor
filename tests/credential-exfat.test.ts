import {afterEach, expect, it, vi} from "vitest";
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AtomicCredentialSettingsFile} from "../src/credential-store.js";

const simulated = vi.hoisted(() => ({replaceOwnedLock: false}));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith(".credentials-write.lock") && args[1] === "wx") {
      let materialized = false;
      const stat = handle.stat.bind(handle), write = handle.writeFile.bind(handle);
      handle.stat = (async (...options: Parameters<typeof handle.stat>) => {
        const actual = await stat(...options);
        return materialized ? actual : Object.assign(actual, {ino: Number.MAX_SAFE_INTEGER});
      }) as typeof handle.stat;
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
        const result = await write(...values);
        materialized = true;
        if (simulated.replaceOwnedLock) {
          await fs.unlink(String(args[0]));
          await fs.writeFile(String(args[0]), '{"pid":123,"nonce":"another-owner"}');
        }
        return result;
      };
    }
    return handle;
  }};
});
afterEach(() => {simulated.replaceOwnedLock = false;});

async function fixture(run: (root: string, writer: AtomicCredentialSettingsFile) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tutor-exfat-settings-")));
  try {
    const file = join(root, "data.json");
    await writeFile(file, "{}");
    const writer = new AtomicCredentialSettingsFile(file);
    await writer.read();
    await run(root, writer);
  } finally {await rm(root, {recursive: true, force: true});}
}

it("releases its lock after a filesystem replaces a provisional inode, allowing consecutive saves", () => fixture(async (root, writer) => {
  await writer.write({agentModel: "first"});
  expect(await readdir(root)).toEqual(["data.json"]);
  await writer.write({agentModel: "second"});
  expect(JSON.parse(await readFile(join(root, "data.json"), "utf8"))).toEqual({agentModel: "second"});
  expect(await readdir(root)).toEqual(["data.json"]);
}));

it("does not remove a replacement lock belonging to another writer", () => fixture(async (root, writer) => {
  simulated.replaceOwnedLock = true;
  await writer.write({kept: true});
  const lock = join(root, "data.json.credentials-write.lock");
  expect(await readFile(lock, "utf8")).toBe('{"pid":123,"nonce":"another-owner"}');
  await expect(writer.write({kept: false})).rejects.toThrow("credential-settings-locked");
  expect(JSON.parse(await readFile(join(root, "data.json"), "utf8"))).toEqual({kept: true});
}));
