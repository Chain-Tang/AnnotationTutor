import { describe, expect, it, vi } from "vitest";
import { TranslationRequestQueue } from "../src/translation-request-queue.js";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("translation request FIFO", () => {
  it("runs every producer through one bounded FIFO", async () => {
    const queue = new TranslationRequestQueue(() => 2), starts: number[] = [];
    const gates = Array.from({ length: 5 }, () => barrier<number>());
    const pending = gates.map((gate, i) => queue.run(new AbortController().signal, async () => { starts.push(i); return gate.promise; }));
    expect(starts).toEqual([0, 1]);
    gates[1]!.resolve(1); await tick(); expect(starts).toEqual([0, 1, 2]);
    gates[0]!.resolve(0); await tick(); expect(starts).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve(2); gates[3]!.resolve(3); await tick(); expect(starts).toEqual([0, 1, 2, 3, 4]);
    gates[4]!.resolve(4); expect(await Promise.all(pending)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps an uncooperative aborted transport's permit until it really settles", async () => {
    const queue = new TranslationRequestQueue(() => 1), controller = new AbortController(), gate = barrier<number>();
    const first = queue.run(controller.signal, () => gate.promise), rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = vi.fn(async () => 2), next = queue.run(new AbortController().signal, second);
    controller.abort(); await rejected; expect(second).not.toHaveBeenCalled();
    gate.resolve(1); expect(await next).toBe(2); expect(second).toHaveBeenCalledOnce();
  });

  it("removes aborted queued work without disturbing other files", async () => {
    const queue = new TranslationRequestQueue(() => 1), gate = barrier<number>(), controller = new AbortController();
    const first = queue.run(new AbortController().signal, () => gate.promise);
    const cancelled = vi.fn(async () => 2), other = vi.fn(async () => 3);
    const rejected = expect(queue.run(controller.signal, cancelled)).rejects.toMatchObject({ name: "AbortError" });
    const pending = queue.run(new AbortController().signal, other); controller.abort(); await rejected;
    gate.resolve(1); await first; expect(await pending).toBe(3); expect(cancelled).not.toHaveBeenCalled();
  });

  it("honors a reduced limit and stops queued work when disposed", async () => {
    let limit = 2;
    const queue = new TranslationRequestQueue(() => limit), gates = [barrier<number>(), barrier<number>()];
    const first = gates.map(gate => queue.run(new AbortController().signal, () => gate.promise));
    limit = 1;
    const execute = vi.fn(async () => 3), pending = queue.run(new AbortController().signal, execute);
    gates[0]!.resolve(1); await tick(); expect(execute).not.toHaveBeenCalled();
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }); queue.dispose(); await rejected;
    gates[1]!.resolve(2); expect(await Promise.allSettled(first)).toHaveLength(2); expect(execute).not.toHaveBeenCalled();
    await expect(queue.run(new AbortController().signal, execute)).rejects.toMatchObject({ name: "AbortError" });
  });
});
