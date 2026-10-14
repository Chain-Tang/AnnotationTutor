import { describe, expect, it, vi } from "vitest";
import { TutorConversation } from "../src/tutor-conversation.js";
import { TutorTaskCoordinator } from "../src/tutor-task.js";
import { restoreLocalDrawingTasks, listPendingLocalDrawingTasks, readLocalDrawingTask } from "../src/tutor-local-recovery.js";
import { surfaceCommitResult } from "../src/tutor-surface.js";
import { surfaceJournalFixture } from "./surface-journal-fixture.js";
import { parseChatLogFile, serializeChatLog } from "../src/markdown/chat-log-file.js";
import type { ChatLog } from "../src/model.js";

async function persistedDrawing(phase:"applying"|"applied"|"saving"|"committed"="applied",clientId="obsidian"){
  const disk=surfaceJournalFixture(),taskId=crypto.randomUUID(),grant={clientId,targets:["board"],read:true,write:true,humanObjectIds:[],learningMemory:false};
  const change={id:"drawing",taskId,targetId:"board",baseRevision:"0",operations:[{text:"PRIVATE OPERATION"}],dependencies:[]};
  const objects=[{id:"created",text:"PRIVATE CONTENT"}];
  const result=surfaceCommitResult(change,grant,{id:"board",source:"private.md",revision:"1",surface:"studio"},[],objects);
  await disk.journal.prepare(change,grant,"studio",result.receipt,[]);await disk.journal.transition(result.receipt,"applying");
  if(phase!=="applying")await disk.journal.transition(result.receipt,"applied");
  if(phase==="saving"||phase==="committed")await disk.journal.transition(result.receipt,"saving");
  if(phase==="committed")await disk.journal.transition(result.receipt,"committed");
  const log:ChatLog={id:"CHAT-recover",title:"Drawing",engine:"api",mode:"ask",status:"active",createdAt:"2026-10-09T00:00:00Z",updatedAt:"2026-10-09T00:01:00Z",turns:[{role:"user",text:"draw a diagram",at:"2026-10-09T00:00:00Z",taskId},{role:"assistant",text:"saving…",at:"2026-10-09T00:00:00Z",taskId}]};
  return {disk,taskId,result,log};
}
describe("local drawing recovery after process restart",()=>{
  it.each(["applying","applied","saving","committed"] as const)("restores %s from the durable journal into a fresh conversation without a model",async phase=>{
    const f=await persistedDrawing(phase),tasks=new TutorTaskCoordinator(),run=vi.fn(async()=>({text:"must not run"}));
    const conversation=new TutorConversation({tasks,run,restoreDrawingTasks:ids=>restoreLocalDrawingTasks(f.disk.reload(),tasks,ids)});
    expect(tasks.list("obsidian")).toEqual([]);
    await conversation.restore(parseChatLogFile(serializeChatLog(f.log))!);
    expect(conversation.state).toMatchObject({taskId:f.taskId,taskStatus:phase==="committed"?"complete":"reconciliation",canRetry:false,commit:{durability:phase==="committed"?"committed":phase==="applied"?"applied-not-durable":"outcome-unknown"}});
    expect(tasks.signal(f.taskId,"obsidian").aborted).toBe(true);await conversation.retry();expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(tasks.get(f.taskId,"obsidian"))).not.toContain("PRIVATE");tasks.dispose();
  });
  it("restores a receipt from a user-only log left by an interrupted native commit",async()=>{
    const f=await persistedDrawing(),tasks=new TutorTaskCoordinator(),conversation=new TutorConversation({tasks,run:vi.fn(),restoreDrawingTasks:ids=>restoreLocalDrawingTasks(f.disk.reload(),tasks,ids)});
    await conversation.restore({...f.log,turns:f.log.turns.slice(0,1)});
    expect(conversation.state.history).toHaveLength(2);expect(conversation.state).toMatchObject({taskId:f.taskId,taskStatus:"reconciliation",latestBoardId:"board"});
    expect(conversation.state.latestReply).toContain("保存尚未确认");tasks.dispose();
  });
  it("uses neither unverified chat IDs, duplicate references nor another client's receipts",async()=>{
    const f=await persistedDrawing("committed","external-client"),tasks=new TutorTaskCoordinator(),conversation=new TutorConversation({tasks,run:vi.fn(),restoreDrawingTasks:ids=>restoreLocalDrawingTasks(f.disk.reload(),tasks,ids)});
    await conversation.restore(f.log);expect(conversation.state.taskId).toBeUndefined();expect(conversation.state.commit).toBeUndefined();expect(tasks.list("obsidian")).toEqual([]);
    await conversation.restore({...f.log,turns:[f.log.turns[1]!,f.log.turns[1]!]});expect(conversation.state.commit).toBeUndefined();
    await conversation.restore({...f.log,turns:f.log.turns.map(turn=>({...turn,taskId:crypto.randomUUID()}))});expect(conversation.state.commit).toBeUndefined();tasks.dispose();
  });
  it.each(["new-turn","reset","cancel"])("does not apply a late restoration after %s",async action=>{
    const f=await persistedDrawing(),tasks=new TutorTaskCoordinator();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const conversation=new TutorConversation({tasks,run:async()=>({text:"new answer"}),restoreDrawingTasks:async ids=>{await gate;return restoreLocalDrawingTasks(f.disk.reload(),tasks,ids);}});
    const restoring=conversation.restore(f.log);
    if(action==="new-turn")await conversation.submit("new question",{route:"chat"});else if(action==="reset")conversation.reset();else conversation.cancel();
    release();await restoring;
    expect(conversation.state.commit).toBeUndefined();
    if(action==="new-turn")expect(conversation.state.latestReply).toBe("new answer");
    if(action==="reset")expect(conversation.state.history).toEqual([]);
    if(action==="cancel")expect(conversation.state.latestReply).toBe("saving…");tasks.dispose();
  });
  it("lists pending metadata without a chat log and never reconstructs private drawing contents",async()=>{
    const f=await persistedDrawing("saving"),tasks=new TutorTaskCoordinator();
    const pending=await listPendingLocalDrawingTasks(f.disk.reload(),tasks);
    expect(pending).toMatchObject({total:1,nextOffset:null,tasks:[{id:f.taskId,state:"input-required",commit:{durability:"outcome-unknown"}}]});
    expect(JSON.stringify(pending)).not.toContain("PRIVATE");expect(JSON.stringify(pending)).not.toContain("private.md");
    expect(tasks.list("obsidian")).toEqual([]);
    expect(await listPendingLocalDrawingTasks(f.disk.reload(),tasks,1)).toMatchObject({tasks:[],total:1,nextOffset:null});tasks.dispose();
  });
  it("does not replace a still-running native save with a lagging recovery projection",async()=>{
    const disk=surfaceJournalFixture(),tasks=new TutorTaskCoordinator(),task=tasks.start({clientId:"obsidian"}),grant={clientId:"obsidian",targets:["board"],read:true,write:true,humanObjectIds:[],learningMemory:false};
    const changes={id:"active",taskId:task.id,targetId:"board",baseRevision:"0",operations:[{type:"add"}],dependencies:[]};
    const result=surfaceCommitResult(changes,grant,{id:"board",source:"",revision:"1",surface:"studio"},[],[{id:"created"}]);
    await disk.journal.prepare(changes,grant,"studio",result.receipt,[]);await disk.journal.transition(result.receipt,"applying");
    tasks.phase(task.id,"obsidian","saving");
    expect(await restoreLocalDrawingTasks(disk.reload(),tasks,[task.id])).toEqual([]);
    expect((await listPendingLocalDrawingTasks(disk.reload(),tasks)).tasks).toEqual([]);
    await expect(readLocalDrawingTask(disk.reload(),tasks,task.id)).rejects.toThrow("still-running");
    expect(tasks.get(task.id,"obsidian")).toMatchObject({state:"working",phase:"saving"});expect(tasks.get(task.id,"obsidian").commit).toBeUndefined();expect(tasks.signal(task.id,"obsidian").aborted).toBe(false);tasks.dispose();
  });
  it("keeps recovery accessible when unresolved tasks fill the bounded live cache",async()=>{
    const f=await persistedDrawing(),tasks=new TutorTaskCoordinator(300_000,1),running=tasks.start({clientId:"obsidian"});
    const run=vi.fn(),conversation=new TutorConversation({tasks,run,restoreDrawingTasks:ids=>restoreLocalDrawingTasks(f.disk.reload(),tasks,ids)});
    await conversation.restore(f.log);
    expect(conversation.state).toMatchObject({taskId:f.taskId,taskStatus:"reconciliation",commit:{durability:"applied-not-durable"}});
    expect(tasks.list("obsidian").map(task=>task.id)).toEqual([running.id]);
    expect((await listPendingLocalDrawingTasks(f.disk.reload(),tasks)).tasks.map(task=>task.id)).toEqual([f.taskId]);
    const projection=await readLocalDrawingTask(f.disk.reload(),tasks,f.taskId);
    expect(projection?.commit?.transactionId).toBe(f.result.receipt.transactionId);
    expect(conversation.applyRecoveredCommit({...projection!.commit!,durability:"committed",committedRevision:"1"})).toBe(true);
    expect(conversation.state).toMatchObject({taskStatus:"complete",commit:{durability:"committed"}});
    await conversation.retry();expect(run).not.toHaveBeenCalled();tasks.dispose();
  });
});
