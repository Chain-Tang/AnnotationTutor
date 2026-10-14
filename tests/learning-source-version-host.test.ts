// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { contextVersion } from "../src/teaching-policy.js";
import { pdfLearningContext } from "../src/learning-pdf-context.js";
import { captureStudySource, readStudySource, studySourceView } from "../src/study-source-binding.js";
import { selectedStudyContext } from "../src/selection-context.js";
import type { ChatContext } from "../src/chat-prompt.js";

class TFile {
  constructor(public path:string,public extension="md"){}
  get basename(){return this.path.replace(/^.*\//,"").replace(/\.[^.]+$/,"");}
  stat={mtime:1791500000000,size:128};
}
class MarkdownView {
  readonly containerEl=document.createElement("div");readonly contentEl=document.createElement("div");
  selection="";buffer:string;
  constructor(public file:TFile,public mode:"preview"|"source",value:string,readonly livePreview=false){
    this.buffer=value;this.containerEl.append(this.contentEl);document.body.append(this.containerEl);
    this.contentEl.getBoundingClientRect=()=>({top:0,bottom:500,width:600,height:500} as DOMRect);
    const section=document.createElement("div");section.className="markdown-preview-section";
    const paragraph=document.createElement("div");paragraph.innerText=value;paragraph.getBoundingClientRect=()=>({top:10,bottom:100,width:500,height:90} as DOMRect);
    section.append(paragraph);this.contentEl.append(section);
  }
  getViewData(){return this.buffer;}
  getMode(){return this.mode;}getViewType(){return "markdown";}
  editor={getValue:()=>this.buffer,getSelection:()=>this.selection,getCursor:()=>({line:0,ch:0})};
}
type PdfView={file:TFile;containerEl:HTMLElement;getViewType:()=>"pdf"};
type View=MarkdownView|PdfView;
const source=readFileSync(resolve(process.cwd(),"src/main.ts"),"utf8");
function extract(start:string,end:string){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0)throw new Error("Source host fixture needs updated method boundaries");return source.slice(a,b);}
const module={exports:{}};
const dependencies={TFile,MarkdownView,pdfLearningContext,contextVersion,captureStudySource,readStudySource,studySourceView};
new Function("module",...Object.keys(dependencies),transformSync(`class Host {
${extract("  public async tutorContext(","\n  private async pairTutorClient(")}
${extract("  private async learningSourceRevision(","\n  private async runTutorConversation(")}
${extract("  public async chatContext(","\n  public learnerProfileSummary()")}
}; module.exports=Host;`,{loader:"ts",format:"cjs"}).code)(module,...Object.values(dependencies));
type Host={
  chatContext():Promise<ChatContext|null>;
  tutorContext(path:string,start:number,length:number,binding?:string):Promise<{source:string;start:number;end:number;text:string;revision:string;sourceBinding:string}>;
  captureLearningSource(path:string,view?:View):string;
  captureConversationContext(view:View):Promise<ChatContext>;
  learningSourceRevision(path:string,binding?:string):Promise<string|undefined>;
};
const Host=module.exports as {new():Host};
const text="# 极限与连续\n函数在点上的值不决定极限。\n例如 f(x)=x²，讨论 x 趋近 2。";
function fixture(mode:"reading"|"live-preview"|"source"="reading"){
  const host=new Host(),file=new TFile("Synthetic/limits.md"),files=new Map([[file.path,file]]),saved=new Map([[file.path,text]]);
  const view=new MarkdownView(file,mode==="reading"?"preview":"source",text,mode==="live-preview"),views:View[]=[view];let active:View|undefined=view;
  Object.assign(host,{app:{vault:{getAbstractFileByPath:(path:string)=>files.get(path),cachedRead:async(file:TFile)=>saved.get(file.path)??""},workspace:{get activeLeaf(){return {view:active};},getActiveViewOfType:(type:unknown)=>active instanceof (type as typeof MarkdownView)?active:null,getLeavesOfType:(type:string)=>views.filter(view=>view.getViewType()===type).map(view=>({view}))}},
    noteContent:async(path:string)=>saved.get(path)??"",learnerProfileSummary:()=>"",activeSceneSummary:()=>""});
  const setPdf=(body:string)=>{
    const pdf=new TFile("Synthetic/math.pdf","pdf"),containerEl=document.createElement("div");containerEl.innerHTML='<div class="page" data-page-number="1"><div class="textLayer"><span></span></div></div>';
    containerEl.querySelector("span")!.textContent=body;containerEl.getBoundingClientRect=()=>({top:0,bottom:500,width:600,height:500} as DOMRect);
    containerEl.querySelector(".page")!.getBoundingClientRect=()=>({top:20,bottom:400,width:600,height:380} as DOMRect);document.body.append(containerEl);
    const pdfView:PdfView={file:pdf,containerEl,getViewType:()=>"pdf"};files.set(pdf.path,pdf);views.push(pdfView);active=pdfView;return pdfView;
  };
  return {host,file,view,views,saved,files,setActive:(view?:View)=>{active=view;},setPdf};
}
afterEach(()=>{document.getSelection()?.removeAllRanges();document.body.innerHTML="";});

describe("real host source version producers",()=>{
  it.each(["reading","live-preview","source"] as const)("agrees across chat, source lease and tool excerpt in %s",async mode=>{
    const f=fixture(mode),chat=await f.host.chatContext(),context=await f.host.tutorContext(f.file.path,0,6000),lease=await f.host.learningSourceRevision(f.file.path);
    expect(chat!.content).toBe(text);expect(context.text).toBe(text);
    expect(chat!.observation!.version).toBe(contextVersion(text));expect(context.revision).toBe(chat!.observation!.version);expect(lease).toBe(context.revision);
  });
  it.each(["reading","live-preview","source"] as const)("preserves frozen selection version until actual document editing in %s",async mode=>{
    const f=fixture(mode);f.view.selection="函数在点上的值不决定极限。";
    const captured=selectedStudyContext(f.file.path,f.file.basename,f.view.selection,text),chat=await f.host.chatContext();
    expect(chat!.observation!.scope).toBe("selection");expect(captured.observation!.version).toBe(await f.host.learningSourceRevision(f.file.path));
    const edited=text.replace("不决定","会决定");if(mode==="reading")f.saved.set(f.file.path,edited);f.view.buffer=edited;
    const current=await f.host.chatContext(),lease=await f.host.learningSourceRevision(f.file.path);
    expect(lease).toBe(contextVersion(edited));expect(current!.observation!.version).toBe(lease);expect(captured.observation!.version).not.toBe(lease);
  });
  it.each(["live-preview","source"] as const)("versions the unsaved %s buffer rather than the saved file",async mode=>{
    const f=fixture(mode),draft=text+"\n还未保存的中文补充。";f.view.buffer=draft;
    const chat=await f.host.chatContext(),context=await f.host.tutorContext(f.file.path,5,12),lease=await f.host.learningSourceRevision(f.file.path);
    expect(f.saved.get(f.file.path)).toBe(text);expect(chat!.content).toBe(draft);expect(context.text).toBe(draft.slice(5,17));
    expect(lease).toBe(contextVersion(draft));expect(context.revision).toBe(lease);expect(chat!.observation!.version).toBe(lease);
  });
  it("uses the whole document revision for empty, partial and oversized excerpt requests",async()=>{
    const f=fixture("source"),chat=await f.host.chatContext();
    for(const [start,length] of [[0,0],[7,9],[0,10000],[text.length+5,3]]){
      const context=await f.host.tutorContext(f.file.path,start!,length!);
      expect(context.revision).toBe(chat!.observation!.version);
    }
  });
  it("changes a revision for same-length edits and agrees again after saving and switching to reading",async()=>{
    const f=fixture("source"),before=await f.host.learningSourceRevision(f.file.path),edited=text.replace("x²","x³");expect(edited.length).toBe(text.length);
    f.view.buffer=edited;const during=await f.host.chatContext();expect(during!.observation!.version).not.toBe(before);
    f.saved.set(f.file.path,edited);f.view.mode="preview";
    expect((await f.host.chatContext())!.observation!.version).toBe(during!.observation!.version);expect(await f.host.learningSourceRevision(f.file.path)).toBe(during!.observation!.version);
  });
  it.each(["", "x approaches 2 and f(x) approaches 4"])("agrees with the real PDF context for a scan or exposed text layer: %#",async body=>{
    const f=fixture(),pdf=f.setPdf(body),chat=await f.host.chatContext(),lease=await f.host.learningSourceRevision(pdf.file.path);
    expect(chat!.observation).toMatchObject({source:pdf.file.path,version:`${pdf.file.stat.mtime}:${pdf.file.stat.size}`,scope:body?"visible-text":"unavailable",hasImage:false});expect(lease).toBe(chat!.observation!.version);
    const before=lease;pdf.file.stat.mtime++;expect(await f.host.learningSourceRevision(pdf.file.path)).not.toBe(before);
    expect((await f.host.chatContext())!.observation!.version).toBe(await f.host.learningSourceRevision(pdf.file.path));
    const afterMtime=await f.host.learningSourceRevision(pdf.file.path);pdf.file.stat.size++;expect(await f.host.learningSourceRevision(pdf.file.path)).not.toBe(afterMtime);
  });
  it("uses the PDF file version for a real DOM selection and its frozen study context",async()=>{
    const f=fixture(),pdf=f.setPdf("selected mathematics"),span=pdf.containerEl.querySelector("span")!;
    const range=document.createRange();range.selectNodeContents(span);document.getSelection()!.addRange(range);
    const chat=await f.host.chatContext(),frozen=selectedStudyContext(pdf.file.path,pdf.file.basename,chat!.selection!,undefined,chat!.observation!.version);
    expect(chat!.selection).toBe("selected mathematics");expect(chat!.observation!.scope).toBe("selection");expect(frozen.observation!.version).toBe(await f.host.learningSourceRevision(pdf.file.path));
    await expect(f.host.tutorContext(pdf.file.path,0,100)).rejects.toThrow("text-context-unavailable");
  });
  it("returns no source lease after the file has been deleted",async()=>{
    const f=fixture();f.files.delete(f.file.path);expect(await f.host.learningSourceRevision(f.file.path)).toBeUndefined();
  });
});


describe("fixed source views across split panes",()=>{
  function split(mode:"reading"|"source"="source"){
    const f=fixture(mode),second=new MarkdownView(f.file,"source",text);f.views.push(second);f.setActive(second);return {...f,second};
  }
  it("captures the active unsaved editor when a reading split is enumerated first",async()=>{
    const f=split("reading");f.second.buffer=text+"\n新尝试";
    const chat=await f.host.chatContext();
    expect(chat!.content).toBe(f.second.buffer);expect(chat!.sourceBinding).toBeTruthy();
    expect(await f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).toBe(chat!.observation!.version);
    expect((await f.host.tutorContext(f.file.path,0,10000,chat!.sourceBinding)).text).toBe(f.second.buffer);
    // A path-only lookup uses the unambiguous editing buffer, never the first saved reading split.
    expect((await f.host.tutorContext(f.file.path,0,10000)).text).toBe(f.second.buffer);
  });
  it("detects edits in the captured second pane even when the first pane remains unchanged",async()=>{
    const f=split(),chat=await f.host.chatContext();f.second.buffer=text+"\n真实来源修改";
    expect(await f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).not.toBe(chat!.observation!.version);
  });
  it("does not cancel the captured pane because a different editor changes",async()=>{
    const f=split(),chat=await f.host.chatContext();f.view.buffer=text+"\n另一个缓冲";
    expect(await f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).toBe(chat!.observation!.version);
    await expect(f.host.tutorContext(f.file.path,0,100)).rejects.toMatchObject({name:"AbortError"});
    await expect(f.host.learningSourceRevision(f.file.path)).rejects.toMatchObject({name:"AbortError"});
  });
  it("does not redirect an in-flight token on focus or enumeration changes",async()=>{
    const f=split(),chat=await f.host.chatContext();f.view.buffer="别的窗口";f.setActive(f.view);f.views.reverse();
    const frozen=structuredClone({...chat,selectionBound:true});
    expect((await f.host.tutorContext(f.file.path,0,10000,frozen.sourceBinding)).text).toBe(text);
    expect(await f.host.learningSourceRevision(f.file.path,frozen.sourceBinding)).toBe(chat!.observation!.version);
  });
  it("a board can capture its own inactive pane instead of the focused document",async()=>{
    const f=split(),other=new TFile("Synthetic/other.md"),otherView=new MarkdownView(other,"source","别的文档");
    f.files.set(other.path,other);f.views.push(otherView);f.setActive(otherView);
    const chat=await f.host.captureConversationContext(f.second);
    expect(chat.notePath).toBe(f.file.path);expect(chat.content).toBe(text);
    expect(await f.host.learningSourceRevision(f.file.path,chat.sourceBinding)).toBe(chat.observation!.version);
  });
  it.each(["disconnected","removed","file-switched"] as const)("does not borrow the sibling after the original view is %s",async change=>{
    const f=split(),chat=await f.host.chatContext();
    if(change==="disconnected")f.second.containerEl.remove();
    if(change==="removed")f.views.splice(f.views.indexOf(f.second),1);
    if(change==="file-switched"){const other=new TFile("other.md");f.files.set(other.path,other);f.second.file=other;}
    await expect(f.host.tutorContext(f.file.path,0,10,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
  });
  it("does not revive a token after a previously observed close and reopen",async()=>{
    const f=split(),chat=await f.host.chatContext();f.second.containerEl.remove();
    await expect(f.host.tutorContext(f.file.path,0,10,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
    document.body.append(f.second.containerEl);
    await expect(f.host.tutorContext(f.file.path,0,10,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
    expect((await f.host.captureConversationContext(f.second)).sourceBinding).not.toBe(chat!.sourceBinding);
  });
  it("rejects a same-path replacement file and a renamed bound file",async()=>{
    const f=split(),chat=await f.host.chatContext();f.files.set(f.file.path,new TFile(f.file.path));
    await expect(f.host.tutorContext(f.file.path,0,10,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
    f.files.set(f.file.path,f.file);f.files.delete(f.file.path);f.file.path="renamed.md";f.files.set(f.file.path,f.file);
    await expect(f.host.tutorContext(f.file.path,0,10,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
  });
  it("rejects a replaced editor object instead of silently reading its new buffer",async()=>{
    const f=split(),chat=await f.host.chatContext();f.second.editor={...f.second.editor,getValue:()=>text};
    await expect(f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
  });
  it("uses the public reading buffer and survives same-view reading/source transitions",async()=>{
    const f=fixture();f.view.buffer=text+"\n尚未落盘的阅读缓冲";
    const chat=await f.host.chatContext();expect(chat!.content).toBe(f.view.buffer);expect(f.saved.get(f.file.path)).toBe(text);
    f.view.mode="source";expect(await f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).toBe(chat!.observation!.version);
    f.view.buffer+="\n编辑";f.view.mode="preview";
    expect(await f.host.learningSourceRevision(f.file.path,chat!.sourceBinding)).toBe(contextVersion(f.view.buffer));
  });
  it("pins a file-only request and does not silently switch to a newly opened unsaved buffer",async()=>{
    const f=fixture();f.views.length=0;f.view.containerEl.remove();
    const captured=await f.host.tutorContext(f.file.path,0,10000);
    const view=new MarkdownView(f.file,"source","新的未保存内容");f.views.push(view);
    expect((await f.host.tutorContext(f.file.path,0,10000,captured.sourceBinding)).text).toBe(text);
  });
  it("rejects forged, cross-host and wrong-file capabilities",async()=>{
    const f=fixture(),chat=await f.host.chatContext(),other=fixture();
    await expect(f.host.tutorContext(f.file.path,0,1,"forged")).rejects.toMatchObject({name:"AbortError"});
    await expect(other.host.tutorContext(other.file.path,0,1,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
    const otherFile=new TFile("Synthetic/other.md");f.files.set(otherFile.path,otherFile);
    await expect(f.host.tutorContext(otherFile.path,0,1,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
  });
  it("rejects divergent reading buffers for a path-only lookup",async()=>{
    const f=fixture(),second=new MarkdownView(f.file,"preview","不同阅读缓冲");f.views.push(second);
    await expect(f.host.tutorContext(f.file.path,0,10)).rejects.toMatchObject({name:"AbortError"});
    expect((await f.host.captureConversationContext(f.view)).content).toBe(text);
  });
  it("rejects a view changed during asynchronous context assembly",async()=>{
    const f=fixture("source");
    Object.assign(f.host,{learnerProfileSummary:()=>{f.view.buffer+="\n期间修改";return "";}});
    await expect(f.host.captureConversationContext(f.view)).rejects.toMatchObject({name:"AbortError"});
  });
  it("rejects an original view removed during the first snapshot await",async()=>{
    const f=fixture("source"),pending=f.host.captureConversationContext(f.view);f.view.containerEl.remove();
    await expect(pending).rejects.toMatchObject({name:"AbortError"});
  });
  it("does not invent an initial active source among divergent splits or different documents",async()=>{
    const f=split();f.second.buffer="不同编辑内容";f.setActive();
    await expect(f.host.chatContext()).rejects.toMatchObject({name:"AbortError"});
    const other=new TFile("other.md");f.files.set(other.path,other);f.views.push(new MarkdownView(other,"source","其他"));
    expect(await f.host.chatContext()).toBeNull();
  });
  it("pins PDF identity and never borrows another PDF split",async()=>{
    const f=fixture(),pdf=f.setPdf("数学"),chat=await f.host.chatContext();
    const sibling={...pdf,containerEl:document.createElement("div")};document.body.append(sibling.containerEl);f.views.push(sibling);pdf.containerEl.remove();
    await expect(f.host.learningSourceRevision(pdf.file.path,chat!.sourceBinding)).rejects.toMatchObject({name:"AbortError"});
  });
});
