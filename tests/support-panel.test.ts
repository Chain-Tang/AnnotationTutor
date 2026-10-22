// @vitest-environment happy-dom
import {it,expect,beforeAll,vi} from 'vitest';
import {mountSupportPanel,mountSupportCheckin} from '../src/support-panel.js';
import {SupportSession,type SupportStorage} from '../src/support-session.js';
beforeAll(()=>{
 Object.defineProperty(HTMLElement.prototype,'createEl',{configurable:true,value:function(tag:string,o:{cls?:string;text?:string;attr?:Record<string,string>;placeholder?:string}={}){const el=this.ownerDocument.createElement(tag);if(o.cls)el.className=o.cls;if(o.text)el.textContent=o.text;for(const [k,v]of Object.entries(o.attr??{}))el.setAttribute(k,v);if(o.placeholder)el.setAttribute('placeholder',o.placeholder);this.append(el);return el;}});
 Object.defineProperty(HTMLElement.prototype,'createDiv',{configurable:true,value:function(o:object={}){return this.createEl('div',o);}});
 Object.defineProperty(HTMLElement.prototype,'empty',{configurable:true,value:function(){this.replaceChildren();}});
});
const db=()=>({available:()=>true,load:async()=>[],save:vi.fn(async()=>{}),readDay:async()=>'',writeDay:async()=>{}} satisfies SupportStorage);
it('both views defer an opt-in checkin while busy and skip consumes the shared opportunity without taking focus',async()=>{
 const s=new SupportSession(db(),async()=>''),a=document.createElement('div'),b=document.createElement('div'),editor=document.createElement('input');document.body.append(a,b,editor);editor.focus();let quiet=false;
 const stopA=mountSupportCheckin(a,s,{quiet:()=>quiet,open:()=>s.open()}),stopB=mountSupportCheckin(b,s,{quiet:()=>quiet,open:()=>s.open()});await s.activity(true);
 const card=(root:HTMLElement)=>root.querySelector('.atl-support-card') as HTMLElement;
 expect(card(a).hidden).toBe(true);expect(card(b).hidden).toBe(true);expect(document.activeElement).toBe(editor);
 quiet=true;s.notify();expect(card(a).hidden).toBe(false);expect(card(b).hidden).toBe(false);s.skip();await s.activity(true);expect(card(a).hidden).toBe(true);expect(card(b).hidden).toBe(true);stopA();stopB();s.dispose();a.remove();b.remove();editor.remove();
});
it('ready to learn dismisses the check-in without opening another conversation or sending anything',async()=>{
 const s=new SupportSession(db(),async()=>''),root=document.createElement('div'),open=vi.fn();const stop=mountSupportCheckin(root,s,{quiet:()=>true,open});
 expect((root.firstElementChild as HTMLElement).hidden).toBe(true);expect(root.querySelector('textarea')).toBeNull();await s.activity(true);root.querySelector('button')!.click();
 expect(s.pending).toBe(false);expect(s.opened).toBe(false);expect(open).not.toHaveBeenCalled();stop();s.dispose();
});
it('a failed explicit summary save retains the draft and exposes a persistent failure message',async()=>{
 const storage=db();storage.save.mockRejectedValueOnce(new Error('disk full'));const s=new SupportSession(storage,async()=>''),root=document.createElement('div');document.body.append(root);const stop=mountSupportPanel(root,s,{quiet:()=>true,days:()=>7});s.open();const fields=root.querySelectorAll('textarea');fields[1]!.value='confirmed fixture';const button=fields[1]!.nextElementSibling as HTMLButtonElement;button.click();await vi.waitFor(()=>expect(s.error).toBe('support-save-failed'));expect(fields[1]!.value).toBe('confirmed fixture');expect(root.querySelector('[role=status]')!.textContent).toBeTruthy();expect(s.summaries).toEqual([]);s.close();expect(fields[1]!.value).toBe('');stop();s.dispose();root.remove();
});
