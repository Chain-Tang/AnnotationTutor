import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { captureDocumentEditTarget, applyDocumentEdit, type DocumentEditTarget, type DocumentFile } from "../src/document-edit-target.js";
import { uniqueTextTarget } from "../src/text-target.js";

// Exercise the exact plugin entry methods, isolating only Obsidian chrome and
// unrelated services. The production target helpers execute without mocks.
const source=readFileSync(new URL("../src/main.ts",import.meta.url),"utf8");
const start=source.indexOf("  public captureEditTarget("),end=source.indexOf("\n  /** One multi-turn API",start);
if(start<0||end<0)throw new Error("Document edit host fixture needs updated method boundaries");
const module={exports:{}};
new Function("module","captureDocumentEditTarget","applyDocumentEdit","uniqueTextTarget","MarkdownView","Notice","t",
  transformSync(`class Host {${source.slice(start,end)}}; module.exports=Host;`,{loader:"ts",format:"cjs"}).code
)(module,captureDocumentEditTarget,applyDocumentEdit,uniqueTextTarget,class {},class {},(key:string)=>key);
type Host = {app:unknown;lastMarkdownView:unknown;captureEditTarget(prefer?:string,source?:string):DocumentEditTarget|null;applyNoteEdit(target:DocumentEditTarget,text:string):boolean};
const Host=module.exports as new()=>Host;
function view(path:string,content:string,from=0,to=content.length) {
  let text=content;
  const file:DocumentFile={path,stat:{mtime:1,size:content.length}};
  const replaceRange=vi.fn((value:string,a:{ch:number},b=a)=>{text=text.slice(0,a.ch)+value+text.slice(b.ch);});
  return {file,leaf:{},getMode:()=>"source",editor:{getValue:()=>text,getSelection:()=>text.slice(from,to),
    getCursor:(side:string)=>({line:0,ch:side==="from"?from:to}),posToOffset:(p:{ch:number})=>p.ch,
    offsetToPos:(ch:number)=>({line:0,ch}),replaceRange,focus:vi.fn()}};
}
function fixture() {
  const original=view("original.md","word then word",10,14),other=view("other.md","word then word",0,4);
  let active=original;
  const views=[original,other],files=new Map([[original.file.path,original.file],[other.file.path,other.file]]);
  const host=new Host();host.lastMarkdownView=original;
  const workspace={getLeavesOfType:()=>views.map(view=>({view})),getActiveViewOfType:()=>active,revealLeaf:vi.fn()};
  host.app={workspace,vault:{getAbstractFileByPath:(path:string)=>files.get(path)}};
  return {host,original,other,views,files,workspace,activateOther:()=>{active=other;}};
}
describe("plugin document edit entry methods",()=>{
  it("captures the stated source despite another active file and applies to its selected duplicate",()=>{
    const f=fixture();f.activateOther();
    const target=f.host.captureEditTarget("word","original.md")!;
    expect(target.file).toBe(f.original.file);expect(target.text.start).toBe(10);
    expect(f.host.applyNoteEdit(target,"REPLACED")).toBe(true);
    expect(f.original.editor.getValue()).toBe("word then REPLACED");expect(f.other.editor.replaceRange).not.toHaveBeenCalled();
  });
  it("refuses an ambiguous annotation instead of borrowing the current selection or first occurrence",()=>{
    const f=fixture();f.original.editor.getSelection=()=>"then";
    expect(f.host.captureEditTarget("word","original.md")).toBeNull();
    expect(f.host.captureEditTarget("missing","original.md")).toBeNull();
  });
  it("never writes a captured target through a leaf switched to another file",()=>{
    const f=fixture(),target=f.host.captureEditTarget(undefined,"original.md")!;
    f.original.file=f.other.file;f.original.editor=f.other.editor;
    expect(f.host.applyNoteEdit(target,"WRONG")).toBe(false);
    expect(f.other.editor.replaceRange).not.toHaveBeenCalled();expect(f.workspace.revealLeaf).not.toHaveBeenCalled();
  });
  it("does not choose another file when the requested source is closed",()=>{
    const f=fixture();f.views.splice(0,1);f.activateOther();
    expect(f.host.captureEditTarget("word","original.md")).toBeNull();
  });
});
