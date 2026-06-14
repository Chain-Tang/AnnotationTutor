// Debounced watcher for agent edits to the memory files. The plugin forwards
// vault events here; this filters out the plugin's own writes (loop-guard via
// VaultStore) and batches the rest before asking the plugin to reconcile.

import type { AnnotationTutorLiteSettings } from "./settings.js";
import type { VaultStore } from "./store.js";

export class MemoryWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<string>();

  public constructor(
    private readonly store: VaultStore,
    private readonly getSettings: () => AnnotationTutorLiteSettings,
    private readonly onFlush: (paths: string[]) => void | Promise<void>,
    private readonly delayMs = 300
  ) {}

  public notify(path: string): void {
    if (!this.getSettings().watchMemoryFiles) return;
    if (!this.store.isWatchedPath(path)) return;
    if (this.store.wasRecentlyWritten(path)) return;
    this.pending.add(path);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  private flush(): void {
    const paths = [...this.pending];
    this.pending.clear();
    this.timer = null;
    if (paths.length > 0) void this.onFlush(paths);
  }

  public dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
