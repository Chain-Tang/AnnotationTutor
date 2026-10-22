import { describe, expect, it, vi } from "vitest";
import { ExternalGenerationGate } from "../src/external-generation-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const freshSignal = () => new AbortController().signal;
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

describe("shared external generation admission", () => {
  it("allows two clients at once, one active call per client, and preserves eligible FIFO order", async () => {
    const gate = new ExternalGenerationGate(), started: string[] = [], releases = new Map<string, ReturnType<typeof deferred<void>>>();
    let actualActive = 0, maximum = 0;
    const activeClients = new Set<string>();
    const run = (client: string, label: string) => gate.run(client, freshSignal(), async () => {
      expect(activeClients.has(client)).toBe(false); activeClients.add(client);
      actualActive++; maximum = Math.max(maximum, actualActive); started.push(label);
      const release = deferred(); releases.set(label, release); await release.promise;
      activeClients.delete(client); actualActive--; return label;
    });
    const a = run("mcp:a", "a1"), secondA = run("mcp:a", "a2"), thirdA = run("mcp:a", "a3"), b = run("clipper:b", "b1"), c = run("mcp:c", "c1");
    await Promise.resolve(); expect(started).toEqual(["a1", "b1"]);
    expect(gate.snapshot()).toEqual({ active: 2, queued: 3, closed: false });
    releases.get("b1")!.resolve(); await b; await Promise.resolve(); expect(started).toEqual(["a1", "b1", "c1"]);
    releases.get("a1")!.resolve(); await a; await Promise.resolve(); expect(started.at(-1)).toBe("a2");
    releases.get("a2")!.resolve(); await secondA; await Promise.resolve(); expect(started.at(-1)).toBe("a3");
    releases.get("c1")!.resolve(); releases.get("a3")!.resolve();
    await expect(Promise.all([thirdA, c])).resolves.toEqual(["a3", "c1"]);
    expect(maximum).toBe(2); expect(gate.snapshot()).toEqual({ active: 0, queued: 0, closed: false });
    await gate.close();
  });

  it("bounds the waiting queue at sixteen independently of its two active calls", async () => {
    const gate = new ExternalGenerationGate(), running = deferred();
    const first = gate.run("a", freshSignal(), () => running.promise), second = gate.run("b", freshSignal(), () => running.promise);
    const controllers = Array.from({ length: 16 }, () => new AbortController()), callback = vi.fn();
    const waiting = controllers.map((controller, index) => settle(gate.run(`client:${index}`, controller.signal, callback)));
    expect(gate.snapshot()).toEqual({ active: 2, queued: 16, closed: false });
    await expect(gate.run("overflow", freshSignal(), callback)).rejects.toMatchObject({ code: "external-generation-queue-full" });
    controllers.forEach(controller => controller.abort());
    expect((await Promise.all(waiting)).every(result => result.error.code === "external-generation-cancelled")).toBe(true);
    expect(callback).not.toHaveBeenCalled(); running.resolve(); await Promise.all([first, second]); await gate.close();
  });

  it("bounds each client's waiting calls at two and accepts a replacement after queued cancellation", async () => {
    const gate = new ExternalGenerationGate(), running = deferred(), queuedController = new AbortController(), callback = vi.fn(() => "finished");
    const first = gate.run("same", freshSignal(), () => running.promise);
    const second = settle(gate.run("same", queuedController.signal, callback)), third = gate.run("same", freshSignal(), callback);
    await expect(gate.run("same", freshSignal(), callback)).rejects.toMatchObject({ code: "external-generation-client-queue-full" });
    queuedController.abort(); expect((await second).error.code).toBe("external-generation-cancelled");
    const replacement = gate.run("same", freshSignal(), callback);
    running.resolve(); await Promise.all([first, third, replacement]); expect(callback).toHaveBeenCalledTimes(2); await gate.close();
  });

  it("rejects an already aborted signal and an abort immediately after admission without starting work", async () => {
    const gate = new ExternalGenerationGate(), stopped = new AbortController(), late = new AbortController(), callback = vi.fn();
    stopped.abort(new Error("upstream reason is not a gate diagnostic"));
    await expect(gate.run("a", stopped.signal, callback)).rejects.toMatchObject({ code: "external-generation-cancelled" });
    const result = settle(gate.run("b", late.signal, callback)); late.abort();
    expect((await result).error.message).toBe("external-generation-cancelled");
    await gate.close(); expect(callback).not.toHaveBeenCalled(); expect(gate.snapshot().active).toBe(0);
  });

  it("does not start a queued operation cancelled as the preceding slot is released", async () => {
    const gate = new ExternalGenerationGate(), firstRelease = deferred(), controller = new AbortController(), callback = vi.fn();
    const first = gate.run("same", freshSignal(), () => firstRelease.promise);
    const queued = settle(gate.run("same", controller.signal, callback));
    await Promise.resolve(); firstRelease.resolve(); controller.abort(); await first;
    expect((await queued).error.code).toBe("external-generation-cancelled"); expect(callback).not.toHaveBeenCalled(); await gate.close();
  });

  it("aborts active work and rejects promptly but retains its slot until ignored cancellation actually settles", async () => {
    const gate = new ExternalGenerationGate(), source = new AbortController(), ignored = deferred<string>(), other = deferred();
    let signal!: AbortSignal;
    const active = settle(gate.run("a", source.signal, provided => { signal = provided; return ignored.promise; }));
    const another = gate.run("b", freshSignal(), () => other.promise), callback = vi.fn(() => "next");
    const waiting = gate.run("c", freshSignal(), callback);
    await Promise.resolve(); source.abort();
    expect((await active).error.code).toBe("external-generation-cancelled"); expect(signal.aborted).toBe(true);
    expect(gate.snapshot()).toEqual({ active: 2, queued: 1, closed: false }); expect(callback).not.toHaveBeenCalled();
    ignored.resolve("late success must not replace cancellation"); await Promise.resolve(); await Promise.resolve();
    await expect(waiting).resolves.toBe("next"); other.resolve(); await another; await gate.close();
  });

  it("does not release a cancelled client's slot while that client's adapter still runs", async () => {
    const gate = new ExternalGenerationGate(), source = new AbortController(), ignored = deferred(), callback = vi.fn(() => "second");
    const first = settle(gate.run("same", source.signal, () => ignored.promise));
    const second = gate.run("same", freshSignal(), callback);
    await Promise.resolve(); source.abort(); await first;
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1, closed: false }); expect(callback).not.toHaveBeenCalled();
    ignored.resolve(); await expect(second).resolves.toBe("second"); await gate.close();
  });

  it("close cancels queued and active calls, rejects new work and waits for actual activity to drain", async () => {
    const gate = new ExternalGenerationGate(), release = deferred(), callback = vi.fn();
    let activeSignal!: AbortSignal;
    const active = settle(gate.run("client", freshSignal(), signal => { activeSignal = signal; return release.promise; }));
    const queued = settle(gate.run("client", freshSignal(), callback));
    await Promise.resolve();
    const close = gate.close(); expect(gate.close()).toBe(close);
    let drained = false; void close.then(() => { drained = true; });
    expect((await active).error.code).toBe("external-generation-closed"); expect((await queued).error.code).toBe("external-generation-closed");
    expect(activeSignal.aborted).toBe(true); expect(drained).toBe(false); expect(callback).not.toHaveBeenCalled();
    await expect(gate.run("other", freshSignal(), callback)).rejects.toMatchObject({ code: "external-generation-closed" });
    release.resolve(); await close; expect(drained).toBe(true);
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0, closed: true });
  });

  it("close immediately after admission prevents a late function start", async () => {
    const gate = new ExternalGenerationGate(), callback = vi.fn();
    const admitted = settle(gate.run("client", freshSignal(), callback));
    await gate.close(); expect((await admitted).error.code).toBe("external-generation-closed"); expect(callback).not.toHaveBeenCalled();
  });

  it("releases slots after synchronous errors and asynchronous rejection without poisoning the queue", async () => {
    const gate = new ExternalGenerationGate(), failure = new Error("fixture failure");
    const sync = settle(gate.run("client", freshSignal(), () => { throw failure; }));
    const async = settle(gate.run("client", freshSignal(), async () => { throw failure; }));
    const success = gate.run("client", freshSignal(), () => 42);
    expect((await sync).error).toBe(failure); expect((await async).error).toBe(failure); await expect(success).resolves.toBe(42);
    expect(gate.snapshot().active).toBe(0); await gate.close();
  });

  it("handles late rejection after abort and removes the source listener after completion", async () => {
    const gate = new ExternalGenerationGate(), source = new AbortController(), failure = deferred();
    const result = settle(gate.run("client", source.signal, () => failure.promise));
    await Promise.resolve(); source.abort(); expect((await result).error.code).toBe("external-generation-cancelled");
    failure.reject(new Error("late adapter failure")); await Promise.resolve(); await Promise.resolve();
    const completedSource = new AbortController(); let signal!: AbortSignal;
    await gate.run("client", completedSource.signal, provided => { signal = provided; });
    completedSource.abort(); expect(signal.aborted).toBe(false); await gate.close();
  });

  it("uses exact stable identities without prototype collisions or display-name normalization", async () => {
    const gate = new ExternalGenerationGate(), callback = vi.fn((signal: AbortSignal) => !signal.aborted);
    await expect(Promise.all([gate.run("__proto__", freshSignal(), callback), gate.run("constructor", freshSignal(), callback)])).resolves.toEqual([true, true]);
    for (const client of ["", " ", " client", "client ", "client\nname", "x".repeat(257)])
      await expect(gate.run(client, freshSignal(), callback)).rejects.toMatchObject({ code: "external-generation-invalid-client" });
    expect(callback).toHaveBeenCalledTimes(2); await gate.close();
  });
});
