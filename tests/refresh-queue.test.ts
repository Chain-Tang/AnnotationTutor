import { describe, expect, it, vi } from "vitest";
import { GenerationRefreshQueue } from "../src/refresh-queue.js";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("generation refresh queue", () => {
  it("merges ten same-tick requests into one round and gives every caller its result", async () => {
    const execute = vi.fn(async (request: number) => request);
    const queue = new GenerationRefreshQueue((left: number, right: number) => left + right, execute);
    expect(await Promise.all(Array.from({ length: 10 }, () => queue.request(1)))).toEqual(Array(10).fill(10));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("merges requests during a round into one later generation without resolving them early", async () => {
    const first = barrier<number>(), second = barrier<number>();
    const execute = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const queue = new GenerationRefreshQueue((left: number, right: number) => left + right, execute);
    const original = queue.request(1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let completed = 0;
    const pending = Array.from({ length: 10 }, () => queue.request(1).then(result => { completed++; return result; }));
    first.resolve(1); expect(await original).toBe(1);
    expect(completed).toBe(0); expect(execute).toHaveBeenLastCalledWith(10);
    second.resolve(2); expect(await Promise.all(pending)).toEqual(Array(10).fill(2));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects the affected generation, then drains and accepts newer requests", async () => {
    const first = barrier<number>();
    const execute = vi.fn().mockImplementationOnce(async () => { await first.promise; throw new Error("write failed"); }).mockResolvedValue(2);
    const queue = new GenerationRefreshQueue((left: number, right: number) => left + right, execute);
    const failed = expect(queue.request(1)).rejects.toThrow("write failed");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const retry = queue.request(2);
    first.resolve(1); await failed;
    expect(await retry).toBe(2); expect(await queue.request(3)).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
