/** A service stops accepting work synchronously and drains the actual work,
 * including adapters which finish a write after cancellation. */
export class ServiceWork {
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private stopping?: Promise<void>;
  get closed(): boolean { return this.abort.signal.aborted; }
  get signal(): AbortSignal { return this.abort.signal; }
  assertOpen(): void { if (this.closed) throw new Error("service-stopped"); }
  run<T>(source: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("service-stopped"));
    if (source?.aborted) return Promise.reject(source.reason ?? new DOMException("Cancelled", "AbortError"));
    const abort = new AbortController(), cancel = () => abort.abort(source?.aborted ? source.reason : this.abort.signal.reason);
    source?.addEventListener("abort", cancel, { once: true });
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    const promise = Promise.resolve().then(() => { this.assertOpen(); abort.signal.throwIfAborted(); return work(abort.signal); });
    this.pending.add(promise);
    const finished = () => { this.pending.delete(promise); source?.removeEventListener("abort", cancel); this.abort.signal.removeEventListener("abort", cancel); };
    void promise.then(finished, finished);
    return promise;
  }
  close(): Promise<void> {
    if (!this.stopping) {
      this.abort.abort(new Error("service-stopped"));
      this.stopping = (async () => { while (this.pending.size) await Promise.allSettled([...this.pending]); })();
    }
    return this.stopping;
  }
}
