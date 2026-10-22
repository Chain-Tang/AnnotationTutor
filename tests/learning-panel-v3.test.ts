// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountLearningPanel, type LearningPanelHost } from "../src/learning-panel.js";
import { LearningCardV3 } from "../src/learning-card-v3.js";
import { LearningCommandsV3 } from "../src/learning-commands-v3.js";
import { localLearnerAuthority } from "../src/learning-control-v3.js";
import { completeRecordReadResult } from "../src/learning-record-read.js";
import { createEpisode } from "../src/learning-episode.js";
import { renderQuestionV3, type EpisodeV3 } from "../src/learning-v3.js";
import { protectionFixture } from "./learning-protection-fixture.js";
import { setLocale } from "../src/i18n.js";
beforeAll(()=>{
  Object.defineProperty(HTMLElement.prototype,"createEl",{configurable:true,value:function(tag:string,o:{cls?:string;text?:string;value?:string;type?:string;attr?:Record<string,string>;placeholder?:string}={}){
    const el=this.ownerDocument.createElement(tag);if(o.cls)el.className=o.cls;if(o.text)el.textContent=o.text;for(const [key,value]of Object.entries(o.attr??{}))el.setAttribute(key,value);
    if(o.value!==undefined)el.value=o.value;if(o.type)el.type=o.type;if(o.placeholder)el.placeholder=o.placeholder;this.append(el);return el;
  }});
  Object.defineProperty(HTMLElement.prototype,"createDiv",{configurable:true,value:function(o:object={}){return this.createEl("div",o);}});
  Object.defineProperty(HTMLElement.prototype,"empty",{configurable:true,value:function(){this.replaceChildren();}});
});
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const dispose of cleanups.splice(0))dispose();document.body.replaceChildren();vi.restoreAllMocks();});
function barrier(){let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>entered=resolve),ready=new Promise<void>(resolve=>release=resolve);return {reached,release,wait:async()=>{entered();await ready;}};}
async function rig(start=true,settings:Pick<LearningPanelHost,"minutes"|"expertsEnabled">={minutes:()=>20}){
  setLocale("en");const f=protectionFixture(),commands=new LearningCommandsV3(f.store),source={path:"Synthetic/card.md",version:"v1"},authority=localLearnerAuthority(),conversationId=crypto.randomUUID();
  const legacy=[createEpisode(source,"value-limit")],card=new LearningCardV3(commands,{readLegacy:async()=>completeRecordReadResult(legacy)});
  await card.load();const base=()=>({authority,conversationId,requestId:crypto.randomUUID(),source,signal:new AbortController().signal,ensureCurrent:async()=>{},present:()=>false});
  if(start)await card.start(base(),"value-limit");
  const parent=document.createElement("div");document.body.append(parent);const help=vi.fn(async()=>{}),draw=vi.fn(async()=>{}),explain=vi.fn(async()=>{}),expert=vi.fn(async()=>{});
  const run=vi.fn<LearningPanelHost["run"]>(async(action,present)=>action(card,{...base(),present}));
  const stop=mountLearningPanel(parent,{card,...settings,run,help,draw,explain,expert});cleanups.push(()=>{stop();card.dispose();});
  const root=parent.querySelector<HTMLDetailsElement>(".atl-learning-card")!;root.open=true;
  const button=(text:string)=>{const value=[...parent.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text);if(!value)throw new Error(`button missing: ${text}`);return value;};
  const episode=()=>{const selected=card.snapshot.selected;if(selected?.kind!=="v3")throw new Error("v3 required");return selected.episode;};
  const question=()=>{const e=episode();return renderQuestionV3(e.questions.find(q=>q.id===e.currentQuestionId)!);};
  const stored=()=>JSON.parse(f.files.get(`${f.root}/${episode().id}.json`)!) as EpisodeV3;
  const idle=async()=>vi.waitFor(()=>expect(button("Start with this source").disabled).toBe(false));
  const expand=()=>{const info=parent.querySelector<HTMLDetailsElement>(".atl-learning-explanation")!;info.open=true;info.dispatchEvent(new Event("toggle"));};
  return {...f,card,commands,legacy,source,parent,root,run,help,draw,explain,expert,stop,button,episode,question,stored,idle,expand};
}

describe("existing optional learning card on v3",()=>{
  it("refreshes settings without remounting the card or losing local drafts",async()=>{
    let minutes=20,experts=true;
    const r=await rig(true,{minutes:()=>minutes,expertsEnabled:()=>experts});
    const input=r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;
    input.value="7";input.dispatchEvent(new Event("input"));
    const reflection=r.parent.querySelector<HTMLTextAreaElement>('textarea[aria-label="Explain it in your own words"]')??r.parent.querySelector("textarea")!;
    reflection.value="my reasoning";reflection.dispatchEvent(new Event("input"));
    expect(r.button("Verify explanation")).toBeDefined();
    minutes=30;experts=false;r.stop.refresh();
    expect(r.parent.querySelector(".atl-learning-card")).toBe(r.root);expect(r.root.open).toBe(true);
    expect(r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!.value).toBe("7");
    expect(r.parent.querySelector("textarea")!.value).toBe("my reasoning");
    expect(r.parent.textContent).toContain("30");
    expect([...r.parent.querySelectorAll("button")].some(button=>button.textContent==="Verify explanation")).toBe(false);
    expect(r.run).not.toHaveBeenCalled();
  });
  it("keeps old history read-only and makes Start create v3 using the new-record host scope",async()=>{
    const r=await rig(false),before=structuredClone(r.legacy);r.card.select(`v1:${r.legacy[0]!.id}`);
    expect(r.parent.textContent).toContain("older record is read-only");expect(r.parent.querySelector("input")).toBeNull();expect(r.parent.querySelector(".atl-learning-explanation")).toBeNull();
    expect([...r.parent.querySelectorAll("button")].map(button=>button.textContent)).toEqual(["Start with this source"]);
    r.button("Start with this source").click();await r.idle();expect(r.episode().format).toBe(3);expect(r.run.mock.calls[0]![2]).toEqual({newRecord:true});expect(r.legacy).toEqual(before);
  });
  it("does not insert concept explanation or count help until explicit expansion passes the durable gate",async()=>{
    const r=await rig(),q=r.question(),gate=barrier(),prepare=r.commands.prepareHelp.bind(r.commands);
    vi.spyOn(r.commands,"prepareHelp").mockImplementation(async(...args)=>{await gate.wait();return prepare(...args);});
    expect(r.parent.textContent).not.toContain(q.explanation);expect(r.stored().help).toEqual([]);r.expand();await gate.reached;
    expect(r.parent.textContent).not.toContain(q.explanation);expect(r.stored().help).toEqual([]);gate.release();await r.idle();
    expect(r.parent.querySelector(".atl-learning-explanation p")!.textContent).toBe(q.explanation);expect(r.stored().help).toMatchObject([{kind:"related-discussion",state:"presented"}]);
    const info=r.parent.querySelector<HTMLDetailsElement>(".atl-learning-explanation")!;info.open=false;info.dispatchEvent(new Event("toggle"));r.expand();await Promise.resolve();expect(r.run).toHaveBeenCalledTimes(1);
  });
  it.each(["collapse","hidden"])("does not claim help was presented if the card becomes %s before insertion",async mode=>{
    const r=await rig(),gate=barrier(),prepare=r.commands.prepareHelp.bind(r.commands),q=r.question();
    vi.spyOn(r.commands,"prepareHelp").mockImplementation(async(...args)=>{const saved=await prepare(...args);await gate.wait();return saved;});
    r.button("Show a hint").click();await gate.reached;if(mode==="collapse")r.root.open=false;else r.parent.hidden=true;gate.release();await r.idle();
    expect(r.parent.textContent).not.toContain(q.hint);expect(r.stored().help[0]?.state).toBe("unknown");
  });
  it("keeps already visible help when confirmation fails and never inserts result text twice",async()=>{
    const r=await rig(),q=r.question();vi.spyOn(r.commands,"confirmHelp").mockRejectedValueOnce(new Error("confirmation failed"));
    r.button("Show a hint").click();await r.idle();expect(r.parent.querySelector(".atl-learning-feedback")!.textContent).toBe(q.hint);
    expect(r.stored().help[0]?.state).toBe("unknown");expect(r.parent.textContent).toContain("could not finish");expect(r.run).toHaveBeenCalledTimes(1);
  });
  it("uses solution for the existing direct-answer button and preserves coach/draw/expert callbacks",async()=>{
    const r=await rig(),solution=vi.spyOn(r.card,"solution");r.button("Direct answer").click();await r.idle();expect(solution).toHaveBeenCalledOnce();expect(r.stored().help[0]?.kind).toBe("solution");
    r.button("Work together").click();await r.idle();expect(r.help).toHaveBeenCalledOnce();r.button("Draw on a learning canvas").click();await r.idle();expect(r.draw).toHaveBeenCalledOnce();
    r.button("Verify explanation").click();await r.idle();expect(r.expert).toHaveBeenCalledWith("explanation");
  });
  it("keeps learner input after storage failure and never claims no commit occurred",async()=>{
    const r=await rig();vi.spyOn(r.card,"answer").mockRejectedValueOnce(new Error("write result unknown"));const input=r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;
    input.value="7";input.dispatchEvent(new Event("input"));r.button("Check and save").click();await r.idle();
    expect(r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!.value).toBe("7");expect(r.parent.textContent).toContain("Check the displayed record");expect(r.parent.textContent).not.toContain("Not saved;");
  });
  it("captures the clicked answer before the host waits, even if the field changes while busy",async()=>{
    const r=await rig(),gate=barrier(),run=r.run.getMockImplementation()!,answer=vi.spyOn(r.card,"answer");
    r.run.mockImplementationOnce(async(...args)=>{await gate.wait();return run(...args);});
    const input=r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;input.value="7";input.dispatchEvent(new Event("input"));r.button("Check and save").click();await gate.reached;
    const replacement=r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;replacement.value="9";replacement.dispatchEvent(new Event("input"));gate.release();await r.idle();
    expect(answer.mock.calls[0]![1]).toBe("7");
  });
  it("does not insert or automatically replay an explanation when preparation fails",async()=>{
    const r=await rig(),q=r.question(),prepare=vi.spyOn(r.commands,"prepareHelp").mockRejectedValueOnce(new Error("save failed"));r.expand();await r.idle();
    expect(r.parent.textContent).not.toContain(q.explanation);expect(r.stored().help).toEqual([]);expect(prepare).toHaveBeenCalledTimes(1);
    await new Promise(resolve=>setTimeout(resolve,0));expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("uses append-only correction for the old undo control and retains help",async()=>{
    const r=await rig(),q=r.question(),input=r.parent.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;input.value=q.answer;input.dispatchEvent(new Event("input"));r.button("Check and save").click();await r.idle();
    const before=r.stored(),undo=vi.spyOn(r.card,"undo");r.button("Correct last judgment").click();await r.idle();expect(undo).toHaveBeenCalledOnce();expect(r.stored().evidence.at(-1)?.type).toBe("correction");expect(r.stored().help).toEqual(before.help);
    expect(r.parent.textContent).not.toContain('"questionId"');
  });
  it("blocks a delayed presenter after unmount and preserves the prepared help",async()=>{
    const r=await rig(),gate=barrier(),prepare=r.commands.prepareHelp.bind(r.commands),id=r.episode().id;
    vi.spyOn(r.commands,"prepareHelp").mockImplementation(async(...args)=>{const saved=await prepare(...args);await gate.wait();return saved;});
    r.button("Show a hint").click();await gate.reached;r.stop();gate.release();await vi.waitFor(()=>expect(r.card.snapshot.busy).toBe(false));
    expect(r.parent.textContent).toBe("");expect((await r.store.list()).find(e=>e.id===id)?.help[0]?.state).toBe("prepared");
  });
});
