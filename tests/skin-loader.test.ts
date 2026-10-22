// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

vi.mock("obsidian", () => ({
  FileSystemAdapter: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

const { SkinLoader } = await import("../src/skin-loader.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial)), folders = new Set(["plugin/skins"]);
  const adapter = {
    exists: vi.fn(async (path: string) => folders.has(path) || files.has(path)),
    list: vi.fn(async () => ({ files: [...files.keys()], folders: [] as string[] })),
    read: vi.fn(async (path: string) => { const css = files.get(path); if (css === undefined) throw new Error("missing"); return css; }),
    write: vi.fn(async (path: string, css: string) => { files.set(path, css); }),
    mkdir: vi.fn(async (path: string) => { folders.add(path); }),
  };
  const loader = new SkinLoader({ vault: { adapter } } as unknown as App, "plugin");
  return { loader, adapter, files, folders };
}

afterEach(() => { document.head.querySelectorAll("#atl-skin-custom").forEach(el => el.remove()); });

describe("custom skin loading", () => {
  it("makes built-in skins usable without filesystem IO", () => {
    const { loader, adapter } = fixture();
    loader.applyCss({ id: "paper", name: "Paper", builtin: true, quiet: true });
    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.list).not.toHaveBeenCalled();
    expect(document.head.querySelector("#atl-skin-custom")).toBeNull();
  });

  it("shares an in-flight scan and permits a later reload after files change", async () => {
    const r = fixture({ "plugin/skins/autumn.css": "/* @name Autumn */.atl-skin-autumn{}" });
    const gate = deferred<string>();
    r.adapter.read.mockImplementationOnce(() => gate.promise);
    const first = r.loader.loadCustomSkins(), second = r.loader.loadCustomSkins();
    expect(second).toBe(first);
    gate.resolve("/* @name Autumn */.atl-skin-autumn{}");
    await expect(first).resolves.toMatchObject([{ id: "autumn", name: "Autumn" }]);
    expect(r.adapter.list).toHaveBeenCalledOnce();
    r.files.set("plugin/skins/spring.css", "/* @name Spring */.atl-skin-spring{}");
    await expect(r.loader.loadCustomSkins()).resolves.toHaveLength(2);
    expect(r.adapter.list).toHaveBeenCalledTimes(2);
  });

  it("retries after a scan failure and skips unreadable individual CSS files", async () => {
    const r = fixture({ "plugin/skins/a.css": ".a{}", "plugin/skins/b.css": ".b{}", "plugin/skins/readme.md": "text" });
    const error = new Error("storage-unavailable");
    r.adapter.exists.mockRejectedValueOnce(error);
    await expect(r.loader.loadCustomSkins()).rejects.toBe(error);
    r.adapter.read.mockRejectedValueOnce(error);
    await expect(r.loader.loadCustomSkins()).resolves.toMatchObject([{ id: "b" }]);
  });

  it("propagates directory read failures instead of treating them as no skins", async () => {
    const r = fixture({ "plugin/skins/autumn.css": ".a{}" }), error = new Error("directory-read-unavailable");
    r.adapter.list.mockRejectedValueOnce(error);
    await expect(r.loader.loadCustomSkins()).rejects.toBe(error);
    await expect(r.loader.loadCustomSkins()).resolves.toMatchObject([{ id: "autumn" }]);
  });

  it("serializes concurrent template creation so files cannot overwrite one another", async () => {
    const r = fixture();
    r.folders.clear();
    const ids = await Promise.all([r.loader.createFromTemplate(), r.loader.createFromTemplate()]);
    expect(ids).toEqual(["my-skin", "my-skin-2"]);
    expect(r.adapter.mkdir).toHaveBeenCalledOnce();
    expect(r.files.get("plugin/skins/my-skin.css")).toContain(".atl-skin-my-skin {");
    expect(r.files.get("plugin/skins/my-skin-2.css")).toContain(".atl-skin-my-skin-2 {");
  });

  it("refreshes an older pending scan when creation changes the registry", async () => {
    const r = fixture({ "plugin/skins/autumn.css": ".atl-skin-autumn{}" });
    const gate = deferred<string>();
    r.adapter.read.mockImplementationOnce(() => gate.promise);
    const scanning = r.loader.loadCustomSkins();
    await vi.waitFor(() => expect(r.adapter.read).toHaveBeenCalledOnce());
    const creating = r.loader.createFromTemplate();
    const reloading = r.loader.loadCustomSkins();
    gate.resolve(".atl-skin-autumn{}");
    await expect(creating).resolves.toBe("my-skin");
    expect((await scanning).map(skin => skin.id)).toContain("my-skin");
    expect((await reloading).map(skin => skin.id)).toContain("my-skin");
    expect(r.adapter.list).toHaveBeenCalledTimes(2);
  });

  it("makes a reload requested during creation wait for the completed write", async () => {
    const r = fixture();
    const gate = deferred<void>();
    r.adapter.write.mockImplementationOnce(async (path, css) => { await gate.promise; r.files.set(path, css); });
    const creating = r.loader.createFromTemplate();
    await vi.waitFor(() => expect(r.adapter.write).toHaveBeenCalledOnce());
    const scanning = r.loader.loadCustomSkins();
    expect(r.adapter.list).not.toHaveBeenCalled();
    gate.resolve();
    await creating;
    await expect(scanning).resolves.toMatchObject([{ id: "my-skin" }]);
  });

  it("drops a late scan and refuses CSS injection after unloading", async () => {
    const r = fixture({ "plugin/skins/autumn.css": ".atl-skin-autumn{}" });
    const skin = { id: "autumn", name: "Autumn", builtin: false, quiet: true, css: ".atl-skin-autumn{}" };
    r.loader.applyCss(skin);
    expect(document.head.querySelector("#atl-skin-custom")).not.toBeNull();
    const gate = deferred<string>();
    r.adapter.read.mockImplementationOnce(() => gate.promise);
    const scanning = r.loader.loadCustomSkins();
    await vi.waitFor(() => expect(r.adapter.read).toHaveBeenCalledOnce());
    r.loader.unload();
    gate.resolve(skin.css);
    await expect(scanning).resolves.toEqual([]);
    r.loader.applyCss(skin);
    expect(document.head.querySelector("#atl-skin-custom")).toBeNull();
    await expect(r.loader.loadCustomSkins()).resolves.toEqual([]);
    expect(r.adapter.list).toHaveBeenCalledOnce();
  });

  it("rejects queued creations on unload before any file is written", async () => {
    const r = fixture({ "plugin/skins/autumn.css": ".a{}" }), gate = deferred<string>();
    r.adapter.read.mockImplementationOnce(() => gate.promise);
    const scanning = r.loader.loadCustomSkins();
    await vi.waitFor(() => expect(r.adapter.read).toHaveBeenCalledOnce());
    const creating = r.loader.createFromTemplate();
    const rejected = expect(creating).rejects.toThrow("skin-loader-unloaded");
    r.loader.unload();
    gate.resolve(".a{}");
    await scanning;
    await rejected;
    expect(r.adapter.write).not.toHaveBeenCalled();
  });
});
