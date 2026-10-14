/** Fixed labels keep startup diagnostics free of settings, paths and error text. */
export type StartupStage = "onload" | "settings" | "credentials" | "surface-journal" |
  "core-services" | "chat-history" | "learning" | "support" | "tutor-results" |
  "registrations" | "layout-initialize" | "layout-board-sync" | "custom-skins";

export type StartupDiagnostic = Readonly<{
  stage: StartupStage;
  status: "running" | "ready" | "failed" | "cancelled";
  elapsedMs: number;
}>;

type Timing = { stage: StartupStage; startedAt: number; status: StartupDiagnostic["status"]; elapsedMs: number };

export class StartupCancelled extends Error {
  public constructor() { super("startup-cancelled"); }
}

/** Durable IO runs to completion; cancelled lifetimes cannot publish its result. */
export class StartupLifetime {
  private cancelled = false;
  public get active(): boolean { return !this.cancelled; }
  public cancel(): void { this.cancelled = true; }
  public assertActive(): void { if (this.cancelled) throw new StartupCancelled(); }

  public async waitFor<T>(run: () => T | Promise<T>, cleanup?: () => void | Promise<void>): Promise<T> {
    this.assertActive();
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (!this.active) {
        await cleanup?.();
        throw new StartupCancelled();
      }
      throw error;
    }
    if (!this.active) {
      await cleanup?.();
      throw new StartupCancelled();
    }
    return result;
  }
}

/** Plugin-local, bounded and memory-only; snapshots never expose mutable records. */
export class StartupTimings {
  private readonly records: Timing[] = [];

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public begin(stage: StartupStage): (status?: "ready" | "failed" | "cancelled") => void {
    const record: Timing = { stage, startedAt: this.now(), status: "running", elapsedMs: 0 };
    this.records.push(record);
    if (this.records.length > 32) this.records.shift();
    return (status = "ready") => {
      if (record.status !== "running") return;
      record.elapsedMs = Math.max(0, this.now() - record.startedAt);
      record.status = status;
    };
  }

  public async measure<T>(stage: StartupStage, run: () => T | Promise<T>): Promise<T> {
    const finish = this.begin(stage);
    try {
      const result = await run();
      finish();
      return result;
    } catch (error) {
      finish(error instanceof StartupCancelled ? "cancelled" : "failed");
      throw error;
    }
  }

  public snapshot(): readonly StartupDiagnostic[] {
    const now = this.now();
    return this.records.map(record => ({
      stage: record.stage,
      status: record.status,
      elapsedMs: record.status === "running" ? Math.max(0, now - record.startedAt) : record.elapsedMs,
    }));
  }

  public failRunning(): void {
    this.finishRunning("failed");
  }

  public cancelRunning(): void {
    this.finishRunning("cancelled");
  }

  private finishRunning(status: "failed" | "cancelled"): void {
    const now = this.now();
    for (const record of this.records) {
      if (record.status !== "running") continue;
      record.elapsedMs = Math.max(0, now - record.startedAt);
      record.status = status;
    }
  }
}

type IdleScheduler = (run: () => void) => () => void;

function scheduleIdle(run: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function" && typeof globalThis.cancelIdleCallback === "function") {
    const id = globalThis.requestIdleCallback(run, { timeout: 1000 });
    return () => globalThis.cancelIdleCallback(id);
  }
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
}

/** Cancel optional layout-ready work on unload, including already-queued callbacks. */
export class StartupIdleTasks {
  private disposed = false;
  private readonly pending = new Set<() => void>();

  public constructor(private readonly schedule: IdleScheduler = scheduleIdle) {}

  public defer(run: () => void): void {
    if (this.disposed) return;
    let cancel: (() => void) | undefined;
    let completed = false;
    cancel = this.schedule(() => {
      completed = true;
      if (cancel) this.pending.delete(cancel);
      if (!this.disposed) run();
    });
    if (!completed) this.pending.add(cancel);
  }

  public dispose(): void {
    this.disposed = true;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
  }
}
