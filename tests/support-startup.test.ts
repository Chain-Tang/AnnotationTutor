import { afterEach, describe, expect, it, vi } from "vitest";
import { SupportSession, type SupportStorage, type SupportSummary } from "../src/support-session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const now = new Date("2026-10-14T00:00:00Z");
function summary(expiresAt: string): SupportSummary {
  return { format: 1, id: crypto.randomUUID(), text: "PRIVATE_SAVED_SUPPORT", confirmedAt: "2026-10-01T00:00:00Z", expiresAt };
}
function storage(): SupportStorage & { save: ReturnType<typeof vi.fn> } {
  return { available: () => true, readDay: async () => "", load: async () => [], save: vi.fn(async () => {}), writeDay: async () => {} };
}
afterEach(() => { vi.useRealTimers(); });

describe("support startup lifetime", () => {
  it("does not publish a late private restore or restart expiry after disposal", async () => {
    vi.useFakeTimers();
    const db = storage(), gate = deferred<SupportSummary[]>(), load = vi.fn(() => gate.promise);
    db.load = load;
    const session = new SupportSession(db, async () => "", () => now), listener = vi.fn();
    session.subscribe(listener);
    const initializing = session.initialize();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    session.dispose(); gate.resolve([summary("2026-10-20T00:00:00Z")]);
    await initializing;
    expect(session.summaries).toEqual([]); expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); expect(db.save).not.toHaveBeenCalled();
  });

  it("finishes an expiry persistence already in progress without restarting timers", async () => {
    vi.useFakeTimers();
    const db = storage(), gate = deferred<void>(), future = summary("2026-10-20T00:00:00Z");
    db.load = async () => [summary("2026-10-12T00:00:00Z"), future];
    db.save.mockImplementation(() => gate.promise);
    const session = new SupportSession(db, async () => "", () => now);
    const initializing = session.initialize();
    await vi.waitFor(() => expect(db.save).toHaveBeenCalledOnce());
    expect(db.save).toHaveBeenCalledWith([future]);
    session.dispose(); gate.resolve(); await initializing; await session.flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a daily prompt whose durable claim completed after disposal", async () => {
    const db = storage(), gate = deferred<void>(), write = vi.fn(() => gate.promise);
    db.writeDay = write;
    const session = new SupportSession(db, async () => "", () => now), listener = vi.fn();
    session.subscribe(listener);
    const claiming = session.activity(true);
    expect(write).toHaveBeenCalledOnce(); session.dispose(); gate.resolve(); await claiming;
    expect(session.pending).toBe(false); expect(listener).not.toHaveBeenCalled();
  });

  it("does not start a provider call after unloading during expiry IO", async () => {
    const db = storage(), gate = deferred<void>(), run = vi.fn(async () => "late");
    db.save.mockImplementation(() => gate.promise);
    const session = new SupportSession(db, run, () => now);
    session.summaries = [summary("2026-10-12T00:00:00Z")];
    const sending = session.send("temporary input");
    await vi.waitFor(() => expect(db.save).toHaveBeenCalledOnce());
    session.dispose(); gate.resolve(); await sending;
    expect(run).not.toHaveBeenCalled(); expect(session.messages).toEqual([]);
  });
});
