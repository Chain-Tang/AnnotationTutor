/** Shared task lifecycle. No host, network, filesystem or model dependencies. */
import type { SurfaceCommitReceipt } from "./tutor-surface.js";
export type TaskState = "queued" | "working" | "input-required" | "completed" | "failed" | "cancelled";
export type TaskTarget = { id: string; source: string; revision: string; surface: "document" | "studio" | "excalidraw" };
export type ContextGrant = { clientId: string; targets: string[]; read: boolean; write: boolean; humanObjectIds: string[]; learningMemory: boolean; onSurfaceCommit?:(receipt:SurfaceCommitReceipt)=>void };
export type TaskArtifact = { id: string; type: "text" | "changes" | "image"; data: unknown };
export type TaskEvent = { sequence: number; at: number; type: "status" | "text" | "preview" | "artifact"; data: unknown };
export type TutorTask = {
  id: string; clientId: string; lead: string; agent: string; parentId?: string; requestKey?: string; target?: TaskTarget;
  state: TaskState; phase: string; createdAt: number; updatedAt: number;
  route?: { engine: string; model: string }; artifacts: TaskArtifact[];
  error?: { code: string; message: string }; children: string[];
  commit?: SurfaceCommitReceipt;
  metrics: { firstFeedbackMs?: number; firstPreviewMs?: number; completedMs?: number; modelCalls: number; toolCalls: number };
};
export type AgentAdapter = {
  id: string;
  capabilities(): Promise<{ vision: boolean; tools: boolean; streaming: boolean }>;
  run(input: { task: TutorTask; prompt: string; context: string; signal: AbortSignal; emit: (event: Omit<TaskEvent, "at" | "sequence">) => void }): Promise<TaskArtifact[]>;
  dispose(): void;
};
type Entry = { task: TutorTask; abort: AbortController; cancelRequested:boolean; events: TaskEvent[]; seen: Set<string>; expires: ReturnType<typeof setTimeout> };
const terminal = (state: TaskState) => ["completed", "failed", "cancelled"].includes(state);

export class TutorTaskCoordinator {
  private paused = false;
  get busy():boolean {return [...this.entries.values()].some(entry=>entry.task.state==="working"||entry.task.state==="queued");}
  reconciliationReceipts():SurfaceCommitReceipt[]{return [...this.entries.values()].filter(({task})=>task.state==="input-required"&&task.commit).map(({task})=>structuredClone(task.commit!));}
  pauseWhenIdle(options:{allowDurableReconciliation?:boolean}={}): void {
    if ([...this.entries.values()].some(({task})=>!terminal(task.state)&&!(options.allowDurableReconciliation&&task.state==="input-required"&&task.commit&&["applied-not-durable","outcome-unknown"].includes(task.commit.durability)))) throw new Error("Tutor tasks are busy");
    this.paused = true;
  }
  resume(): void { if (!this.disposed) this.paused = false; }
  private disposed=false;
  private readonly entries = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();
  private readonly listeners = new Set<(task: TutorTask) => void>();
  constructor(private readonly timeoutMs = 300_000, private readonly maxHistory = 200) {}
  subscribe(listener: (task: TutorTask) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  start(input: { clientId: string; agent?: string; lead?: string; parentId?: string; target?: TaskTarget; key?: string }): TutorTask {
    if(this.disposed || this.paused)throw new Error("task-service-closed");
    const key = input.key ? JSON.stringify([input.clientId, input.key]) : undefined;
    const previous = key ? this.keys.get(key) : undefined;
    if (previous && this.entries.has(previous)) return this.get(previous, input.clientId);
    const parent = input.parentId ? this.require(input.parentId, input.clientId) : undefined;
    const agent = input.agent ?? "tutor";
    if (parent) {
      let cursor: Entry | undefined = parent, depth = 0;
      const ancestry = new Set<string>();
      while (cursor) { ancestry.add(cursor.task.agent); depth++; cursor = cursor.task.parentId ? this.entries.get(cursor.task.parentId) : undefined; }
      if (terminal(parent.task.state) || parent.abort.signal.aborted) throw new Error("parent-task-inactive");
      if (depth > 2 || ancestry.has(agent)) throw new Error("delegation-cycle-or-depth");
      const root = this.root(parent), participants = new Set([...root.seen, agent]);
      if (participants.size > 3) throw new Error("participant-budget-exceeded");
      const active = [...this.entries.values()].filter(e => e !== root && this.root(e) === root && !terminal(e.task.state));
      if (active.length >= 2) throw new Error("parallel-agent-budget-exceeded");
      root.seen.add(agent);
    }
    this.trim();
    if (this.entries.size >= this.maxHistory) throw new Error("task-capacity-exceeded");
    const now = Date.now(), id = crypto.randomUUID();
    const task: TutorTask = { id, clientId: input.clientId, agent, lead: parent?.task.lead ?? input.lead ?? agent,
      ...(input.key ? {requestKey:input.key} : {}), ...(parent ? { parentId: parent.task.id } : {}), ...(input.target ? { target: structuredClone(input.target) } : {}),
      state: "queued", phase: "queued", createdAt: now, updatedAt: now, artifacts: [], children: [], metrics: { modelCalls: 0, toolCalls: 0 } };
    const entry: Entry = { task, abort: new AbortController(), cancelRequested:false, events: [], seen: new Set([agent]),
      expires: setTimeout(() => this.fail(id, input.clientId, "timeout", "Task time budget exceeded"), this.timeoutMs) };
    entry.expires.unref?.();
    this.entries.set(id, entry); if (key) this.keys.set(key, id);
    if (parent) parent.task.children.push(id);
    this.notify(entry); return structuredClone(task);
  }
  /** Restore validated, scoped results only. Never restart an interrupted model call. */
  restore(tasks: readonly TutorTask[]):void {
    const ids=new Set(tasks.map(t=>t.id));
    for(const input of tasks){
      if(this.entries.has(input.id))continue;
      this.trim();if(this.entries.size>=this.maxHistory)break;
      const task=structuredClone(input);
      if(task.commit&&task.commit.durability!=="not-applied"){
        task.state=task.commit.durability==="committed"?"completed":"input-required";
        task.phase=task.commit.durability==="committed"?(input.phase==="committed-after-cancel"?"committed-after-cancel":"completed"):task.commit.durability==="applied-not-durable"?"applied-not-saved":"commit-outcome-unknown";
        if(task.state==="completed")delete task.error;
      }else if(!terminal(task.state)){
        task.state="failed";task.phase="interrupted";task.error={code:"interrupted",message:"任务被中断，未自动重新调用模型。"};task.artifacts=[];
      }
      if(task.parentId&&!ids.has(task.parentId))delete task.parentId;
      task.children=task.children.filter(id=>ids.has(id));
      const abort=new AbortController();abort.abort();const expires=setTimeout(()=>{},0);clearTimeout(expires);
      this.entries.set(task.id,{task,abort,expires,cancelRequested:input.state==="cancelled"||input.phase==="committed-after-cancel",events:[],seen:new Set([task.agent])});
      if(task.requestKey)this.keys.set(JSON.stringify([task.clientId,task.requestKey]),task.id);
    }
  }
  bind(id: string, client: string, target: TaskTarget): void {
    const entry = this.active(id, client);
    if (entry.task.target && (entry.task.target.id !== target.id || entry.task.target.surface !== target.surface || entry.task.target.revision !== target.revision)) throw new Error("task-target-already-bound");
    entry.task.target = structuredClone(target); this.notify(entry);
  }
  signal(id: string, client: string): AbortSignal { return this.require(id, client).abort.signal; }
  get(id: string, client: string): TutorTask { return structuredClone(this.require(id, client).task); }
  list(client: string, offset = 0, limit = 30): TutorTask[] {
    return [...this.entries.values()].filter(e => e.task.clientId === client).reverse().slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit))).map(e => structuredClone(e.task));
  }
  events(id: string, client: string, after = 0): TaskEvent[] { return structuredClone(this.require(id, client).events.filter(e => e.sequence > after)); }
  phase(id: string, client: string, phase: string, route?: TutorTask["route"]): void {
    const e = this.active(id, client); e.task.state = "working"; e.task.phase = phase;
    if (route) e.task.route = { ...route }; this.emit(id, client, { type: "status", data: phase });
  }
  consume(id: string, client: string, kind: "modelCalls" | "toolCalls"): void {
    const e = this.active(id, client), root = this.root(e), max = kind === "modelCalls" ? 12 : 100;
    if (root.task.metrics[kind] >= max) throw new Error(`${kind}-budget-exceeded`);
    root.task.metrics[kind]++; if (e !== root) e.task.metrics[kind]++;
  }
  emit(id: string, client: string, event: Omit<TaskEvent, "at" | "sequence">): void {
    const e = this.active(id, client), now = Date.now();
    if (JSON.stringify(event).length > 65536) throw new Error("task-event-too-large");
    if (e.task.metrics.firstFeedbackMs === undefined) e.task.metrics.firstFeedbackMs = now - e.task.createdAt;
    if (event.type === "preview" && e.task.metrics.firstPreviewMs === undefined) e.task.metrics.firstPreviewMs = now - e.task.createdAt;
    const sequence = (e.events.at(-1)?.sequence ?? 0) + 1;
    e.events.push({ ...structuredClone(event), sequence, at: now });
    if (e.events.length > 128) e.events.shift(); this.notify(e);
  }
  inputRequired(id: string, client: string, message: string): void { const e = this.active(id, client); e.task.state = "input-required"; e.task.phase = message; this.notify(e); }
  propose(id: string, client: string, artifacts: TaskArtifact[]): void {
    const e=this.active(id,client);
    if(artifacts.length>32 || JSON.stringify(artifacts).length>2_000_000)throw new Error("task-artifacts-too-large");
    e.task.artifacts=structuredClone(artifacts);e.task.state="input-required";e.task.phase="draft-ready";this.notify(e);
  }
  complete(id: string, client: string, artifacts: TaskArtifact[] = []): void {
    const e = this.active(id, client);
    if(e.task.commit&&e.task.commit.durability!=="committed"&&e.task.commit.durability!=="not-applied"){
      this.recordSurfaceCommit(e.task.commit,true);return;
    }
    if (e.task.children.some(child => !terminal(this.entries.get(child)!.task.state))) throw new Error("child-task-still-active");
    if (artifacts.length > 32 || JSON.stringify(artifacts).length > 2_000_000) throw new Error("task-artifacts-too-large");
    const committed=e.task.commit?e.task.artifacts.filter(artifact=>artifact.id===e.task.commit!.transactionId&&!artifacts.some(next=>next.id===artifact.id)):[];
    e.task.artifacts = structuredClone([...artifacts,...committed]); this.finish(e, "completed");
  }
  /** Receipts remain authoritative after cancellation. Active local runners can finish their normal conversation with settle=false. */
  recordSurfaceCommit(receipt:SurfaceCommitReceipt,settle=false):void{
    const e=this.entries.get(receipt.requestId);if(!e||e.task.clientId!==receipt.clientId)return;
    if(e.task.target&&e.task.target.id!==receipt.targetId)throw new Error("task-commit-target-mismatch");
    if(e.task.commit&&e.task.commit.transactionId!==receipt.transactionId)throw new Error("task-commit-identity-mismatch");
    e.task.commit=structuredClone(receipt);
    e.task.artifacts=e.task.artifacts.filter(artifact=>artifact.id!==receipt.transactionId);
    e.task.artifacts.push({id:receipt.transactionId,type:"changes",data:{targetId:receipt.targetId,revision:receipt.committedRevision??receipt.appliedRevision,receipt:structuredClone(receipt)}});
    if(settle||e.abort.signal.aborted||terminal(e.task.state)){
      clearTimeout(e.expires);e.task.metrics.completedMs=Date.now()-e.task.createdAt;
      if(receipt.durability==="committed"){
        e.task.state="completed";e.task.phase=e.cancelRequested?"committed-after-cancel":"completed";delete e.task.error;
      }else if(receipt.durability==="not-applied"){
        e.task.state=e.cancelRequested?"cancelled":"failed";e.task.phase=e.task.state;e.task.error={code:"not-applied",message:"Drawing was not applied."};
      }else{
        e.task.state="input-required";e.task.phase=receipt.durability==="applied-not-durable"?"applied-not-saved":"commit-outcome-unknown";
        e.task.error={code:receipt.durability,message:receipt.durability==="applied-not-durable"?"Drawing is applied but not confirmed saved. Inspect it before retrying only the save.":"Drawing outcome requires reconciliation. Do not repeat generation or insertion."};
      }
    }
    this.notify(e);
  }
  fail(id: string, client: string, code: string, message: string): void {
    const e = this.require(id, client); if (terminal(e.task.state)) return;
    if(e.task.commit&&e.task.commit.durability!=="not-applied"){e.abort.abort();this.recordSurfaceCommit(e.task.commit,true);return;}
    for (const child of e.task.children) this.cancel(child, client);
    e.task.error = { code, message }; this.finish(e, "failed"); e.abort.abort();
  }
  cancel(id: string, client: string): void {
    const e = this.require(id, client); if (terminal(e.task.state)) return;
    e.cancelRequested=true;
    for (const child of e.task.children) this.cancel(child, client);
    if(e.task.commit&&e.task.commit.durability!=="not-applied"){e.abort.abort();this.recordSurfaceCommit(e.task.commit,true);return;}
    this.finish(e, "cancelled"); e.abort.abort();
  }
  cancelAll(client?:string):void{for(const e of this.entries.values())if(!client||e.task.clientId===client)this.cancel(e.task.id,e.task.clientId);}
  dispose(): void { this.disposed=true; for (const e of this.entries.values()) { this.cancel(e.task.id,e.task.clientId); clearTimeout(e.expires); } this.keys.clear(); this.listeners.clear(); }
  private root(entry: Entry): Entry { let e = entry; while (e.task.parentId) e = this.entries.get(e.task.parentId)!; return e; }
  private require(id: string, client: string): Entry { const e = this.entries.get(id); if (!e || e.task.clientId !== client) throw new Error("task-not-found"); return e; }
  private active(id: string, client: string): Entry { const e = this.require(id, client); if (terminal(e.task.state) || e.abort.signal.aborted) throw new Error("task-inactive"); return e; }
  private notify(e: Entry): void { e.task.updatedAt = Date.now(); for (const listener of this.listeners) { try { listener(structuredClone(e.task)); } catch { /* Observers cannot change execution outcomes. */ } } }
  private finish(e: Entry, state: TaskState): void { clearTimeout(e.expires); e.task.state = state; e.task.phase = state; e.task.metrics.completedMs = Date.now() - e.task.createdAt; this.notify(e); }
  private trim(): void {
    if (this.entries.size < this.maxHistory) return;
    for (const [id, e] of this.entries) {
      if (!e.task.parentId && terminal(e.task.state)) {
        const remove = (key: string) => { const item = this.entries.get(key); for (const child of item?.task.children ?? []) remove(child); this.entries.delete(key); };
        remove(id); for (const [key, value] of this.keys) if (!this.entries.has(value)) this.keys.delete(key);
        if (this.entries.size < this.maxHistory) break;
      }
    }
  }
}

/** Serializes commits by canonical target; rejected commits never poison the queue. */
export class TargetCommitQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(target) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.tails.set(target, next);
    void next.finally(() => { if (this.tails.get(target) === next) this.tails.delete(target); }).catch(() => {});
    return next;
  }
}
