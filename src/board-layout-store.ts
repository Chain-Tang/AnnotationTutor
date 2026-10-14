import { boardLayoutSchema, type BoardLayoutManifest } from "./board-layout.js";
import { boardLayoutDigest as surfaceDigest } from "./board-layout-digest.js";
import type { BoardDocument } from "./board-types.js";
import type { BoardStorageAdapter } from "./board-store.js";

/** Scene writes and layout writes share the repository queue. An interrupted
 * layout becomes visible only when its exact scene was durably committed. */
export class BoardLayoutStore {
  private observed = new Map<string, string | null>();
  constructor(private adapter: BoardStorageAdapter, private root: string) {}
  path(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw Error("layout-board-id");
    return `${this.root}/boards/${id}.layout.json`;
  }
  private async read(path: string): Promise<string | null> {
    return await this.adapter.exists(path) ? this.adapter.read(path) : null;
  }
  async changed(id: string): Promise<boolean> {
    return this.observed.has(id) && await this.read(this.path(id)) !== this.observed.get(id);
  }
  async load(id: string, document?: BoardDocument): Promise<BoardLayoutManifest | undefined> {
    const path = this.path(id), raw = await this.read(path);
    this.observed.set(id, raw);
    let value: BoardLayoutManifest | undefined;
    if (raw !== null) {
      try { value = this.parse(raw, id); }
      catch (error) {
        // A future format must never be silently replaced by an older backup.
        try { if (JSON.parse(raw)?.format !== "tutor-board-layout-v1") throw Error("layout-unsupported-format"); }
        catch (formatError) { if (formatError instanceof Error && formatError.message === "layout-unsupported-format") throw formatError; }
        const previous = await this.read(path + ".previous");
        if (!previous) throw error;
        value = this.parse(previous, id);
      }
    }
    if (document) {
      const pending = await this.read(path + ".pending");
      if (pending) try {
        if (pending.length > 16_000_000) throw Error("layout-size");
        const recovery = JSON.parse(pending);
        if (recovery.format === "tutor-board-layout-pending-v1" && recovery.boardDigest === surfaceDigest(document) &&
            recovery.baseHash === surfaceDigest(raw)) {
          const candidate = this.parse(JSON.stringify(recovery.layout), id);
          if (!value || candidate.revision > value.revision) value = candidate;
        }
      } catch { /* Uncommitted/corrupt recovery never replaces valid layout. */ }
    }
    return value;
  }
  private parse(raw: string, id: string): BoardLayoutManifest {
    if (raw.length > 16_000_000) throw Error("layout-size");
    const value = boardLayoutSchema.parse(JSON.parse(raw));
    if (value.boardId !== id) throw Error("layout-board-mismatch");
    return value;
  }
  async prepare(value: BoardLayoutManifest, document: BoardDocument): Promise<void> {
    value = boardLayoutSchema.parse(value);
    if (value.boardId !== document.id) throw Error("layout-board-mismatch");
    const path = this.path(value.boardId), raw = await this.read(path);
    if (!this.observed.has(value.boardId)) this.observed.set(value.boardId, raw);
    if (raw !== this.observed.get(value.boardId)) throw Error("layout-external-conflict");
    await this.adapter.write(path + ".pending", JSON.stringify({ format: "tutor-board-layout-pending-v1", boardDigest: surfaceDigest(document), baseHash: surfaceDigest(raw), layout: value }));
  }
  async commit(value: BoardLayoutManifest): Promise<void> {
    value = boardLayoutSchema.parse(value);
    const path = this.path(value.boardId), raw = await this.read(path), expected = this.observed.get(value.boardId) ?? null, next = JSON.stringify(value);
    if (raw !== expected) throw Error("layout-external-conflict");
    if (raw === next) return;
    if (raw !== null) {
      // Only a valid revision can replace the last valid recovery copy.
      try { this.parse(raw, value.boardId); await this.adapter.write(path + ".previous", raw); }
      catch (error) { if (!(error instanceof SyntaxError) && (error as {name?:string}).name !== "ZodError") throw error; }
    }
    if (this.adapter.process && raw !== null) {
      let conflict = false;
      await this.adapter.process(path, latest => { if (latest !== expected) { conflict = true; return latest; } return next; });
      if (conflict) throw Error("layout-external-conflict");
    } else {
      if (await this.read(path) !== expected) throw Error("layout-external-conflict");
      await this.adapter.write(path, next);
    }
    if (await this.read(path) !== next) throw Error("layout-save-verification");
    this.observed.set(value.boardId, next);
  }
}
