import { TutorTaskCoordinator, type TaskTarget, type TutorTask } from "./tutor-task.js";
import { AIExecutionError, type AIExecutionFailure } from "./ai-execution.js";
import type { BoardConnection } from "./board-connection.js";
import { requestsDrawing } from "./board-drawing-intent.js";
import { requestsDocumentEdit } from "./intent.js";
import { ImageContentRefusal } from "./board-image-error.js";
import type { AcpCommand, AcpStreamEvent } from "./acp-session.js";
import type { ChatLog } from "./model.js";
import type { ReferencePaintStyle } from "./board-reference-style.js";
import type { TutorDrawingPlan } from "./tutor-intent.js";
import { SurfaceCommitError, type SurfaceCommitReceipt } from "./tutor-surface.js";
import { surfaceReceiptSchema } from "./surface-transaction-journal.js";
import { z } from "zod";
import type { LearningTurnIdentity } from "./learning-control-v3.js";

export type TutorHistoryMessage = { role: "user" | "assistant"; content: string };
export type TutorMode = "ask" | "plan" | "build";
/** Explicit note edits keep the existing edit/diff flow; visual requests target the open board. */
export function tutorRouteForText(text: string, context: { mode: TutorMode; pinned: boolean; hasBoard: boolean }): "auto" | "board" | "chat" {
  if (context.pinned || context.mode !== "ask") return "chat";
  if(requestsDocumentEdit(text))return "chat";
  const drawing = requestsDrawing(text);
  if (context.hasBoard && drawing) return "board";
  return "auto";
}

export type TutorMessage = {
  id: string;
  taskId?: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  status: "streaming" | "complete" | "stopped";
  boardId: string | null;
  metadata?: unknown;
  execution?: BoardConnection;
  events: AcpStreamEvent[];
};
export type TutorSubmitOptions = {
  learningRequestId?: string;
  learningTurn?: LearningTurnIdentity;
  /** Opaque local-host drawing/evidence capability; external JSON cannot mint it. */
  learningDrawing?: object;
  resolveIntent?: boolean;
  requiresDrawing?: boolean;
  drawingPlan?: TutorDrawingPlan;
  boardInstruction?: string;
  referencePath?: string;
  source?: "chat" | "board";
  boardId?: string;
  route?: "auto" | "board" | "chat";
  key?: string;
  mode?: TutorMode;
  context?: unknown;
  metadata?: unknown;
};
export type TutorBoardRunner = {
  id: string;
  sourcePath: string;
  target?: () => TaskTarget | Promise<TaskTarget>;
  connection?: () => BoardConnection;
  canAuto?: () => boolean;
  isAvailable?: () => boolean;
  run: (instruction: string, history: TutorHistoryMessage[], onReply: (delta: string) => boolean | void,
    signal: AbortSignal, referencePath?: string, requiresDrawing?: boolean, drawingPlan?: TutorDrawingPlan) => Promise<{ text: string }>;
};
export type TutorRunnerInput = {
  text: string;
  history: TutorHistoryMessage[];
  /** Number of settled transcript messages omitted before the bounded history. */
  historyOffset: number;
  signal: AbortSignal;
  options: TutorSubmitOptions;
  /** Reserve budget before another model call in this turn. The runner still
   * enforces its own retry limit; cancelled or completed turns cannot reserve. */
  consumeAdditionalModelCall?: () => void;
  onReply: (delta: string) => boolean | void;
  onEvent: (event: AcpStreamEvent) => void;
};
export type TutorBoardRunInput = TutorRunnerInput & {
  taskId: string;
  /** Snapshot of the target already bound to this task, never a later active view. */
  target: Readonly<TaskTarget>;
};
export type TutorConversationState = {
  taskStatus?: "running" | "complete" | "failed" | "cancelled" | "blocked" | "reconciliation";
  taskId?: string;
  commit?: SurfaceCommitReceipt;
  requestToEdit?: string;
  canRetry?: boolean;
  history: readonly TutorMessage[];
  latestReply: string;
  latestBoardId: string | null;
  busy: boolean;
  error: string | null;
  failure?: AIExecutionFailure;
  execution?: BoardConnection;
  sidebarVisible: boolean;
  activeBoardId: string | null;
  commands: readonly AcpCommand[];
};
type DrawingRetryBinding = { target: TaskTarget; runner: TutorBoardRunner; hasStableTarget: boolean };
type ConversationAttempt = { text: string; options: TutorSubmitOptions; signal: AbortSignal; settled: boolean; boardStarted: boolean; drawing?: DrawingRetryBinding; retryInvalid?: boolean };

type ConversationHost = {
  onActivity?:()=>void;
  tasks?: TutorTaskCoordinator;
  prepare?: (text:string, options:TutorSubmitOptions, history:TutorHistoryMessage[], signal:AbortSignal)=>Promise<TutorSubmitOptions>;
  run: (input: TutorRunnerInput) => Promise<{ text: string }>;
  /** Prepare host-owned state before any board preview. run is bound to this
   * task and runs at most once, even if the wrapper calls it again after failure. */
  withBoardRun?: (input: TutorBoardRunInput, run: () => Promise<{ text: string }>) => Promise<{ text: string }>;
  reset?: () => void;
  recoverConnection?: () => Promise<void>;
  openConnectionSettings?: () => void;
  /** Reads local drawing metadata from the fixed-vault journal, never a model. */
  restoreDrawingTasks?: (taskIds:readonly string[])=>Promise<TutorTask[]>;
  boardUpdateLabel?: () => string;
  emptyReplyLabel?: () => string;
  persist?: (messages: readonly TutorMessage[], mode: TutorMode, log: ChatLog | null) => Promise<ChatLog | null>;
};

/** The conversation outlives its views. Closing a sidebar only removes a subscriber. */
export class TutorConversation {
  private messages: TutorMessage[] = [];
  private failure?: AIExecutionFailure;
  private execution?: BoardConnection;
  private listeners = new Set<(state: TutorConversationState) => void>();
  private boards = new Map<string, TutorBoardRunner>();
  private sidebars = new Map<string, { visible: boolean; document?: Document }>();
  private current: { taskId: string; id: number; abort: AbortController; boardId: string | null; key?: string; promise: Promise<void> } | null = null;
  private sequence = 0;
  private restoreSequence = 0;
  private restoredCommits = new Map<string,SurfaceCommitReceipt>();
  private latest = "";
  private latestBoard: string | null = null;
  private activeBoard: string | null = null;
  private error: string | null = null;
  private taskStatus: TutorConversationState["taskStatus"];
  private lastAttempt: ConversationAttempt | null = null;
  private commands: AcpCommand[] = [];
  private persistence = Promise.resolve();
  private persistenceSession: { log: ChatLog | null } = { log: null };
  public get log(): ChatLog | null { return this.persistenceSession.log; }
  public set log(log: ChatLog | null) { this.persistenceSession.log = log; }
  public mode: TutorMode = "ask";
  public conversationId = crypto.randomUUID();

  public readonly tasks: TutorTaskCoordinator;
  constructor(private readonly host: ConversationHost) { this.tasks = host.tasks ?? new TutorTaskCoordinator(); }

  get state(): TutorConversationState {
    const taskId=this.messages.find(message=>message.id===`${this.sequence}-assistant`)?.taskId;
    let commit:SurfaceCommitReceipt|undefined;
    if(taskId){try{commit=this.tasks.get(taskId,"obsidian").commit;}catch{/* The bounded task history may no longer retain this turn. */}commit??=this.restoredCommits.get(taskId);}
    return { history: this.messages, latestReply: this.latest, latestBoardId: this.latestBoard,
      busy: this.current !== null, error: this.error, failure: this.failure, execution: this.execution, sidebarVisible: this.isSidebarVisible(),
      activeBoardId: this.activeBoard, commands: this.commands, taskStatus: this.taskStatus, taskId, commit,
      requestToEdit: this.taskStatus === "blocked" ? this.lastAttempt?.text : undefined,
      canRetry: !this.current && this.failure?.retryable !== false && !!this.lastAttempt && !this.lastAttempt.retryInvalid &&
        (!this.lastAttempt.boardStarted || this.lastAttempt.settled) && (this.taskStatus === "failed" || this.taskStatus === "cancelled") };
  }
  subscribe(listener: (state: TutorConversationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { const state = this.state; for (const listener of this.listeners) listener(state); }
  setSidebarVisible(id: string, visible: boolean, document?: Document): void {
    const previous = this.sidebars.get(id);
    if (previous?.visible === visible && previous.document === document) return;
    if (visible) this.sidebars.set(id, { visible, document }); else this.sidebars.delete(id);
    this.emit();
  }
  isSidebarVisible(document?: Document): boolean {
    return [...this.sidebars.values()].some(view => view.visible && (!document || view.document === document));
  }
  setCommands(commands: AcpCommand[]): void { this.commands = commands; this.emit(); }
  registerBoard(runner: TutorBoardRunner): () => void {
    this.boards.set(runner.id, runner);
    this.activateBoard(runner.id);
    return () => {
      if (this.boards.get(runner.id) !== runner) return;
      this.cancelForBoard(runner.id);
      this.boards.delete(runner.id);
      if (this.activeBoard === runner.id) this.activeBoard = null;
      this.emit();
    };
  }
  activateBoard(id: string): void {
    if (!this.boards.has(id) || this.activeBoard === id) return;
    this.activeBoard = id; this.emit();
  }
  deactivateBoard(): void {
    if (this.activeBoard === null) return;
    this.activeBoard = null; this.emit();
  }
  hasBoard(): boolean {
    const board = this.activeBoard ? this.boards.get(this.activeBoard) : undefined;
    return !!board && (board.isAvailable?.() ?? true);
  }
  private pickBoard(options: TutorSubmitOptions): TutorBoardRunner | undefined {
    if (options.route === "chat") return undefined;
    const id = options.boardId ?? this.activeBoard;
    const board = id ? this.boards.get(id) : undefined;
    if (!board || !(board.isAvailable?.() ?? true)) return undefined;
    if (options.route === "board") return board;
    return (options.mode ?? this.mode) === "ask" && (board.canAuto?.() ?? false) ? board : undefined;
  }
  get activeTask(){return this.current?this.tasks.get(this.current.taskId,"obsidian"):undefined;}
  submit(text: string, options: TutorSubmitOptions = {}): Promise<void> { return this.start(text, options); }
  private start(text: string, options: TutorSubmitOptions, retry?: DrawingRetryBinding): Promise<void> {
    if (!text.trim() && options.source !== "board") return Promise.resolve();
    if(text.trim())this.host.onActivity?.();
    // Explicit board text/quick-input requests use the same semantic workflow
    // choice as sidebar messages. Passive observations and saved-image replay do not.
    if (this.host.prepare && text.trim() && options.source === "board" && !options.referencePath &&
      !options.drawingPlan && options.resolveIntent !== false)
      options = { ...options, resolveIntent: true };
    if (this.current && options.key && options.key === this.current.key) return this.current.promise;
    // Automatic observations never interrupt a learner's explicit question.
    if (this.current && options.source === "board" && !text.trim()) return Promise.resolve();
    this.cancel();
    const preparingIntent = !!(options.resolveIntent && this.host.prepare);
    // An inactive split may still be the registered board. Do not bind this
    // turn to it before semantic resolution chooses the source document.
    let board = preparingIntent ? undefined : this.pickBoard(options);
    if (options.route === "board" && !board && !(options.resolveIntent && this.host.prepare)) {
      this.error = "board-unavailable"; this.emit(); return Promise.resolve();
    }
    options = {...options, learningRequestId: options.learningRequestId ?? crypto.randomUUID()};
    this.mode = options.mode ?? this.mode;
    const id = ++this.sequence;
    const abort = new AbortController();
    // Stopped replies may already have shown a hint or part of an explanation.
    // Keeping only the completed user request loses that presentation and can
    // make the next turn look like the previous request is still unanswered.
    // This is a transport projection only: don't rewrite the visible transcript
    // or mistake an interrupted fragment for a completed response/commit.
    const settled = this.messages.filter(m => m.status !== "streaming");
    const historyOffset = Math.max(0, settled.length - 40);
    const prior: TutorHistoryMessage[] = settled.slice(historyOffset)
      .map(message => ({ role: message.role, content: message.status === "stopped"
        ? `[This earlier response was interrupted. Only the following fragment was displayed; do not resume its request unless the latest user message asks to continue it.]\n${message.text}`
        : message.text }));
    const boardId = board?.id ?? null;
    const attempt: ConversationAttempt = {text, signal: abort.signal, settled:false, boardStarted:false, drawing:retry,
      options: {...options, ...(board ? {boardId: board.id, route: "board" as const} : {}), key: undefined}};
    this.lastAttempt = text.trim() ? attempt : null;
    this.taskStatus = "running";
    const now = new Date().toISOString();
    this.messages.push({ id: `${id}-user`, role: "user", text: text.trim() || this.host.boardUpdateLabel?.() || "Board updated",
      at: now, status: "complete", boardId, events: [] });
    const assistant: TutorMessage = { id: `${id}-assistant`, role: "assistant", text: "", at: now,
      status: "streaming", boardId, metadata: options.metadata, events: [] };
    this.messages.push(assistant);
    this.latest = ""; this.latestBoard = preparingIntent ? null : boardId ?? (this.hasBoard() ? this.activeBoard : null); this.error = null; this.failure=undefined; this.execution=undefined;
    const task = this.tasks.start({ clientId: "obsidian", lead: "tutor" });
    assistant.taskId=task.id;
    this.messages.find(message=>message.id===`${id}-user`)!.taskId=task.id;
    const active = { taskId: task.id, id, abort, boardId, key: options.key, promise: Promise.resolve() };
    this.current = active;
    const taskSignal = this.tasks.signal(task.id, "obsidian");
    const cancelTask = () => { if (this.current === active) this.cancel(); };
    taskSignal.addEventListener("abort", cancelTask, { once: true });
    const unsubscribeCommit = this.tasks.subscribe(next => {
      if (next.id === task.id && next.commit && (abort.signal.aborted || this.current !== active || next.state === "input-required"))
        this.showCommitOutcome(active, assistant, next.commit, false);
    });
    this.tasks.phase(task.id, "obsidian", preparingIntent ? "classifying" : "starting");
    this.save(); this.emit();
    const onReply = (delta: string): boolean => {
      if (this.current !== active || abort.signal.aborted) return false;
      this.tasks.emit(task.id, "obsidian", { type: "text", data: { length: delta.length } });
      assistant.text += delta;
      this.latest = assistant.text;
      this.emit();
      return true;
    };
    const onEvent = (event: AcpStreamEvent): void => {
      if (this.current !== active || abort.signal.aborted) return;
      assistant.events.push(event); this.emit();
    };
    active.promise = (async () => {
      try {
        if(options.resolveIntent && this.host.prepare){
          this.tasks.consume(task.id, "obsidian", "modelCalls");
          options=await this.host.prepare(text,options,prior,abort.signal);
          if(this.current!==active || abort.signal.aborted)return;
          board=this.pickBoard(options);
          if(options.route==="board"&&!board)throw new Error("board-unavailable");
          active.boardId=board?.id??null;assistant.boardId=active.boardId;
          const user=this.messages.find(m=>m.id===`${id}-user`);if(user)user.boardId=active.boardId;
          this.latestBoard=active.boardId;
          if(this.lastAttempt===attempt)attempt.options={...options,key:undefined};
          this.emit();
        }
        if (board) {
          const target=board.target?.();
          // A synchronous target must not introduce a microtask gap before the
          // board runner marks font/layout updates as part of request preparation.
          const bound=target instanceof Promise?await target:target??{id:board.id,source:board.sourcePath,revision:"runner-managed",surface:"document" as const};
          if(this.current!==active||abort.signal.aborted)throw new DOMException("Board turn cancelled","AbortError");
          if(this.boards.get(board.id)!==board||board.isAvailable?.()===false)throw new Error("board-unavailable");
          if(retry&&(bound.id!==retry.target.id||bound.surface!==retry.target.surface||bound.revision!==retry.target.revision||
            (!retry.hasStableTarget&&(board!==retry.runner||bound.source!==retry.target.source)))){
            attempt.retryInvalid=true;
            throw new Error("绘图目标或内容已变化，请重新发送要求；本次重试没有修改画板。");
          }
          this.tasks.bind(task.id,"obsidian",bound);
          attempt.drawing=retry??{target:structuredClone(bound),runner:board,hasStableTarget:!!board.target};
        }
        this.execution=board?.connection?.(); assistant.execution=this.execution;
        this.tasks.phase(task.id, "obsidian", board ? "drawing" : "answering", this.execution); this.emit();
        let result:{text:string};
        if(board && this.host.withBoardRun){
          const selected=board,bound=this.tasks.get(task.id,"obsidian").target;
          if(!bound)throw new Error("board-target-unavailable");
          const capturedOptions={...options};
          let execution:Promise<{text:string}>|undefined;
          const run=():Promise<{text:string}>=>{
            if(execution)return execution;
            // Install the promise before invoking the runner, so even a
            // synchronous/reentrant wrapper cannot cause a second drawing.
            let resolve!:(value:{text:string})=>void,reject!:(reason:unknown)=>void;
            execution=new Promise((done,fail)=>{resolve=done;reject=fail;});
            try{
              if(this.current!==active||abort.signal.aborted)throw new DOMException("Board turn cancelled","AbortError");
              if(this.boards.get(selected.id)!==selected||selected.isAvailable?.()===false)throw new Error("board-unavailable");
              this.tasks.consume(task.id,"obsidian","modelCalls");
              attempt.boardStarted=true;
              Promise.resolve(selected.run(capturedOptions.boardInstruction??text,prior,onReply,abort.signal,capturedOptions.referencePath,capturedOptions.requiresDrawing,capturedOptions.drawingPlan)).then(resolve,reject);
            }catch(error){reject(error);}
            return execution;
          };
          result=await this.host.withBoardRun({text,history:prior,historyOffset,signal:abort.signal,options:{...capturedOptions},onReply,onEvent,taskId:task.id,target:Object.freeze(bound)},run);
        }else{
          this.tasks.consume(task.id, "obsidian", "modelCalls");
          if(board)attempt.boardStarted=true;
          const consumeAdditionalModelCall=():void=>{
            if(this.current!==active||abort.signal.aborted)throw new DOMException("Tutor turn cancelled","AbortError");
            this.tasks.consume(task.id,"obsidian","modelCalls");
          };
          result=await (board ? board.run(options.boardInstruction ?? text, prior, onReply, abort.signal, options.referencePath, options.requiresDrawing, options.drawingPlan)
            : this.host.run({ text, history: prior, historyOffset, signal: abort.signal, options, consumeAdditionalModelCall, onReply, onEvent }));
        }
        if (this.current !== active || abort.signal.aborted) {
          this.showCommitOutcome(active, assistant);
          return;
        }
        const commit = this.tasks.get(task.id, "obsidian").commit;
        if (commit && commit.durability !== "committed" && this.showCommitOutcome(active, assistant, commit)) return;
        this.taskStatus = "complete";
        const reply = result.text || assistant.text;
        if (!reply.trim()) {
          // An automatic board observation is allowed to decide that no change
          // is useful. It must not leave a synthetic user turn and an empty
          // assistant bubble in the shared transcript.
          if (options.source === "board" && !text.trim()) {
            this.messages = this.messages.filter(message =>
              message.id !== `${id}-user` && message.id !== assistant.id);
            const previous = [...this.messages].reverse().find(message =>
              message.role === "assistant" && message.status === "complete");
            this.latest = previous?.text ?? "";
            this.latestBoard = previous?.boardId ?? null;
            this.tasks.complete(task.id, "obsidian");
            return;
          }
          throw new Error(this.host.emptyReplyLabel?.() || "The model returned no reply.");
        }
        assistant.text = reply;
        assistant.status = "complete";
        this.tasks.complete(task.id, "obsidian");
        this.latest = assistant.text;
      } catch (error) {
        // A native save can finish after Stop has detached this runner. Its
        // precise receipt still belongs to the old bubble, never a newer turn.
        if (error instanceof SurfaceCommitError && error.result.receipt.requestId === task.id && error.result.receipt.clientId === "obsidian")
          this.tasks.recordSurfaceCommit(error.result.receipt, true);
        if (this.showCommitOutcome(active, assistant)) return;
        if (this.current !== active || abort.signal.aborted) return;
        taskSignal.removeEventListener("abort", cancelTask);
        const cancelled = error instanceof Error && error.name === "AbortError";
        if (cancelled) this.tasks.cancel(task.id, "obsidian");
        else this.tasks.fail(task.id, "obsidian", "execution-failed", "Tutor execution failed");
        this.failure = error instanceof AIExecutionError ? error.failure : undefined;
        this.error = cancelled ? null : error instanceof Error ? error.message : String(error);
        this.taskStatus = cancelled ? "cancelled" : error instanceof ImageContentRefusal ? "blocked" : "failed";
        if (error instanceof ImageContentRefusal) {
          assistant.text = error.message;
          this.latest = error.message;
        }
        if (assistant.text.trim()) assistant.status = "stopped";
        else this.messages = this.messages.filter(message => message !== assistant);
      } finally {
        attempt.settled=true;
        unsubscribeCommit();
        taskSignal.removeEventListener("abort", cancelTask);
        if (this.current === active) { this.current = null; this.save(); this.emit(); }
        else if(this.lastAttempt===attempt)this.emit(); // A stopped drawing has now settled; retry eligibility may have changed.
      }
    })();
    return active.promise;
  }
  resetBoardReply(): void {
    if (!this.current?.boardId) return;
    const message=this.messages.find(m=>m.id===`${this.current!.id}-assistant`);
    if(message)message.text="";this.latest="";this.emit();
  }
  openConnectionSettings(): void { this.host.openConnectionSettings?.(); }
  async useChatConnectionAndRetry(): Promise<void> {
    if (this.current || !this.lastAttempt || !this.host.recoverConnection || this.lastAttempt.retryInvalid ||
      (this.lastAttempt.boardStarted&&!this.lastAttempt.settled) || !["failed","cancelled"].includes(this.taskStatus??"")) return;
    const attempt=this.lastAttempt;
    await this.host.recoverConnection();
    // A newer user instruction during settings persistence always wins.
    if (this.current || this.lastAttempt !== attempt) return;
    await this.start(attempt.text, {...attempt.options,resolveIntent:false},attempt.drawing);
  }
  recordLocal(userText: string, assistantText: string, metadata?: unknown): void {
    this.cancel();
    this.taskStatus = "complete";
    this.lastAttempt = null;
    const id = ++this.sequence;
    const at = new Date().toISOString();
    this.messages.push({ id: `${id}-user`, role: "user", text: userText, at, status: "complete", boardId: null, events: [] },
      { id: `${id}-assistant`, role: "assistant", text: assistantText, at, status: "complete", boardId: null, metadata, events: [] });
    this.latest = assistantText; this.latestBoard = null; this.error = null; this.failure=undefined; this.execution=undefined; this.save(); this.emit();
  }
  retry(): Promise<void> {
    if (!this.state.canRetry || !this.lastAttempt) return Promise.resolve();
    const {text,options,drawing}=this.lastAttempt;
    return this.start(text,options,drawing);
  }
  rememberBoardReference(boardId:string, path:string, signal?:AbortSignal, style?:ReferencePaintStyle):void {
    // A write already in flight may finish just after cancel. Retain that asset
    // for this attempt, but never attach a late asset to a replacement task.
    if(this.lastAttempt?.options.boardId===boardId &&
      (signal ? this.lastAttempt.signal===signal : this.current?.boardId===boardId))
      { this.lastAttempt.options.referencePath=path;
        if(style)this.lastAttempt.options.drawingPlan={mode:"reference",prompt:this.lastAttempt.options.drawingPlan?.mode==="reference"?this.lastAttempt.options.drawingPlan.prompt:this.lastAttempt.text,style:{...style}};
      }
  }
  cancelForBoard(id: string): void { if (this.current?.boardId === id) this.cancel(); }
  cancel(): void {
    this.restoreSequence++;
    const active = this.current;
    if (!active) return;
    this.current = null;
    this.taskStatus = "cancelled";
    active.abort.abort();
    this.tasks.cancel(active.taskId, "obsidian");
    const message = this.messages.find(m => m.id === `${active.id}-assistant`);
    if (message && this.showCommitOutcome(active, message)) return;
    if (message) message.status = "stopped";
    this.save(); this.emit();
  }
  private showCommitOutcome(active: { taskId:string; id:number; boardId:string|null }, message:TutorMessage, receipt?:SurfaceCommitReceipt, settle=true):boolean {
    // Reset/restore deliberately removed this message. Do not revive its old
    // persistence session when a late native save reports its outcome.
    if (!this.messages.includes(message)) return false;
    if (!receipt) { try { receipt = this.tasks.get(active.taskId, "obsidian").commit; } catch { return false; } }
    if (!receipt || receipt.durability === "not-applied") return false;
    this.restoredCommits.set(active.taskId,structuredClone(receipt));
    if (settle) this.tasks.recordSurfaceCommit(receipt, true);
    message.text = receipt.durability === "committed"
      ? "图形已保存。本次图形提交已完成，已保存的修改已保留。"
      : receipt.durability === "applied-not-durable"
        ? "图形已落图，保存尚未确认。请先核对本次修改，再仅重试保存；不要重新生成或重复插入。"
        : "本次图形提交结果待核对。请先核对目标中的本次修改；不要重新生成或重复插入。";
    message.status = "complete";
    if (active.id === this.sequence) {
      this.taskStatus = receipt.durability === "committed" ? "complete" : "reconciliation";
      this.latest = message.text; this.latestBoard = active.boardId;
      this.error = null; this.failure = undefined; this.lastAttempt = null;
    }
    this.save(); this.emit();
    return true;
  }
  /** Reconcile the original local message; never resume a model or populate a reset conversation. */
  applyRecoveredCommit(receipt:SurfaceCommitReceipt):boolean {
    if(receipt.clientId!=="obsidian")throw new Error("conversation-commit-client-mismatch");
    const message=this.messages.find(message=>message.role==="assistant"&&message.taskId===receipt.requestId);
    if(!message)return false;
    const sequence=/^(\d+)-assistant$/.exec(message.id);if(!sequence)return false;
    return this.showCommitOutcome({taskId:receipt.requestId,id:Number(sequence[1]),boardId:message.boardId},message,receipt);
  }
  reset(): void {
    this.conversationId = crypto.randomUUID();
    this.cancel(); this.persistenceSession = { log: null }; this.host.reset?.(); this.messages = [];this.restoredCommits.clear();
    this.latest = ""; this.latestBoard = null; this.error = null; this.failure=undefined;this.execution=undefined; this.commands = [];
    this.taskStatus = undefined; this.lastAttempt = null; this.emit();
  }
  async restore(log: ChatLog): Promise<void> {
    this.reset(); this.log = log; this.mode = log.mode;
    this.messages = log.turns.map(turn => ({ id: `${++this.sequence}-${turn.role}`, role: turn.role,
      text: turn.text, at: turn.at, status: "complete", boardId: null, events: [] }));
    this.latest = [...this.messages].reverse().find(m => m.role === "assistant")?.text ?? "";
    this.emit();
    if(!this.host.restoreDrawingTasks)return;
    const request=this.restoreSequence,sequence=this.sequence,session=this.persistenceSession;
    const candidates=new Map<string,{user?:TutorMessage;assistant?:TutorMessage;ambiguous:boolean}>();
    log.turns.forEach((turn,index)=>{
      if(!z.uuid().safeParse(turn.taskId).success)return;
      const group=candidates.get(turn.taskId!)??{ambiguous:false},message=this.messages[index]!;
      if(group[turn.role])group.ambiguous=true;else group[turn.role]=message;
      candidates.set(turn.taskId!,group);
    });
    const ids=[...candidates].filter(([,group])=>!group.ambiguous).map(([id])=>id).slice(-50);
    if(!ids.length)return;
    const current=()=>this.restoreSequence===request&&this.sequence===sequence&&this.persistenceSession===session&&!this.current;
    try{
      const recovered=await this.host.restoreDrawingTasks(ids);
      if(!current())return;
      const seen=new Set<string>();
      for(const task of recovered){
        const group=candidates.get(task.id),parsed=surfaceReceiptSchema.safeParse(task.commit);
        if(!group||group.ambiguous||seen.has(task.id)||!ids.includes(task.id)||task.clientId!=="obsidian"||!parsed.success)continue;
        const receipt=parsed.data;
        if(receipt.clientId!=="obsidian"||receipt.requestId!==task.id||task.target?.id!==receipt.targetId||task.target.revision!==receipt.baseRevision)continue;
        try{if(["queued","working"].includes(this.tasks.get(task.id,"obsidian").state))continue;}catch{/* Metadata can outlive the bounded task cache. */}
        seen.add(task.id);this.tasks.restore([task]);this.tasks.recordSurfaceCommit(receipt,true);
        let message=group.assistant;
        if(!message&&group.user){
          message={id:group.user.id.replace(/-user$/,"-assistant"),role:"assistant",text:"",at:group.user.at,status:"complete",boardId:receipt.targetId,events:[]};
          this.messages.splice(this.messages.indexOf(group.user)+1,0,message);
        }
        if(!message)continue;
        message.taskId=task.id;message.boardId=receipt.targetId;if(group.user)group.user.taskId=task.id;
        if(!this.applyRecoveredCommit(receipt)){
          message.text="上次图形提交未应用。没有自动恢复或重新生成图形。";message.status="complete";
          if(message.id===`${this.sequence}-assistant`){this.taskStatus="failed";this.latest=message.text;this.latestBoard=receipt.targetId;}
        }
      }
      this.save();this.emit();
    }catch{
      if(current()){this.error="历史绘图事务暂时无法核对。请保留原图和事务记录，不要重复生成。";this.taskStatus="reconciliation";this.emit();}
    }
  }
  settingsChanged(): void { this.cancel(); this.host.reset?.(); this.commands = []; this.emit(); }
  private save(): void {
    if (!this.host.persist) return;
    const session = this.persistenceSession;
    const messages = this.messages.filter(m => m.status === "complete" || (m.status === "stopped" && m.text)).map(m => ({ ...m }));
    const mode = this.mode;
    this.persistence = this.persistence.then(async () => {
      session.log = await this.host.persist!(messages, mode, session.log);
    }).catch(error => { if (session === this.persistenceSession) { this.error = String(error); this.emit(); } });
  }
  async flush(): Promise<void> { await this.persistence; }
  dispose(): void { this.cancel(); this.host.reset?.(); this.listeners.clear(); this.sidebars.clear(); this.boards.clear(); }
}
