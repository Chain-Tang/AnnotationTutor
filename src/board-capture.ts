import {
  boardSurfaceLayoutRevision,
  invertBoardMatrix,
  multiplyBoardMatrices,
  type BoardSurface,
} from "./board-surfaces.js";
import type { BoardRect, BoardSnapshot } from "./board-types.js";
export { boardSurfaceLayoutRevision } from "./board-surfaces.js";

export class BoardCaptureError extends Error {
  constructor(
    public readonly code:
      | "capture-unavailable"
      | "capture-empty"
      | "capture-failed"
      | "capture-layout-changed",
  ) {
    super(code);
    this.name = "BoardCaptureError";
  }
}

interface NativeImage {
  toPNG(): Uint8Array;
  isEmpty?(): boolean;
  resize?(size: {
    width: number;
    height: number;
    quality: "good";
  }): NativeImage;
}
export interface BoardCaptureBackend {
  getZoomFactor(): number;
  capturePage(rect: BoardRect): Promise<NativeImage>;
}

function backendFor(win: Window): BoardCaptureBackend {
  // A popout must resolve Electron in its own renderer. Falling back to the
  // main window for a foreign document silently photographs the wrong note.
  type Remote = { getCurrentWebContents?(): BoardCaptureBackend };
  const target = win as Window & {
    require?: (name: string) => unknown;
    electron?: { remote?: Remote };
  };
  const ownRequire = target.require;
  const loader =
    ownRequire ??
    (typeof window !== "undefined" &&
    win === window &&
    typeof require === "function"
      ? require
      : null);
  try {
    // Obsidian exposes a per-window Electron bridge even when Node's require
    // is unavailable. Resolve this before considering legacy module loaders.
    let remote = target.electron?.remote;
    if (!remote?.getCurrentWebContents && loader) {
      try {
        remote = (loader("electron") as { remote?: Remote }).remote;
      } catch {
        /* try the remote module next */
      }
    }
    if (!remote?.getCurrentWebContents && loader) {
      try {
        remote = loader("@electron/remote") as Remote;
      } catch {
        /* older hosts expose electron.remote */
      }
    }
    const backend = remote?.getCurrentWebContents?.();
    if (
      !backend ||
      typeof backend.capturePage !== "function" ||
      typeof backend.getZoomFactor !== "function"
    )
      throw new BoardCaptureError("capture-unavailable");
    return backend;
  } catch (error) {
    if (error instanceof BoardCaptureError) throw error;
    throw new BoardCaptureError("capture-unavailable");
  }
}

function intersect(left: BoardRect, right: BoardRect): BoardRect {
  const x = Math.max(left.x, right.x),
    y = Math.max(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(
      0,
      Math.min(left.x + left.width, right.x + right.width) - x,
    ),
    height: Math.max(
      0,
      Math.min(left.y + left.height, right.y + right.height) - y,
    ),
  };
}
function rectOf(element: HTMLElement): BoardRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export function boardCaptureClientRect(
  surface: BoardSurface,
  requested?: BoardRect,
): BoardRect {
  const win = surface.element.ownerDocument.defaultView;
  if (!win) throw new BoardCaptureError("capture-unavailable");
  let rect = intersect(
    requested ?? surface.getClientRect(),
    rectOf(surface.viewportElement),
  );
  rect = intersect(rect, {
    x: 0,
    y: 0,
    width: win.innerWidth,
    height: win.innerHeight,
  });
  // PDF capture never crosses a page boundary. Markdown callers can include
  // nearby paragraphs when the active drawing extends past its anchor block.
  if (surface.kind === "pdf") rect = intersect(rect, surface.getClientRect());
  for (
    let ancestor = surface.viewportElement.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = win.getComputedStyle(ancestor);
    if (
      /(?:hidden|clip|scroll|auto)/.test(
        `${style.overflow} ${style.overflowX} ${style.overflowY}`,
      ) ||
      ancestor.matches(".view-content, .workspace-leaf-content")
    )
      rect = intersect(rect, rectOf(ancestor));
  }
  if (rect.width < 1 || rect.height < 1)
    throw new BoardCaptureError("capture-empty");
  return rect;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    bytes[2] !== 78 ||
    bytes[3] !== 71
  )
    throw new BoardCaptureError("capture-failed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (width < 1 || height < 1) throw new BoardCaptureError("capture-empty");
  return { width, height };
}

function afterPaint(win: Window): Promise<void> {
  return new Promise((resolve) => {
    const timeout = win.setTimeout(resolve, 120);
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => {
        win.clearTimeout(timeout);
        resolve();
      }),
    );
  });
}

// UI visibility belongs to a document, not a board controller. Split views
// must not restore each other's masks while the compositor is still reading.
const captureTails = new WeakMap<Document, Promise<void>>();
const CAPTURE_TIMEOUT_MS = 10_000;
async function boundedCapture<T>(pending: Promise<T>): Promise<T> {
  // The plugin's runtime survives closing a popout; that window's timers may
  // stop before either a paint callback or native capture has completed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BoardCaptureError("capture-failed")), CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Actual compositor pixels; never substitutes reconstructed HTML or text. */
export async function captureBoardSnapshot(
  surface: BoardSurface,
  hiddenElements: HTMLElement[] = [],
  requestedClientRect?: BoardRect,
  injectedBackend?: BoardCaptureBackend,
): Promise<BoardSnapshot> {
  const doc = surface.element.ownerDocument, win = doc.defaultView;
  if (!win || !surface.element.isConnected || !surface.viewportElement.isConnected)
    throw new BoardCaptureError("capture-unavailable");
  const revision = boardSurfaceLayoutRevision(surface);
  const previous = captureTails.get(doc) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  captureTails.set(doc, tail);
  try {
    await boundedCapture(previous);
    if (surface.element.ownerDocument !== doc || surface.viewportElement.ownerDocument !== doc ||
      !surface.element.isConnected || !surface.viewportElement.isConnected ||
      revision !== boardSurfaceLayoutRevision(surface))
      throw new BoardCaptureError("capture-layout-changed");
    return await captureUnlocked(surface, hiddenElements, requestedClientRect, injectedBackend);
  } finally {
    release();
    // A timed-out waiter cannot unlock an earlier capture or erase a newer tail.
    void tail.then(() => { if (captureTails.get(doc) === tail) captureTails.delete(doc); });
  }
}

async function captureUnlocked(
  surface: BoardSurface,
  hiddenElements: HTMLElement[],
  requestedClientRect?: BoardRect,
  injectedBackend?: BoardCaptureBackend,
): Promise<BoardSnapshot> {
  const win = surface.element.ownerDocument.defaultView;
  if (!win) throw new BoardCaptureError("capture-unavailable");
  const backend = injectedBackend ?? backendFor(win);
  const zoom = backend.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0)
    throw new BoardCaptureError("capture-failed");
  const crop = boardCaptureClientRect(surface, requestedClientRect);
  const dip = {
    x: Math.ceil(crop.x * zoom),
    y: Math.ceil(crop.y * zoom),
    width: Math.floor((crop.x + crop.width) * zoom) - Math.ceil(crop.x * zoom),
    height:
      Math.floor((crop.y + crop.height) * zoom) - Math.ceil(crop.y * zoom),
  };
  if (dip.width < 1 || dip.height < 1)
    throw new BoardCaptureError("capture-empty");
  const layoutRevision = boardSurfaceLayoutRevision(surface);
  const hidden = [...new Set([...hiddenElements,...surface.element.ownerDocument.querySelectorAll<HTMLElement>(".atl-support-private")])]
    .filter(
      (element) => element.ownerDocument === surface.element.ownerDocument,
    )
    .map((element) => ({
      element,
      value: element.style.getPropertyValue("visibility"),
      priority: element.style.getPropertyPriority("visibility"),
    }));
  // A support view opening during capture was not in the initial mask list.
  // Discard those pixels, even if the view has already closed by completion.
  let privacyChanged = false;
  const containsPrivate = (node: Node): boolean => node.nodeType === 1 &&
    ((node as Element).matches(".atl-support-private") || !!(node as Element).querySelector(".atl-support-private"));
  const PrivacyObserver = (win as Window & { MutationObserver: typeof MutationObserver }).MutationObserver;
  const inspectPrivacy = (records: MutationRecord[]): void => {
    if (records.some(record => record.type === "attributes"
      ? containsPrivate(record.target) || /(?:^|\s)atl-support-private(?:\s|$)/.test(record.oldValue ?? "")
      : [...record.addedNodes, ...record.removedNodes].some(containsPrivate))) privacyChanged = true;
  };
  const privacyObserver = new PrivacyObserver(inspectPrivacy);
  privacyObserver.observe(surface.element.ownerDocument.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true,
  });
  const current = (): boolean => {
    inspectPrivacy(privacyObserver.takeRecords());
    return !privacyChanged && surface.element.isConnected && surface.viewportElement.isConnected &&
      surface.element.ownerDocument.defaultView === win && layoutRevision === boardSurfaceLayoutRevision(surface);
  };
  try {
    for (const item of hidden)
      item.element.style.setProperty("visibility", "hidden", "important");
    await boundedCapture(afterPaint(win));
    if (!current())
      throw new BoardCaptureError("capture-layout-changed");
    let image = await boundedCapture(backend.capturePage(dip));
    if (image.isEmpty?.()) throw new BoardCaptureError("capture-empty");
    let png = image.toPNG(),
      size = pngDimensions(png);
    if (Math.max(size.width, size.height) > 2048) {
      if (!image.resize) throw new BoardCaptureError("capture-failed");
      const scale = 2048 / Math.max(size.width, size.height);
      image = image.resize({
        width: Math.max(1, Math.floor(size.width * scale)),
        height: Math.max(1, Math.floor(size.height * scale)),
        quality: "good",
      });
      png = image.toPNG();
      size = pngDimensions(png);
      if (Math.max(size.width, size.height) > 2048)
        throw new BoardCaptureError("capture-failed");
    }
    if (!current())
      throw new BoardCaptureError("capture-layout-changed");
    return {
      pngBase64: Buffer.from(png).toString("base64"),
      ...size,
      imageToBoard: multiplyBoardMatrices(
        invertBoardMatrix(surface.toClient()),
        [
          dip.width / zoom / size.width,
          0,
          0,
          dip.height / zoom / size.height,
          dip.x / zoom,
          dip.y / zoom,
        ],
      ),
      anchor: surface.anchor,
      layoutRevision,
    };
  } catch (error) {
    if (error instanceof BoardCaptureError) throw error;
    throw new BoardCaptureError("capture-failed");
  } finally {
    privacyObserver.disconnect();
    for (const item of hidden) {
      if (item.value)
        item.element.style.setProperty("visibility", item.value, item.priority);
      else item.element.style.removeProperty("visibility");
    }
  }
}
