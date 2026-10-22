import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LearningInsightService, commitFromAnnotation, commitFromChatLog,
  learningInsightPrompt, parseLearningInsight, serializeLearningInsight,
  type LearningConversationCommit, type LearningInsightAnalysis, type LearningInsightHost,
} from "../src/learning-insight.js";
import type { Annotation, ChatLog } from "../src/model.js";

const at="2026-10-20T10:00:00.000Z";
function analysis(text="我把分裂理解成依赖语言存在"):LearningInsightAnalysis {
  return {
    observations:[{statement:"本次将结构关系转写成存在条件",quote:text,provenance:"observed",strength:"主动检验存在条件",possibleCost:"可能漏掉原句的关系限定"}],
    hypotheses:[{layer:"life-work-language",explanation:"可能采用了熟悉的因果表达",alternatives:["术语陌生","Tutor先前解释不充分"],unknowns:["尚不知道职业训练和日常表达"]}],
    generalMechanisms:[{explanation:"语义提取可以受任务背景和控制过程影响",source:"https://pmc.ncbi.nlm.nih.gov/articles/PMC3077429/",limitation:"一般研究不能确定此人的脑区活动或解释个人原因"}],
    exercises:[{instruction:"分别标出否定内容和关系，再换主题复测",distinguishes:"术语陌生和跨任务策略",predictions:["仅本题错误则支持术语解释","换题仍改写则需要更多策略证据"]}],
    counterevidence:[],teachingStrategies:["先用生活例子区分存在条件和结构关系"],
  };
}
function commit(id="ANN-1",text="我把分裂理解成依赖语言存在"):LearningConversationCommit {
  return {sourceKind:"annotation",sourceId:id,path:`Agent Memory/annotations/${id}.md`,studySource:"哲学/拉康.md",revision:`rev-${text}`,tracking:"ordinary",turns:[
    {id:`${id}-u`,role:"user",text,status:"complete",at},{id:`${id}-a`,role:"assistant",text:"试着区分关系和存在条件",status:"complete",at},
  ]};
}
function annotation(id="ANN-root", parent?: string): Annotation {
  return { id, sourceFile:"哲学/拉康.md", anchor:{blockId:"a",selectedText:"原文"}, userNote:"我把分裂理解成依赖语言存在",reviewText:"试着区分关系和存在条件",status:"reviewed",concepts:[],relatedMemoryCells:[],createdAt:at,updatedAt:at,
    ...(parent ? {branch:{parentAnnotationId:parent,rootAnnotationId:"ANN-root",sourceVersion:"source-v1",parentReply:{id:`${parent}:review`,kind:"review" as const,version:"v1",text:"父回复"}},request:{id:`${id}:request`,status:"completed" as const,question:"我把分裂理解成依赖语言存在",updatedAt:at}} : {}),
  };
}
function harness(initial:LearningConversationCommit[]=[commit()]) {
  const files=new Map<string,string>(), sources=new Map(initial.map(source=>[source.sourceId,source]));
  let enabled=true,busy=false,excluded:string[]=[];
  const run=vi.fn(async()=>JSON.stringify(analysis()));
  const host:LearningInsightHost={root:()=>"Agent Memory",enabled:()=>enabled,excludedSources:()=>excluded,
    read:async path=>files.get(path)??null,write:async(path,text)=>{files.set(path,text);},remove:async path=>{files.delete(path);},
    listSources:async()=>[...sources.values()],resolveSource:async source=>sources.get(source.sourceId)??null,
    run,isForegroundBusy:()=>busy,now:()=>at};
  const service=new LearningInsightService(host);
  return {host,files,sources,run,service,enable:(value:boolean)=>{enabled=value;},busy:(value:boolean)=>{busy=value;},exclude:(value:string[])=>{excluded=value;}};
}
async function tick(ms=1600):Promise<void>{await vi.advanceTimersByTimeAsync(ms);}
afterEach(()=>{vi.useRealTimers();});

describe("background qualitative learning analysis",()=>{
  it("backfills saved history, persists readable evidence, and deduplicates same authored material",async()=>{
    vi.useFakeTimers();const h=harness([commit(),commit("ANN-sibling")]);await h.service.start();await tick(6500);
    expect(h.run).toHaveBeenCalledTimes(1);expect(h.service.listRecords()).toHaveLength(1);
    const record=h.service.listRecords()[0]!;
    expect(record.analysis.hypotheses[0]?.unknowns).toContain("尚不知道职业训练和日常表达");
    expect(parseLearningInsight(serializeLearningInsight(record))).toEqual(record);
    expect(h.files.get(h.service.pathFor(record.id)!)).toContain("Possible causes (unverified)");
    expect(h.files.get("Agent Memory/thinking/.state.json")).not.toContain("我把分裂");
    expect(h.service.summary({sourcePath:"哲学/拉康.md"})).toContain("silently adapt");
    expect(h.service.summary()).not.toContain("可能采用了熟悉的因果表达");
    h.service.dispose();
  });
  it("resumes after restart without repeating finished evidence and excludes stopped/private gaps",async()=>{
    vi.useFakeTimers();const h=harness();await h.service.start();await tick(4500);h.service.dispose();
    const restarted=new LearningInsightService(h.host);await restarted.start();await tick(4500);
    expect(h.run).toHaveBeenCalledTimes(1);expect(restarted.listRecords()).toHaveLength(1);
    const source=commit("CHAT-barrier");source.sourceKind="chat";source.turns=[source.turns[0]!,{id:"private",role:"assistant",text:"private",status:"stopped",at},{id:"unrelated",role:"assistant",text:"later answer",status:"complete",at}];
    h.sources.set(source.sourceId,source);await restarted.commit(source);await tick(4500);
    expect(h.run).toHaveBeenCalledTimes(1);restarted.dispose();
  });
  it("hides changed sources immediately, invalidates edited/deleted evidence, and applies exclusions",async()=>{
    vi.useFakeTimers();const h=harness();await h.service.start();await tick(4500);
    expect(h.service.summary()).not.toBe("");h.service.sourceChanged(commit().path);expect(h.service.summary()).toBe("");
    h.sources.delete("ANN-1");await h.service.reconcile();expect(h.service.listRecords()).toHaveLength(0);
    expect([...h.files.keys()].filter(path=>path.endsWith(".md"))).toEqual([]);
    h.sources.set("ANN-2",commit("ANN-2"));h.exclude(["哲学"]);await h.service.refreshSettings();await tick(4500);
    expect(h.run).toHaveBeenCalledTimes(1);h.service.dispose();
  });
  it("does not clear a source invalidation that arrives after a reconciliation snapshot started",async()=>{
    vi.useFakeTimers();const h=harness();await h.service.start();await tick(4500);
    let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    const old=[...h.sources.values()].map(source=>structuredClone(source));
    h.host.listSources=async()=>{await wait;return old;};
    const scanning=h.service.reconcile();await Promise.resolve();
    h.service.sourceChanged(commit().path);h.sources.set("ANN-1",commit("ANN-1","changed reasoning"));
    release();await scanning;expect(h.service.summary()).toBe("");
    h.host.listSources=async()=>[...h.sources.values()];await h.service.reconcile();expect(h.service.listRecords()).toHaveLength(0);h.service.dispose();
  });
  it("does not let an older commit clear a newer source notification",async()=>{
    vi.useFakeTimers();const h=harness();await h.service.start();await tick(4500);const old=commit();
    h.service.sourceChanged(old.path);let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    h.host.resolveSource=async()=>{await wait;return old;};const saving=h.service.commit(old);await Promise.resolve();
    h.service.sourceChanged(old.path);h.sources.set(old.sourceId,commit(old.sourceId,"new text"));release();await saving;
    expect(h.service.summary()).toBe("");h.service.dispose();
  });
  it("removes an analysis file if its source is invalidated while the durable write is pending",async()=>{
    vi.useFakeTimers();const h=harness();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
    h.host.write=async(path,text)=>{if(path.endsWith(".md"))await wait;h.files.set(path,text);};
    await h.service.start();await tick(1600);h.service.sourceChanged(commit().path);release();await tick(100);
    expect(h.service.listRecords()).toHaveLength(0);expect([...h.files.keys()].filter(path=>path.endsWith(".md"))).toEqual([]);h.service.dispose();
  });
  it("preserves failed-job backoff when unrelated saves rescan the same source",async()=>{
    vi.useFakeTimers();const h=harness();h.run.mockRejectedValue(new Error("403"));await h.service.start();await tick(4500);
    const first=JSON.parse(h.files.get("Agent Memory/thinking/.state.json")!).queue[0];
    await h.service.reconcile();await h.service.commit(commit());await tick(4500);
    const latest=JSON.parse(h.files.get("Agent Memory/thinking/.state.json")!).queue[0];
    expect(latest.attempts).toBe(first.attempts);expect(latest.nextAt).toBe(first.nextAt);expect(h.run).toHaveBeenCalledTimes(1);h.service.dispose();
  });
  it("invalidates old contextual observations when the host study revision changes",async()=>{
    vi.useFakeTimers();const h=harness();const source=commit();source.studyRevision="book-v1";h.sources.set(source.sourceId,source);
    await h.service.start();await tick(4500);expect(h.service.listRecords()).toHaveLength(1);
    expect(h.service.sourceChanged("哲学/拉康.md")).toBe(true);expect(h.service.summary()).toBe("");
    h.sources.set(source.sourceId,{...source,studyRevision:"book-v2",revision:"source-v2"});await h.service.reconcile();
    expect(h.service.listRecords()).toHaveLength(0);await tick(4500);expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.service.listRecords()[0]?.source.studyRevision).toBe("book-v2");expect(h.service.sourceChanged("unrelated.md")).toBe(false);h.service.dispose();
  });
  it("preempts analysis during foreground requests and rejects late source results",async()=>{
    vi.useFakeTimers();const h=harness();let finish!:(text:string)=>void;
    h.run.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));await h.service.start();await tick();
    h.service.foregroundStarted();finish(JSON.stringify(analysis()));await tick();expect(h.service.listRecords()).toHaveLength(0);
    h.service.dispose();
  });
  it("does not publish fabricated quotes or exercise outcomes and retries later",async()=>{
    vi.useFakeTimers();const h=harness();h.run.mockResolvedValue(JSON.stringify(analysis("不在用户文本中的内容")));await h.service.start();await tick(6000);
    expect(h.run).toHaveBeenCalledTimes(1);expect(h.service.listRecords()).toHaveLength(0);
    expect(h.service.summary()).toBe("");h.service.dispose();
  });
  it("supports manual corrections and deletion without silently regenerating the same evidence",async()=>{
    vi.useFakeTimers();const h=harness();await h.service.start();await tick(4500);const record=h.service.listRecords()[0]!;
    await h.service.correct(record.id,"这是我在检验作者观点，并非我自己接受的结论");
    expect(h.service.summary()).toContain("这是我在检验作者观点");expect(h.service.summary()).not.toContain("本次将结构关系");
    await h.service.deleteRecord(record.id);await h.service.reconcile();await tick(4500);
    expect(h.service.listRecords()).toHaveLength(0);expect(h.run).toHaveBeenCalledTimes(1);h.service.dispose();
  });
  it("keeps a manual deletion after context-only source edits and restart, while allowing new authored reasoning",async()=>{
    vi.useFakeTimers();const h=harness();const initial=commit();initial.studyRevision="book-v1";h.sources.set(initial.sourceId,initial);
    await h.service.start();await tick(4500);await h.service.deleteRecord(h.service.listRecords()[0]!.id);
    h.sources.set(initial.sourceId,{...initial,studyRevision:"book-v2",revision:"context-v2"});
    await h.service.reconcile();await tick(4500);expect(h.service.listRecords()).toHaveLength(0);expect(h.run).toHaveBeenCalledTimes(1);
    h.service.dispose();const restarted=new LearningInsightService(h.host);await restarted.start();await tick(4500);
    expect(restarted.listRecords()).toHaveLength(0);expect(h.run).toHaveBeenCalledTimes(1);
    const newReasoning="我现在区分存在条件与结构关系";
    h.sources.set(initial.sourceId,{...initial,studyRevision:"book-v2",revision:"new-authored-text",turns:[{...initial.turns[0]!,text:newReasoning},initial.turns[1]!]});
    h.run.mockResolvedValue(JSON.stringify(analysis(newReasoning)));await restarted.reconcile();await tick(4500);
    expect(h.run).toHaveBeenCalledTimes(2);expect(restarted.listRecords()).toHaveLength(1);restarted.dispose();
  });
  it("pauses background calls and teaching projection while disabled",async()=>{
    vi.useFakeTimers();const h=harness();h.enable(false);await h.service.start();await tick(4500);expect(h.run).not.toHaveBeenCalled();
    h.enable(true);await h.service.refreshSettings();await tick(4500);expect(h.run).toHaveBeenCalledOnce();
    h.enable(false);await h.service.refreshSettings();expect(h.service.summary()).toBe("");h.service.dispose();
  });
  it("leaves foreground interaction first and stores no analysis until it is idle",async()=>{
    vi.useFakeTimers();const h=harness();h.busy(true);await h.service.start();await tick(4500);expect(h.run).not.toHaveBeenCalled();
    h.busy(false);await tick(4500);expect(h.run).toHaveBeenCalledOnce();h.service.dispose();
  });
});

describe("eligible transcript projection",()=>{
  it("treats old completion as unknown and keeps private turns as barriers",()=>{
    const log:ChatLog={id:"CHAT-old",title:"old",engine:"api",mode:"ask",status:"active",createdAt:at,updatedAt:at,turns:[
      {role:"user",text:"question",at},{role:"assistant",text:"private",at,tracking:"private"},{role:"assistant",text:"later",at},
    ]};
    const source=commitFromChatLog(log,"Agent Memory/chats/CHAT-old.md");
    expect(source.turns.map(turn=>turn.status)).toEqual(["unknown","stopped","unknown"]);
    expect(learningInsightPrompt({text:"question",user:{status:"unknown"},assistant:{text:"answer",status:"unknown"}})).toContain("Completion is unknown");
    expect(source.turns[0]?.id).toBe(commitFromChatLog(log,source.path).turns[0]?.id);
  });
  it("does not analyze drafts or copy source/parent quotes as authored annotation evidence",()=>{
    const sourceText="这是一本书的原文选区，不应该成为用户自己产生的阅读策略与思维习惯证据。".repeat(3);
    const annotation:Annotation={id:"ANN-child",sourceFile:"原文.md",anchor:{blockId:"a",selectedText:sourceText},userNote:`${sourceText}\n我的问题`,status:"draft",concepts:[],relatedMemoryCells:[],createdAt:at,updatedAt:at,
      branch:{parentAnnotationId:"ANN-parent",rootAnnotationId:"ANN-parent",sourceVersion:"x",parentReply:{id:"r",kind:"review",version:"v",text:"parent"}},request:{id:"q",status:"draft",question:"我的问题",updatedAt:at}};
    expect(commitFromAnnotation(annotation,"child.md").turns).toEqual([]);
    annotation.request!.status="completed";annotation.reviewText="解释";
    expect(commitFromAnnotation(annotation,"child.md").turns[0]?.text).toBe("\n我的问题");
  });
});

describe("source-linked depth and breadth activity",()=>{
  it("derives stable saved actions, distinguishes empty branch creation from submitted questions, and ignores retries",()=>{
    const child=annotation("ANN-child","ANN-root");child.reviewText=undefined;child.userNote="";child.request!.status="draft";child.request!.question="";
    const draft=commitFromAnnotation(child,"child.md");
    expect(draft.turns).toEqual([]);expect(draft.navigation?.events.map(event=>event.kind)).toEqual(["branch-created"]);
    expect(commitFromAnnotation(child,"child.md").revision).toBe(draft.revision);
    child.userNote="我的问题";child.request!.question="我的问题";child.request!.status="failed";
    const attempted=commitFromAnnotation(child,"child.md");
    expect(attempted.turns).toEqual([]);expect(attempted.navigation?.events.map(event=>event.kind)).toEqual(["branch-created","branch-question-submitted"]);
    expect(attempted.revision).not.toBe(draft.revision);
    child.request!.status="generating";
    const retry=commitFromAnnotation(child,"child.md");
    expect(retry.navigation?.events.map(event=>event.id)).toEqual(attempted.navigation?.events.map(event=>event.id));
    expect(retry.navigation?.events.at(-1)?.outcome).toBe("generating");
    const root=annotation();root.dialogue=[{id:"followup-u",role:"user",text:"换个例子呢",at},{id:"followup-a",role:"agent",text:"例如答应别人后又后悔",at}];
    const depth=commitFromAnnotation(root,"root.md");
    expect(depth.navigation?.events[0]).toMatchObject({kind:"same-card-followup",turnIds:["followup-u","followup-a"]});
    root.dialogue[0]!.text="我在问另一个问题";
    expect(commitFromAnnotation(root,"root.md").revision).not.toBe(depth.revision);
    expect(commitFromAnnotation(root,"root.md").navigation?.events[0]?.id).not.toBe(depth.navigation?.events[0]?.id);
  });
  it("persists empty draft activity without invoking analysis, and removes excluded/deleted sources on rescan",async()=>{
    vi.useFakeTimers();const child=annotation("ANN-child","ANN-root");child.reviewText=undefined;child.userNote="";child.request!.status="draft";child.request!.question="";
    const source=commitFromAnnotation(child,"Agent Memory/annotations/ANN-child.md");const h=harness([source]);
    await h.service.start();await tick(4500);
    expect(h.run).not.toHaveBeenCalled();expect(h.service.listRecords()).toEqual([]);
    expect(h.service.listNavigation()[0]?.snapshot.events.map(event=>event.kind)).toEqual(["branch-created"]);
    expect(JSON.parse(h.files.get("Agent Memory/thinking/.state.json")!).navigation).toHaveProperty(`annotation:${source.sourceId}:${source.path}`);
    h.service.dispose();const restarted=new LearningInsightService(h.host);await restarted.start();
    expect(restarted.listNavigation()).toHaveLength(1);
    h.exclude([source.sourceId]);await restarted.refreshSettings();expect(restarted.listNavigation()).toEqual([]);
    h.exclude([]);await restarted.refreshSettings();expect(restarted.listNavigation()).toHaveLength(1);
    h.sources.delete(source.sourceId);await restarted.reconcile();expect(restarted.listNavigation()).toEqual([]);restarted.dispose();
  });
  it("records failed same-card choices without answer evidence and replaces the attempt with one completed action",async()=>{
    vi.useFakeTimers();const root=annotation();root.reviewText=undefined;
    root.dialogueRequest={id:"depth-request",status:"generating",question:"我把分裂理解成依赖语言存在",updatedAt:at};
    const path=`Agent Memory/annotations/${root.id}.md`,started=commitFromAnnotation(root,path);
    expect(started.turns).toEqual([]);expect(started.navigation?.events).toHaveLength(1);
    expect(started.navigation?.events[0]).toMatchObject({kind:"same-card-followup",outcome:"generating",turnIds:[]});
    const h=harness([started]);await h.service.start();await tick(4500);expect(h.run).not.toHaveBeenCalled();
    for(const status of ["failed","cancelled","interrupted","generating"] as const){
      root.dialogueRequest.status=status;const attempt=commitFromAnnotation(root,path);
      expect(attempt.navigation?.events).toHaveLength(1);expect(attempt.navigation?.events[0]?.id).toBe(started.navigation?.events[0]?.id);
      expect(attempt.navigation?.events[0]?.outcome).toBe(status);h.sources.set(root.id,attempt);await h.service.commit(attempt);
    }
    await tick(4500);expect(h.run).not.toHaveBeenCalled();expect(h.service.listRecords()).toEqual([]);
    root.dialogue=[{id:"depth-request-user",role:"user",text:root.dialogueRequest.question,at},{id:"depth-request-agent",role:"agent",text:"试着区分关系和存在条件",at}];
    root.dialogueRequest.status="completed";const completed=commitFromAnnotation(root,path);
    expect(completed.navigation?.events).toHaveLength(1);expect(completed.navigation?.events[0]?.id).toBe(started.navigation?.events[0]?.id);
    expect(completed.navigation?.events[0]).toMatchObject({outcome:"completed",turnIds:["depth-request-user","depth-request-agent"]});
    h.sources.set(root.id,completed);await h.service.commit(completed);await tick(4500);
    expect(h.run).toHaveBeenCalledTimes(1);expect(h.service.listRecords()).toHaveLength(1);
    root.dialogueRequest.status="failed";expect(commitFromAnnotation(root,path).navigation?.events).toHaveLength(1);h.service.dispose();
  });
  it("keeps activity counts separate from independent authored evidence and bounds analysis to the branch family",async()=>{
    vi.useFakeTimers();const root=annotation();root.dialogue=[{id:"du",role:"user",text:root.userNote,at},{id:"da",role:"agent",text:"换一个角度解释",at}];
    const child=annotation("ANN-child","ANN-root"),other=annotation("ANN-other");other.tracking="excluded";
    const sources=[root,child,other].map(item=>commitFromAnnotation(item,`Agent Memory/annotations/${item.id}.md`));const h=harness(sources);
    let prompt="";h.host.run=async value=>{prompt=value;return h.run();};await h.service.start();await tick(6500);
    expect(h.run).toHaveBeenCalledTimes(1);expect(h.service.listRecords()).toHaveLength(1);
    const record=h.service.listRecords()[0]!;
    expect(record.navigation?.counts).toEqual({branchesCreated:1,branchQuestionsSubmitted:1,sameCardFollowups:1,distinctAuthoredQuestions:1});
    expect(record.navigation?.cards.map(card=>card.source.sourceId).sort()).toEqual(["ANN-child","ANN-root"]);
    expect(prompt).toContain("never a learning-success score or fixed preference/personality diagnosis");
    expect(prompt).toContain("interface convenience");expect(prompt).toContain("SAVED_NAVIGATION_ACTIVITY_CONTEXT");
    expect(parseLearningInsight(serializeLearningInsight(record))).toEqual(record);
    h.service.sourceChanged(sources[1]!.path);expect(h.service.summary()).toBe("");
    h.sources.delete("ANN-child");await h.service.reconcile();expect(h.service.listRecords()).toEqual([]);
    await tick(4500);expect(h.service.listRecords()[0]?.navigation?.counts.branchesCreated).toBe(0);h.service.dispose();
  });
  it("invalidates changed navigation dependencies and keeps different vault workers isolated",async()=>{
    vi.useFakeTimers();const root=annotation(),child=annotation("ANN-child","ANN-root");
    const h=harness([root,child].map(item=>commitFromAnnotation(item,`Agent Memory/annotations/${item.id}.md`)));
    await h.service.start();await tick(6500);expect(h.service.listRecords()).toHaveLength(1);
    child.branch!.parentReply.version="v2";h.sources.set(child.id,commitFromAnnotation(child,`Agent Memory/annotations/${child.id}.md`));
    await h.service.reconcile();expect(h.service.listRecords()).toHaveLength(0);
    const isolated=harness([commitFromAnnotation(root,`Agent Memory/annotations/${root.id}.md`)]);await isolated.service.start();await tick(4500);
    expect(isolated.service.listNavigation()).toHaveLength(1);expect(isolated.service.listRecords()[0]?.navigation?.counts.branchesCreated).toBe(0);
    expect(h.service.listNavigation()).toHaveLength(2);h.service.dispose();isolated.service.dispose();
  });
  it("rereads invalidated activity and removes a private parent from dependent analysis without hiding the ordinary child's own activity",async()=>{
    vi.useFakeTimers();const root=annotation(),child=annotation("ANN-child","ANN-root");
    const oldRoot=commitFromAnnotation(root,`Agent Memory/annotations/${root.id}.md`),childSource=commitFromAnnotation(child,`Agent Memory/annotations/${child.id}.md`);
    const h=harness([oldRoot,childSource]);await h.service.start();await tick(6500);
    expect(h.service.listRecords()[0]?.navigation?.cards).toHaveLength(2);
    root.tracking="private";h.sources.set(root.id,commitFromAnnotation(root,oldRoot.path));
    h.service.sourceChanged(oldRoot.path);expect(h.service.summary()).toBe("");
    await h.service.commit(oldRoot); // An older caller cannot revive the private snapshot.
    expect(h.service.listNavigation().map(entry=>entry.source.sourceId)).toEqual([child.id]);
    expect(h.service.listRecords()).toEqual([]);
    await h.service.reconcile();await tick(6500);
    expect(h.service.listRecords()).toHaveLength(1);
    expect(h.service.listRecords()[0]?.source.sourceId).toBe(child.id);
    expect(h.service.listRecords()[0]?.navigation?.cards.map(card=>card.source.sourceId)).toEqual([child.id]);
    h.exclude([child.id]);expect(h.service.summary()).toBe("");expect(h.service.listNavigation()).toEqual([]);
    h.service.dispose();
  });
});
