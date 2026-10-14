import { describe, expect, it, vi } from "vitest";
import type { VaultStore } from "../src/store.js";
import type { AnnotationTutorLiteSettings } from "../src/settings-config.js";
import { MemoryWatcher } from "../src/watcher.js";

describe("watcher cache invalidation", () => {
  it("invalidates before scheduling, even when automatic watching is off", () => {
    const invalidateLibrary = vi.fn();
    const watched = vi.fn(() => true);
    const store = { invalidateLibrary, isLearningWatchedPath: watched } as unknown as VaultStore;
    const settings = { watchMemoryFiles: false } as AnnotationTutorLiteSettings;
    const reconcile = vi.fn();
    const watcher = new MemoryWatcher(store, () => settings, reconcile);
    watcher.notify("Agent Memory/memory-cells/external.md");
    expect(invalidateLibrary).toHaveBeenCalledExactlyOnceWith(["Agent Memory/memory-cells/external.md"]);
    expect(watched).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    watcher.dispose();
    watcher.notify("Agent Memory/memory-cells/after-dispose.md");
    expect(invalidateLibrary).toHaveBeenCalledTimes(1);
  });
});
