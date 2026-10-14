// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boardCaptureClientRect,
  captureBoardSnapshot,
  type BoardCaptureBackend,
} from "../src/board-capture.js";
import {
  invertBoardMatrix,
  transformBoardPoint,
  type BoardSurface,
} from "../src/board-surfaces.js";
import type { BoardMatrix } from "../src/board-types.js";

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
});
afterEach(() => {
  document.body.replaceChildren();
  delete (window as Window & { electron?: unknown }).electron;
  vi.restoreAllMocks();
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
function nativeImage(width: number, height: number) {
  return {
    toPNG: () => png(width, height),
    resize: ({ width: w, height: h }: { width: number; height: number }) =>
      nativeImage(w, h),
  };
}
function fixture(
  matrix: BoardMatrix = [1, 0, 0, 1, 100, 80],
  kind: "markdown" | "pdf" = "markdown",
) {
  const viewportElement = document.createElement("div"),
    element = document.createElement("div");
  viewportElement.append(element);
  document.body.append(viewportElement);
  vi.spyOn(viewportElement, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 80, 600, 500),
  );
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 80, 500, 300),
  );
  const surface: BoardSurface = {
    id: "md:test",
    kind,
    element,
    viewportElement,
    anchor:
      kind === "markdown"
        ? { kind, key: "test", quote: "A diagram" }
        : { kind, page: 1 },
    width: 500,
    height: 300,
    text: "A diagram",
    getClientRect: () => element.getBoundingClientRect(),
    toClient: () => matrix,
    project: (point) => transformBoardPoint(matrix, point),
    unproject: (point) => transformBoardPoint(invertBoardMatrix(matrix), point),
  };
  return { surface, element, viewportElement };
}

describe("board compositor capture", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function until(check: () => boolean) {
    for (let i = 0; i < 30 && !check(); i++) await Promise.resolve();
    expect(check()).toBe(true);
  }
  it("serializes split captures and masks private UI until each compositor finishes", async () => {
    const first = fixture().surface, second = fixture().surface;
    const privateUI = document.createElement("div");
    privateUI.className = "atl-support-private";
    privateUI.style.setProperty("visibility", "visible", "important");
    document.body.append(privateUI);
    const controls = [document.createElement("button"), document.createElement("button")];
    document.body.append(...controls);
    const images = [deferred<ReturnType<typeof nativeImage>>(), deferred<ReturnType<typeof nativeImage>>()];
    let calls = 0;
    const backend = { getZoomFactor: () => 1, capturePage: vi.fn(() => {
      expect(privateUI.style.visibility).toBe("hidden");
      expect(controls[calls]!.style.visibility).toBe("hidden");
      return images[calls++]!.promise;
    }) };
    const a = captureBoardSnapshot(first, [controls[0]!], undefined, backend);
    await until(() => calls === 1);
    const b = captureBoardSnapshot(second, [controls[1]!], undefined, backend);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toBe(1);
    images[0]!.resolve(nativeImage(500, 300));
    await a;
    await until(() => calls === 2);
    expect(privateUI.style.visibility).toBe("hidden");
    images[1]!.resolve(nativeImage(500, 300));
    await b;
    expect(privateUI.style.visibility).toBe("visible");
    expect(privateUI.style.getPropertyPriority("visibility")).toBe("important");
    expect(controls.map(control => control.style.visibility)).toEqual(["", ""]);
  });

  it("does not block a popout capture on the main window's compositor", async () => {
    const main = fixture().surface, pop = fixture().surface;
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    iframe.contentDocument!.body.append(pop.viewportElement);
    const image = deferred<ReturnType<typeof nativeImage>>();
    const capturePage = vi.fn(() => image.promise);
    const a = captureBoardSnapshot(main, [], undefined, { getZoomFactor: () => 1, capturePage });
    await until(() => capturePage.mock.calls.length === 1);
    const snapshot = await captureBoardSnapshot(pop, [], undefined, { getZoomFactor: () => 1, capturePage: async () => nativeImage(500, 300) });
    expect(snapshot.width).toBe(500);
    image.resolve(nativeImage(500, 300)); await a;
  });

  it.each(["edited", "closed"] as const)("rejects a queued capture whose view was %s", async change => {
    const first = fixture().surface, second = fixture().surface;
    let revision = "buffer-1"; second.getLayoutVersion = () => revision;
    const image = deferred<ReturnType<typeof nativeImage>>();
    const capturePage = vi.fn(() => image.promise);
    const backend = { getZoomFactor: () => 1, capturePage };
    const a = captureBoardSnapshot(first, [], undefined, backend);
    await until(() => capturePage.mock.calls.length === 1);
    const b = expect(captureBoardSnapshot(second, [], undefined, backend)).rejects.toThrow("capture-layout-changed");
    if (change === "edited") revision = "buffer-2";
    else second.viewportElement.remove();
    image.resolve(nativeImage(500, 300));
    await a; await b;
    expect(capturePage).toHaveBeenCalledOnce();
  });

  it("unlocks after a compositor failure and keeps the next capture masked", async () => {
    const surface = fixture().surface, control = document.createElement("button"); document.body.append(control);
    const broken = { getZoomFactor: () => 1, capturePage: async () => { throw Error("unavailable"); } };
    const a = expect(captureBoardSnapshot(surface, [control], undefined, broken)).rejects.toThrow("capture-failed");
    const b = captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage: async () => {
      expect(control.style.visibility).toBe("hidden"); return nativeImage(500, 300);
    } });
    await a; expect((await b).width).toBe(500); expect(control.style.visibility).toBe("");
  });

  it("rejects pixels if a window's surface closes while the compositor is reading", async () => {
    const surface = fixture().surface, control = document.createElement("button"); document.body.append(control);
    const image = deferred<ReturnType<typeof nativeImage>>(), capturePage = vi.fn(() => image.promise);
    const result = expect(captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage })).rejects.toThrow("capture-layout-changed");
    await until(() => capturePage.mock.calls.length === 1);
    surface.viewportElement.remove(); image.resolve(nativeImage(500, 300)); await result;
    expect(control.style.visibility).toBe("");
  });

  it.each(["opening", "closed-again", "class-change"] as const)("discards pixels when private UI changes during capture (%s)", async change => {
    const surface = fixture().surface, control = document.createElement("button"); document.body.append(control);
    const privateUI = document.createElement("div");
    if (change === "class-change") document.body.append(privateUI);
    const image = deferred<ReturnType<typeof nativeImage>>();
    const capturePage = vi.fn(() => image.promise);
    const result = expect(captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage })).rejects.toThrow("capture-layout-changed");
    await until(() => capturePage.mock.calls.length === 1);
    privateUI.className = "atl-support-private";
    if (change !== "class-change") document.body.append(privateUI);
    if (change === "closed-again") privateUI.remove();
    image.resolve(nativeImage(500, 300)); await result;
    expect(control.style.visibility).toBe("");
  });

  it("does not return pixels or retain masks from a compositor that times out", async () => {
    vi.useFakeTimers();
    try {
      const surface = fixture().surface, control = document.createElement("button"); document.body.append(control);
      const image = deferred<ReturnType<typeof nativeImage>>(), capturePage = vi.fn(() => image.promise);
      const result = expect(captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage })).rejects.toThrow("capture-failed");
      await vi.advanceTimersByTimeAsync(120);
      expect(capturePage).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000); await result;
      expect(control.style.visibility).toBe("");
      const late = { ...nativeImage(500, 300), toPNG: vi.fn(() => png(500, 300)) };
      image.resolve(late); await Promise.resolve(); expect(late.toPNG).not.toHaveBeenCalled();
      const next = captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage: async () => nativeImage(500, 300) });
      await vi.advanceTimersByTimeAsync(120); expect((await next).width).toBe(500);
    } finally { vi.useRealTimers(); }
  });

  it("restores masks when a popout stops delivering both paint frames and its own timers", async () => {
    vi.useFakeTimers();
    try {
      const surface = fixture().surface, iframe = document.createElement("iframe"); document.body.append(iframe);
      const pop = iframe.contentWindow!; pop.document.body.append(surface.viewportElement);
      vi.spyOn(pop, "requestAnimationFrame").mockReturnValue(1);
      vi.spyOn(pop, "setTimeout").mockReturnValue(1);
      const control = pop.document.createElement("button"); pop.document.body.append(control);
      const capturePage = vi.fn(async () => nativeImage(500, 300));
      const result = expect(captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage })).rejects.toThrow("capture-failed");
      await vi.advanceTimersByTimeAsync(10_000); await result;
      expect(control.style.visibility).toBe(""); expect(capturePage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does not let an expired queued request unlock or overtake the active capture", async () => {
    vi.useFakeTimers();
    try {
      const surface = fixture().surface, control = document.createElement("button"); document.body.append(control);
      const image = deferred<ReturnType<typeof nativeImage>>(), capturePage = vi.fn(() => image.promise);
      const backend = { getZoomFactor: () => 1, capturePage };
      const a = expect(captureBoardSnapshot(surface, [control], undefined, backend)).rejects.toThrow("capture-failed");
      const b = expect(captureBoardSnapshot(surface, [control], undefined, backend)).rejects.toThrow("capture-failed");
      await vi.advanceTimersByTimeAsync(10_000); await b;
      expect(capturePage).toHaveBeenCalledOnce(); expect(control.style.visibility).toBe("hidden");
      const nextCapture = vi.fn(async () => { expect(control.style.visibility).toBe("hidden"); return nativeImage(500, 300); });
      const c = captureBoardSnapshot(surface, [control], undefined, { getZoomFactor: () => 1, capturePage: nextCapture });
      await vi.advanceTimersByTimeAsync(120); await a;
      await vi.advanceTimersByTimeAsync(120); expect((await c).width).toBe(500);
      expect(nextCapture).toHaveBeenCalledOnce(); expect(control.style.visibility).toBe("");
      image.resolve(nativeImage(500, 300));
    } finally { vi.useRealTimers(); }
  });

  it("prefers Obsidian's target-window Electron bridge without requiring a Node loader", async () => {
    const { surface } = fixture();
    const capturePage = vi.fn(async () => nativeImage(500, 300));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        remote: {
          getCurrentWebContents: () => ({
            getZoomFactor: () => 1,
            capturePage,
          }),
        },
      },
    });
    const snapshot = await captureBoardSnapshot(surface);
    expect(capturePage).toHaveBeenCalledWith({
      x: 100,
      y: 80,
      width: 500,
      height: 300,
    });
    expect(snapshot.width).toBe(500);
  });

  it("captures a popout through its own bridge, never the main window's web contents", async () => {
    const mainCapture = vi.fn(async () => nativeImage(1, 1));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        remote: {
          getCurrentWebContents: () => ({
            getZoomFactor: () => 1,
            capturePage: mainCapture,
          }),
        },
      },
    });
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const popout = iframe.contentWindow!;
    const { surface } = fixture();
    popout.document.body.append(surface.viewportElement);
    const popCapture = vi.fn(async () => nativeImage(500, 300));
    Object.defineProperty(popout, "electron", {
      configurable: true,
      value: {
        remote: {
          getCurrentWebContents: () => ({
            getZoomFactor: () => 1,
            capturePage: popCapture,
          }),
        },
      },
    });
    await captureBoardSnapshot(surface);
    expect(popCapture).toHaveBeenCalledOnce();
    expect(mainCapture).not.toHaveBeenCalled();
  });

  it("maps actual PNG pixels through browser zoom and Retina scale; restores hidden UI", async () => {
    const { surface } = fixture();
    const toolbar = document.createElement("div");
    toolbar.style.setProperty("visibility", "visible", "important");
    document.body.append(toolbar);
    const capturePage = vi.fn(async () => {
      expect(toolbar.style.visibility).toBe("hidden");
      return nativeImage(1250, 750);
    });
    const snapshot = await captureBoardSnapshot(surface, [toolbar], undefined, {
      getZoomFactor: () => 1.25,
      capturePage,
    });
    expect(capturePage).toHaveBeenCalledWith({
      x: 125,
      y: 100,
      width: 625,
      height: 375,
    });
    expect(snapshot.width).toBe(1250);
    expect(snapshot.height).toBe(750);
    expect(
      transformBoardPoint(snapshot.imageToBoard, { x: 1250, y: 750 }),
    ).toEqual({ x: 500, y: 300 });
    expect(toolbar.style.visibility).toBe("visible");
    expect(toolbar.style.getPropertyPriority("visibility")).toBe("important");
    expect(Buffer.from(snapshot.pngBase64, "base64").readUInt32BE(16)).toBe(
      1250,
    );
  });

  it("uses actual resized pixels and preserves rotation in image-to-board mapping", async () => {
    const { surface } = fixture([0, 1, -1, 0, 600, 80], "pdf");
    const backend: BoardCaptureBackend = {
      getZoomFactor: () => 1,
      capturePage: async () => nativeImage(4000, 2400),
    };
    const snapshot = await captureBoardSnapshot(
      surface,
      [],
      undefined,
      backend,
    );
    expect(snapshot.width).toBe(2048);
    expect(snapshot.height).toBe(1228);
    const first = transformBoardPoint(snapshot.imageToBoard, { x: 0, y: 0 });
    const last = transformBoardPoint(snapshot.imageToBoard, {
      x: 2048,
      y: 1228,
    });
    expect(first).toEqual({ x: 0, y: 500 });
    expect(last.x).toBeCloseTo(300);
    expect(last.y).toBeCloseTo(0);
  });

  it("extends Markdown capture to nearby ink while bounding PDF capture to its page", () => {
    const requested = { x: 50, y: 60, width: 1000, height: 1000 };
    expect(boardCaptureClientRect(fixture().surface, requested)).toEqual({
      x: 100,
      y: 80,
      width: 600,
      height: 500,
    });
    expect(
      boardCaptureClientRect(fixture(undefined, "pdf").surface, requested),
    ).toEqual({ x: 100, y: 80, width: 500, height: 300 });
  });

  it("crops a logical editor block rather than the contentDOM shared by every editor surface", async () => {
    const { surface } = fixture([1, 0, 0, 1, 100, 180]);
    surface.getClientRect = () => ({ x: 100, y: 180, width: 500, height: 40 });
    const capturePage = vi.fn(async () => nativeImage(1000, 80));
    const snapshot = await captureBoardSnapshot(surface, [], undefined, { getZoomFactor: () => 1, capturePage });
    expect(capturePage).toHaveBeenCalledWith({ x: 100, y: 180, width: 500, height: 40 });
    expect(transformBoardPoint(snapshot.imageToBoard, { x: 1000, y: 80 })).toEqual({ x: 500, y: 40 });
  });

  it("rejects an editor snapshot when text or layout changes even if its old cached rectangle does not", async () => {
    const { surface } = fixture();
    let revision = "buffer-1:layout-1";
    surface.getLayoutVersion = () => revision;
    await expect(captureBoardSnapshot(surface, [], undefined, {
      getZoomFactor: () => 1,
      capturePage: async () => { revision = "buffer-2:layout-1"; return nativeImage(500, 300); },
    })).rejects.toThrow("capture-layout-changed");
  });

  it("rejects a capture after page geometry changes and still restores controls", async () => {
    const { surface, element } = fixture();
    const control = document.createElement("button");
    document.body.append(control);
    const backend: BoardCaptureBackend = {
      getZoomFactor: () => 1,
      capturePage: async () => {
        surface.toClient = () => [1, 0, 0, 1, 100, 120];
        vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
          new DOMRect(100, 120, 500, 300),
        );
        return nativeImage(1000, 600);
      },
    };
    await expect(
      captureBoardSnapshot(surface, [control], undefined, backend),
    ).rejects.toThrow("capture-layout-changed");
    expect(control.style.visibility).toBe("");
  });

  it("fails explicitly on compositor errors or invalid PNG instead of returning substitute pixels", async () => {
    const { surface } = fixture();
    await expect(
      captureBoardSnapshot(surface, [], undefined, {
        getZoomFactor: () => 1,
        capturePage: async () => {
          throw Error("denied");
        },
      }),
    ).rejects.toThrow("capture-failed");
    await expect(
      captureBoardSnapshot(surface, [], undefined, {
        getZoomFactor: () => 1,
        capturePage: async () => ({ toPNG: () => new Uint8Array(30) }),
      }),
    ).rejects.toThrow("capture-failed");
  });
});
