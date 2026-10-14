export type ExternalGenerationGateErrorCode =
  | "external-generation-invalid-client"
  | "external-generation-cancelled"
  | "external-generation-closed"
  | "external-generation-queue-full"
  | "external-generation-client-queue-full";

export class ExternalGenerationGateError extends Error {
  constructor(public readonly code: ExternalGenerationGateErrorCode) {
    super(code);
    this.name = "ExternalGenerationGateError";
  }
}

type Job = {
  clientId: string;
  state: "queued" | "active" | "finished";
  execute: () => Promise<void>;
  cancel: (code: "external-generation-cancelled" | "external-generation-closed") => void;
};

/** One instance per Vault, shared by authenticated external entry points.
 * A cancelled operation retains its slot until its actual work has stopped;
 * otherwise an adapter that ignores abort could exceed the model-call limit. */
export class ExternalGenerationGate {
  private readonly active = new Set<Job>();
  private readonly activeClients = new Set<string>();
  private queue: Job[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private drained?: () => void;

  snapshot(): Readonly<{ active: number; queued: number; closed: boolean }> {
    return { active: this.active.size, queued: this.queue.length, closed: this.closed };
  }

  /** clientId must come from the authenticated grant, never a payload/display
   * name. fn must pass its provided signal through to the existing model layer. */
  run<T>(clientId: string, sourceSignal: AbortSignal, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    const failure = (code: ExternalGenerationGateErrorCode) => Promise.reject<T>(new ExternalGenerationGateError(code));
    if (typeof clientId !== "string" || !clientId || clientId.length > 256 || clientId !== clientId.trim() || /[\x00-\x1f\x7f]/.test(clientId))
      return failure("external-generation-invalid-client");
    if (sourceSignal.aborted) return failure("external-generation-cancelled");
    if (this.closed) return failure("external-generation-closed");
    if (this.queue.length >= 16) return failure("external-generation-queue-full");
    if (this.queue.filter(job => job.clientId === clientId).length >= 2) return failure("external-generation-client-queue-full");

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const unsubscribe = () => sourceSignal.removeEventListener("abort", aborted);
      const fail = (code: "external-generation-cancelled" | "external-generation-closed") => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new ExternalGenerationGateError(code));
      };
      const job: Job = {
        clientId,
        state: "queued",
        cancel: code => {
          if (job.state === "finished") return;
          fail(code);
          controller.abort(new ExternalGenerationGateError(code));
          if (job.state === "queued") {
            job.state = "finished";
            this.queue = this.queue.filter(candidate => candidate !== job);
            this.pump();
          }
        },
        execute: async () => {
          try {
            // Start in a later microtask, then check again. An immediate abort
            // or close after admission must never initiate a paid model call.
            await Promise.resolve();
            if (this.closed || controller.signal.aborted || sourceSignal.aborted) {
              job.cancel(this.closed ? "external-generation-closed" : "external-generation-cancelled");
              return;
            }
            const value = await fn(controller.signal);
            if (!settled) {
              settled = true;
              unsubscribe();
              resolve(value);
            }
          } catch (error) {
            if (!settled) {
              settled = true;
              unsubscribe();
              reject(error);
            }
          } finally {
            job.state = "finished";
            unsubscribe();
            this.active.delete(job);
            this.activeClients.delete(clientId);
            this.pump();
            this.finishClose();
          }
        },
      };
      const aborted = () => job.cancel("external-generation-cancelled");
      sourceSignal.addEventListener("abort", aborted, { once: true });
      if (sourceSignal.aborted) { job.cancel("external-generation-cancelled"); return; }
      this.queue.push(job);
      this.pump();
    });
  }

  /** Stop admission, cancel queued/active callers, and wait for actual active
   * functions to settle. Does not claim a provider refunded or stopped billing. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>(resolve => { this.drained = resolve; });
    this.closed = true;
    for (const job of [...this.queue, ...this.active]) job.cancel("external-generation-closed");
    this.finishClose();
    return this.closing;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.active.size < 2) {
      // Preserve each client's order, but let another client use a free slot
      // instead of blocking behind work from an already active client.
      const index = this.queue.findIndex(job => !this.activeClients.has(job.clientId));
      if (index < 0) return;
      const job = this.queue.splice(index, 1)[0]!;
      job.state = "active";
      this.active.add(job);
      this.activeClients.add(job.clientId);
      void job.execute();
    }
  }

  private finishClose(): void {
    if (this.closed && this.active.size === 0 && this.queue.length === 0) {
      this.drained?.();
      this.drained = undefined;
    }
  }
}
