import { describe, expect, it, vi } from "vitest";
import { TutorTaskCoordinator, TargetCommitQueue } from "../src/tutor-task.js";
import type { SurfaceCommitReceipt } from "../src/tutor-surface.js";

describe("shared Tutor tasks", () => {
  it("pauses known reconciliation without discarding it, while ordinary pending tasks still block",()=>{
    const tasks=new TutorTaskCoordinator(),task=tasks.start({clientId:"obsidian"});
    const receipt:SurfaceCommitReceipt={version:1,clientId:"obsidian",targetId:"board",transactionId:"change",requestId:task.id,baseRevision:"0",appliedRevision:"1",createdIds:["object"],updatedIds:[],deletedIds:[],objectRevisions:{object:"a".repeat(64)},operationDigest:"b".repeat(64),durability:"outcome-unknown"};
    expect(()=>tasks.pauseWhenIdle({allowDurableReconciliation:true})).toThrow("busy");tasks.recordSurfaceCommit(receipt,true);
    expect(()=>tasks.pauseWhenIdle()).toThrow("busy");expect(tasks.reconciliationReceipts()).toEqual([receipt]);
    tasks.pauseWhenIdle({allowDurableReconciliation:true});expect(()=>tasks.start({clientId:'obsidian'})).toThrow();
    expect(tasks.get(task.id,'obsidian').commit).toEqual(receipt);tasks.resume();const next=tasks.start({clientId:'obsidian'});
    expect(()=>tasks.pauseWhenIdle({allowDurableReconciliation:true})).toThrow("busy");tasks.cancel(next.id,'obsidian');tasks.dispose();
  });
  it("scopes deduplication and lookup to a client and keeps targets immutable", () => {
    const tasks = new TutorTaskCoordinator();
    const target = { id: "board-1", source: "a.md", revision: "1", surface: "studio" as const };
    const a = tasks.start({ clientId: "a", key: "k", target });
    target.source = "b.md";
    expect(tasks.start({ clientId: "a", key: "k" }).id).toBe(a.id);
    expect(tasks.start({ clientId: "b", key: "k" }).id).not.toBe(a.id);
    expect(() => tasks.get(a.id, "b")).toThrow("task-not-found");
    expect(tasks.get(a.id, "a").target?.source).toBe("a.md");
    expect(() => tasks.bind(a.id, "a", {...target, id:"board-2"})).toThrow();
    expect(() => tasks.bind(a.id, "a", {...target, revision:"changed"})).toThrow();
    tasks.dispose();
  });
  it("cancels the entire tree, blocks cycles and ignores no late commit", () => {
    const tasks = new TutorTaskCoordinator();
    const root = tasks.start({clientId:"a"});
    const child = tasks.start({clientId:"a", parentId:root.id, agent:"codex"});
    expect(() => tasks.start({clientId:"a", parentId:child.id, agent:"tutor"})).toThrow("delegation-cycle");
    tasks.start({clientId:"a", parentId:root.id, agent:"opencode"});
    expect(() => tasks.start({clientId:"a", parentId:root.id, agent:"researcher"})).toThrow();
    tasks.cancel(root.id,"a");
    expect(tasks.signal(child.id,"a").aborted).toBe(true);
    expect(() => tasks.complete(child.id,"a")).toThrow("task-inactive");
    tasks.dispose();
  });
  it("bounds time, event history and the shared model budget", () => {
    vi.useFakeTimers();
    const tasks = new TutorTaskCoordinator(100);
    const root = tasks.start({clientId:"a"});
    for(let i=0;i<200;i++) tasks.emit(root.id,"a",{type:"status", data:i});
    expect(tasks.events(root.id,"a")).toHaveLength(128);
    for(let i=0;i<12;i++)tasks.consume(root.id,"a","modelCalls");
    expect(()=>tasks.consume(root.id,"a","modelCalls")).toThrow("budget-exceeded");
    vi.advanceTimersByTime(101);
    expect(tasks.get(root.id,"a").state).toBe("failed");
    expect(tasks.signal(root.id,"a").aborted).toBe(true);
    tasks.dispose(); vi.useRealTimers();
  });
  it("serializes per-target commits even after a rejected commit", async () => {
    const queue = new TargetCommitQueue(), calls:string[]=[];
    let release!:()=>void; const gate = new Promise<void>(resolve=>release=resolve);
    const a=queue.run("a",async()=>{calls.push("a1");await gate; throw new Error("conflict");});
    const rejected=expect(a).rejects.toThrow("conflict");
    const b=queue.run("a",async()=>{calls.push("a2");});
    await queue.run("b",async()=>{calls.push("b");});
    expect(calls).toEqual(["a1","b"]); release(); await rejected; await b;
    expect(calls).toEqual(["a1","b","a2"]);
  });
  it("preserves authoritative drawing receipts through ordinary completion and stale restored task status",()=>{
    const tasks=new TutorTaskCoordinator(),task=tasks.start({clientId:"a"}),receipt:SurfaceCommitReceipt={version:1,clientId:"a",targetId:"board",transactionId:"change",requestId:task.id,baseRevision:"0",appliedRevision:"1",committedRevision:"1",createdIds:["object"],updatedIds:[],deletedIds:[],objectRevisions:{object:"a".repeat(64)},operationDigest:"b".repeat(64),durability:"committed"};
    tasks.recordSurfaceCommit(receipt);tasks.complete(task.id,"a");
    const completed=tasks.get(task.id,"a");expect(completed.artifacts).toEqual([expect.objectContaining({id:"change",type:"changes"})]);
    const restored=new TutorTaskCoordinator();restored.restore([{...completed,state:"cancelled",phase:"cancelled",error:{code:"cancelled",message:"stopped"}}]);
    expect(restored.get(task.id,"a")).toMatchObject({state:"completed",phase:"completed",commit:receipt});expect(restored.get(task.id,"a").error).toBeUndefined();
    tasks.dispose();restored.dispose();
  });
});
