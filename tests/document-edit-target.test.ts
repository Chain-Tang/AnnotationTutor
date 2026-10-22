import { describe, expect, it, vi } from "vitest";
import { applyDocumentEdit, captureDocumentEditTarget, type DocumentBuffer, type DocumentFile } from "../src/document-edit-target.js";

function editor(initial: string) {
  let text=initial;
  const replaceRange=vi.fn((value:string,from:{line:number;ch:number},to=from)=>{
    text=text.slice(0,from.ch)+value+text.slice(to.ch);
  });
  return {getValue:()=>text,offsetToPos:(ch:number)=>({line:0,ch}),replaceRange,setValue:(value:string)=>{text=value;}};
}
function fixture(initial="word then word",start=10,end=14) {
  const file:DocumentFile={path:"original.md",stat:{mtime:1,size:initial.length}};
  const original=editor(initial), files=new Map<string,DocumentFile>([[file.path,file]]);
  const host={vault:{},fileAt:(path:string)=>files.get(path),buffers:[{file,editor:original}] as DocumentBuffer[]};
  const target=captureDocumentEditTarget(host,file,original,start,end)!;
  return {file,original,files,host,target,apply:(text="REPLACED")=>applyDocumentEdit(target,text,host)};
}

describe("document edit target protection",()=>{
  it("edits the captured second occurrence with one buffer transaction and an honest receipt",()=>{
    const f=fixture(), result=f.apply();
    expect(f.original.getValue()).toBe("word then REPLACED");
    expect(f.original.replaceRange).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ok:true,receipt:{targetId:f.target.documentId,requestId:f.target.requestId,path:"original.md",baseRevision:f.target.bufferRevision,durability:"applied-not-durable"}});
  });
  it("maps an insertion before the original second occurrence",()=>{
    const f=fixture();f.original.setValue("new word then word");f.apply();
    expect(f.original.getValue()).toBe("new word then REPLACED");
  });
  it.each(["word then changed","word then ","word"])("preserves concurrent selection edits: %s",current=>{
    const f=fixture();f.original.setValue(current);
    expect(f.apply()).toEqual({ok:false,reason:"range"});
    expect(f.original.getValue()).toBe(current);expect(f.original.replaceRange).not.toHaveBeenCalled();
  });
  it("refuses a same-editor file switch even when the new text is identical",()=>{
    const f=fixture(),other={path:"other.md",stat:{mtime:1,size:14}};
    f.host.buffers=[{file:other,editor:f.original}];f.files.set(other.path,other);
    expect(f.apply()).toEqual({ok:false,reason:"closed"});expect(f.original.replaceRange).not.toHaveBeenCalled();
  });
  it("finds the original identity in another leaf without touching the switched file",()=>{
    const f=fixture(),other={path:"other.md",stat:{mtime:1,size:14}}, switched=editor("word then word");
    f.host.buffers=[{file:other,editor:switched},{file:f.file,editor:f.original}];
    expect(f.apply().ok).toBe(true);expect(switched.replaceRange).not.toHaveBeenCalled();
  });
  it("follows a renamed file object and reports the new path",()=>{
    const f=fixture();f.files.delete(f.file.path);f.file.path="renamed.md";f.files.set(f.file.path,f.file);
    expect(f.apply()).toMatchObject({ok:true,receipt:{targetId:f.target.documentId,path:"renamed.md"}});
  });
  it.each([false,true])("does not recreate a deleted target (replacement exists: %s)",recreate=>{
    const f=fixture();f.files.delete(f.file.path);
    if(recreate)f.files.set(f.file.path,{...f.file});
    expect(f.apply()).toEqual({ok:false,reason:"identity"});expect(f.original.replaceRange).not.toHaveBeenCalled();
  });
  it("retains a proposal while closed and can apply after the same file is reopened",()=>{
    const f=fixture();f.host.buffers=[];
    expect(f.apply()).toEqual({ok:false,reason:"closed"});
    const reopened=editor(f.original.getValue());f.host.buffers=[{file:f.file,editor:reopened}];
    expect(f.apply().ok).toBe(true);expect(reopened.getValue()).toBe("word then REPLACED");expect(f.original.replaceRange).not.toHaveBeenCalled();
  });
  it("rejects divergent split buffers both at capture and application",()=>{
    const f=fixture(),split=editor("different unsaved text");f.host.buffers.push({file:f.file,editor:split});
    expect(captureDocumentEditTarget(f.host,f.file,f.original,10,14)).toBeNull();
    expect(f.apply()).toEqual({ok:false,reason:"buffers"});
    expect(f.original.replaceRange).not.toHaveBeenCalled();expect(split.replaceRange).not.toHaveBeenCalled();
  });
  it("uses the original buffer when split buffers agree",()=>{
    const f=fixture(),split=editor(f.original.getValue());f.host.buffers.unshift({file:f.file,editor:split});
    expect(f.apply().ok).toBe(true);expect(f.original.replaceRange).toHaveBeenCalledOnce();expect(split.replaceRange).not.toHaveBeenCalled();
  });
  it("stops when a disk revision changed under an open buffer",()=>{
    const f=fixture();f.file.stat.mtime=2;
    expect(f.apply()).toEqual({ok:false,reason:"disk"});expect(f.original.replaceRange).not.toHaveBeenCalled();
  });
  it("returns the same receipt on a double click and never reapplies after undo",()=>{
    const f=fixture(),first=f.apply();f.original.setValue(f.target.text.content);
    const second=f.apply();expect(second).toMatchObject({ok:true});
    if(first.ok && second.ok)expect(second.receipt).toBe(first.receipt);
    expect(f.original.replaceRange).toHaveBeenCalledOnce();expect(f.original.getValue()).toBe(f.target.text.content);
    expect(f.apply("DIFFERENT")).toEqual({ok:false,reason:"already-applied"});
  });
  it("inserts at the captured cursor after preceding edits and pads a block once",()=>{
    const f=fixture("prefix\nlast",7,7);f.original.setValue("new prefix\nlast");
    const block="```txt\nexample\n```";
    expect(f.apply(block).ok).toBe(true);expect(f.original.getValue()).toBe("new prefix\n\n"+block+"\n\nlast");
    expect(f.apply(block).ok).toBe(true);expect(f.original.replaceRange).toHaveBeenCalledOnce();
  });
  it("shares idempotency between the captured selection and its insertion variant",()=>{
    const f=fixture(),insertion={...f.target,hasSelection:false,original:""};
    expect(applyDocumentEdit(insertion,"BLOCK",f.host).ok).toBe(true);
    expect(f.apply("BLOCK")).toEqual({ok:false,reason:"already-applied"});expect(f.original.replaceRange).toHaveBeenCalledOnce();
  });
  it("does not apply a target in another vault",()=>{
    const f=fixture();f.host.vault={};expect(f.apply()).toEqual({ok:false,reason:"identity"});
  });
  it("does not repeat a buffer transaction after a host exception with an unknown outcome",()=>{
    const f=fixture();f.original.replaceRange.mockImplementation(()=>{f.original.setValue("word then REPLACED");throw new Error("host callback failed");});
    expect(f.apply()).toEqual({ok:false,reason:"outcome-unknown"});
    expect(f.apply()).toEqual({ok:false,reason:"outcome-unknown"});
    expect(f.original.getValue()).toBe("word then REPLACED");expect(f.original.replaceRange).toHaveBeenCalledOnce();
  });
});
