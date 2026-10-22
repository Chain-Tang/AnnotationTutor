type Waiter<T> = { resolve(value: T): void; reject(error: unknown): void };

/** Coalesce queued requests, but never let a caller observe a generation that
 * began before its request. Durable work inside a running round is not skipped. */
export class GenerationRefreshQueue<Request, Result> {
  private pending?: { request: Request; waiters: Waiter<Result>[] };
  private running = false;

  constructor(
    private readonly merge: (left: Request, right: Request) => Request,
    private readonly execute: (request: Request) => Promise<Result>
  ) {}

  request(request: Request): Promise<Result> {
    const result = new Promise<Result>((resolve, reject) => {
      if (this.pending) {
        this.pending.request = this.merge(this.pending.request, request);
        this.pending.waiters.push({ resolve, reject });
      } else this.pending = { request, waiters: [{ resolve, reject }] };
    });
    if (!this.running) {
      this.running = true;
      void Promise.resolve().then(() => this.drain());
    }
    return result;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const round = this.pending;
      this.pending = undefined;
      try {
        const result = await this.execute(round.request);
        for (const waiter of round.waiters) waiter.resolve(result);
      } catch (error) {
        for (const waiter of round.waiters) waiter.reject(error);
      }
    }
    this.running = false;
  }
}
