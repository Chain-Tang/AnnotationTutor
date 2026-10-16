const cancelled = () => new DOMException("Translation cancelled", "AbortError");
type Request<T> = {
  signal: AbortSignal;
  execute(): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  abort(): void;
  started: boolean;
};

/** One FIFO for all files and both live/background translation. An aborted
 * transport still holds its permit until it really settles. */
export class TranslationRequestQueue {
  private pending: Request<unknown>[] = [];
  private active = 0;
  private disposed = false;

  constructor(private readonly concurrency: () => number) {}

  run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    if (this.disposed || signal.aborted) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const request: Request<T> = { signal, execute, resolve, reject, started: false, abort: () => {
        if (!request.started) this.pending = this.pending.filter(item => item !== request);
        reject(cancelled());
      } };
      signal.addEventListener("abort", request.abort, { once: true });
      this.pending.push(request as Request<unknown>);
      this.drain();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.pending.splice(0)) {
      request.signal.removeEventListener("abort", request.abort);
      request.reject(cancelled());
    }
  }

  private drain(): void {
    if (this.disposed) return;
    const configured = this.concurrency();
    const limit = Number.isFinite(configured) ? Math.max(1, Math.min(2, Math.floor(configured))) : 1;
    while (!this.disposed && this.active < limit && this.pending.length) {
      const request = this.pending.shift()!;
      if (request.signal.aborted) { request.abort(); continue; }
      request.started = true;
      this.active++;
      let result: Promise<unknown>;
      try { result = request.execute(); } catch (error) { result = Promise.reject(error); }
      void Promise.resolve(result).then(
        value => { if (!request.signal.aborted && !this.disposed) request.resolve(value); else request.reject(cancelled()); },
        error => request.reject(error)
      ).then(() => {
        request.signal.removeEventListener("abort", request.abort);
        this.active--;
        this.drain();
      });
    }
  }
}
