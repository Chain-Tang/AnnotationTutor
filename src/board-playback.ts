import type { BoardPathCommand, BoardVectorAsset, BoardVectorNode } from "./board-types.js";

export type BoardPlaybackSpeed = 0.5 | 1 | 2 | "instant";
export type BoardPlaybackEvent =
  | { type: "stage"; stage: "composition" | "large-forms" | "details" | "inspection" }
  | { type: "frame"; asset: BoardVectorAsset; nodeId: string; progress: number }
  | { type: "complete"; asset: BoardVectorAsset }
  | { type: "cancelled" };

function clone<T>(value: T): T { return structuredClone(value); }
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

/** UI-neutral progressive reveal. The source asset remains immutable until the caller commits it. */
export class BoardVectorPlayback {
  private paused = false;
  private cancelled = false;
  private speed: BoardPlaybackSpeed = 1;
  private resumeWaiters: Array<() => void> = [];
  public pause(): void { this.paused = true; }
  public resume(): void { this.paused = false; for (const resolve of this.resumeWaiters.splice(0)) resolve(); }
  public setSpeed(speed: BoardPlaybackSpeed): void { this.speed = speed; if (speed === "instant") this.resume(); }
  public cancel(): void { this.cancelled = true; this.resume(); }
  private async ready(): Promise<void> { if (this.paused) await new Promise<void>(resolve => this.resumeWaiters.push(resolve)); }

  public async *play(asset: BoardVectorAsset, signal?: AbortSignal): AsyncIterable<BoardPlaybackEvent> {
    this.cancelled = false;
    const revealed = clone(asset); revealed.nodes = []; revealed.rootIds = [];
    const groups = asset.nodes.filter(node => node.kind === "group");
    for (const group of groups) { revealed.nodes.push(clone(group)); if (!group.parentId) revealed.rootIds.push(group.id); }
    const drawable = asset.nodes.filter(node => node.kind !== "group");
    yield { type: "stage", stage: "composition" };
    for (let index = 0; index < drawable.length; index++) {
      await this.ready();
      if (this.cancelled || signal?.aborted) { yield { type: "cancelled" }; return; }
      if (index === Math.ceil(drawable.length * 0.2)) yield { type: "stage", stage: "large-forms" };
      if (index === Math.ceil(drawable.length * 0.65)) yield { type: "stage", stage: "details" };
      const node = drawable[index]!;
      const path = node.path ?? [];
      if (path.length > 2 && this.speed !== "instant") {
        const shell: BoardVectorNode = { ...clone(node), path: [] };
        revealed.nodes.push(shell);
        const chunks = Math.min(24, Math.max(2, Math.ceil(path.length / 8)));
        for (let part = 1; part <= chunks; part++) {
          await this.ready();
          if (this.cancelled || signal?.aborted) { yield { type: "cancelled" }; return; }
          const count = Math.max(1, Math.ceil(path.length * part / chunks));
          shell.path = clone(path.slice(0, count)) as BoardPathCommand[];
          yield { type: "frame", asset: clone(revealed), nodeId: node.id, progress: part / chunks };
          const factor = this.speed === 0.5 ? 2 : this.speed === 2 ? 0.5 : 1;
          await wait(16 * factor, signal);
        }
      } else {
        revealed.nodes.push(clone(node));
        yield { type: "frame", asset: clone(revealed), nodeId: node.id, progress: 1 };
        if (this.speed !== "instant") await wait(this.speed === 0.5 ? 32 : this.speed === 2 ? 8 : 16, signal);
      }
    }
    yield { type: "stage", stage: "inspection" };
    yield { type: "complete", asset: clone(asset) };
  }
}
