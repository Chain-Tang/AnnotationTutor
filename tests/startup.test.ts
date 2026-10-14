import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupCancelled, StartupIdleTasks, StartupLifetime, StartupTimings } from "../src/startup.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("startup timings", () => {
  it("measures pending IO and returns detached memory-only records", async () => {
    let now = 10;
    const timings = new StartupTimings(() => now);
    let resolve!: (value: string) => void;
    const operation = timings.measure("settings", () => new Promise<string>(done => { resolve = done; }));
    now = 17;
    const snapshot = timings.snapshot();
    expect(snapshot).toEqual([{ stage: "settings", status: "running", elapsedMs: 7 }]);
    (snapshot[0] as { elapsedMs: number }).elapsedMs = 123;
    expect(timings.snapshot()[0]!.elapsedMs).toBe(7);
    now = 24;
    resolve("PRIVATE_SETTINGS_PAYLOAD");
    await expect(operation).resolves.toBe("PRIVATE_SETTINGS_PAYLOAD");
    now = 100;
    expect(timings.snapshot()).toEqual([{ stage: "settings", status: "ready", elapsedMs: 14 }]);
    expect(JSON.stringify(timings.snapshot())).not.toContain("PRIVATE");
  });

  it("preserves exact failures and closes unfinished startup sections", async () => {
    let now = 1;
    const timings = new StartupTimings(() => now);
    const error = new Error("PRIVATE_CREDENTIAL_ERROR");
    const operation = timings.measure("onload", () => {
      timings.begin("core-services");
      now = 9;
      throw error;
    });
    await expect(operation).rejects.toBe(error);
    timings.failRunning();
    expect(timings.snapshot()).toEqual([
      { stage: "onload", status: "failed", elapsedMs: 8 },
      { stage: "core-services", status: "failed", elapsedMs: 8 },
    ]);
    expect(JSON.stringify(timings.snapshot())).not.toContain("PRIVATE");
  });

  it("bounds history and keeps completed phase durations stable", () => {
    let now = 10;
    const timings = new StartupTimings(() => now);
    for (let n = 0; n < 40; n++) {
      const finish = timings.begin("custom-skins");
      now += 2;
      finish();
      now += 100;
      finish("failed");
    }
    expect(timings.snapshot()).toHaveLength(32);
    expect(timings.snapshot().every(record => record.status === "ready" && record.elapsedMs === 2)).toBe(true);
  });
});

describe("startup lifetime", () => {
  it("waits for durable IO before cancellation cleanup", async () => {
    const lifetime = new StartupLifetime(), events: string[] = [];
    let resolve!: (value: string) => void;
    const waiting = lifetime.waitFor(() => new Promise<string>(done => { resolve = done; events.push("started"); }), () => { events.push("cleaned"); });
    const rejected = expect(waiting).rejects.toBeInstanceOf(StartupCancelled);
    lifetime.cancel();
    expect(events).toEqual(["started"]);
    events.push("durable"); resolve("private-value");
    await rejected;
    expect(events).toEqual(["started", "durable", "cleaned"]);
  });

  it("cleans up late failures and blocks new operations after cancellation", async () => {
    const lifetime = new StartupLifetime(), cleanup = vi.fn();
    let reject!: (error: Error) => void;
    const waiting = lifetime.waitFor(() => new Promise<void>((_, fail) => { reject = fail; }), cleanup);
    const rejected = expect(waiting).rejects.toBeInstanceOf(StartupCancelled);
    lifetime.cancel(); reject(new Error("PRIVATE_STORAGE_FAILURE"));
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
    const run = vi.fn();
    await expect(lifetime.waitFor(run)).rejects.toBeInstanceOf(StartupCancelled);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("optional startup idle tasks", () => {
  it("cancels queued work and ignores callbacks already dispatched at unload", () => {
    const callbacks: Array<() => void> = [], cancel = vi.fn(), run = vi.fn();
    const tasks = new StartupIdleTasks(callback => { callbacks.push(callback); return cancel; });
    tasks.defer(run);
    tasks.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    callbacks[0]!();
    tasks.defer(run);
    expect(run).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
  });

  it("does not retain completed callbacks", () => {
    const callbacks: Array<() => void> = [], cancel = vi.fn(), run = vi.fn();
    const tasks = new StartupIdleTasks(callback => { callbacks.push(callback); return cancel; });
    tasks.defer(run);
    callbacks[0]!();
    tasks.dispose();
    expect(run).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("uses cancellable timers when idle callbacks are unavailable", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const run = vi.fn(), tasks = new StartupIdleTasks();
    tasks.defer(run);
    expect(run).not.toHaveBeenCalled();
    tasks.dispose();
    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
    const next = new StartupIdleTasks();
    next.defer(run);
    vi.runAllTimers();
    expect(run).toHaveBeenCalledOnce();
  });

  it("requests an idle slot with a bounded timeout and cancels it", () => {
    const idle = vi.fn(() => 42), cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", cancel);
    const tasks = new StartupIdleTasks();
    tasks.defer(vi.fn());
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
    tasks.dispose();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
