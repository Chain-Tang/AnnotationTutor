// Debounced watcher for agent edits to the memory files. The plugin forwards
// vault events here; this filters out the plugin's own writes (loop-guard via
// VaultStore) and batches the rest before asking the plugin to reconcile.

import type { AnnotationTutorLiteSettings } from "./settings.js";
import type { VaultStore } from "./store.js";

export class MemoryWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<string>();
  private flushing = false;
  private disposed = false;

  public constructor(
    private readonly store: VaultStore,
    private readonly getSettings: () => AnnotationTutorLiteSettings,
    private readonly onFlush: (paths: string[]) => void | Promise<void>,
    private readonly delayMs = 300
  ) {}

  public notify(path: string): void {
    if (this.disposed) return;
    // Cache validity is independent of whether the user enabled automatic UI
    // refresh. Scene derivation must see edits made before the debounce fires.
    this.store.invalidateLibrary([path]);
    if (!this.getSettings().watchMemoryFiles) return;
    if (!this.store.isLearningWatchedPath(path)) return;
    this.pending.add(path);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    const paths = [...this.pending];
    this.pending.clear();
    try {
      const external = (await Promise.all(paths.map(async path => {
        // A failed fingerprint read must still be reconciled by the host.
        try { return await this.store.isOwnWrite(path) ? null : path; }
        catch { return path; }
      }))).filter((path): path is string => path !== null);
      if (!this.disposed && external.length > 0) await this.onFlush(external);
    } catch (error) {
      console.error("[Annotation Tutor Lite] memory reconciliation failed", error);
    } finally {
      this.flushing = false;
      if (!this.disposed && this.pending.size > 0 && this.timer === null) {
        this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
