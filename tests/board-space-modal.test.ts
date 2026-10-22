// @vitest-environment happy-dom
import {afterEach,describe,it,expect,vi} from 'vitest';
const modals=vi.hoisted(()=>[] as any[]);
vi.mock('obsidian',()=>({Modal:class {
 titleEl=document.createElement('h2');contentEl=document.createElement('div');onClose=()=>{};
 constructor(){modals.push(this);Object.assign(this.contentEl,{createEl:(tag:string,options:{text?:string,cls?:string}={})=>{const el=document.createElement(tag);el.textContent=options.text??'';el.className=options.cls??'';this.contentEl.append(el);return el;}});}
 open(){document.body.append(this.contentEl);}close(){this.contentEl.remove();this.onClose();}
}}));
import {chooseDrawingStudio} from '../src/board-space-modal.js';
import type {App} from 'obsidian';
afterEach(()=>{modals.splice(0);document.body.replaceChildren();});
describe('explicit fallback destination',()=>{
 it('never opts into Studio on dismissal',async()=>{const result=chooseDrawingStudio({} as App,new AbortController().signal);modals[0].close();expect(await result).toBe(false);});
 it('requires the explicit Studio button',async()=>{const result=chooseDrawingStudio({} as App,new AbortController().signal);document.querySelector<HTMLButtonElement>('.mod-cta')!.click();expect(await result).toBe(true);});
 it('cancels a pending choice without creating another document',async()=>{const controller=new AbortController();const result=chooseDrawingStudio({} as App,controller.signal);controller.abort();expect(await result).toBe(false);expect(document.body.childElementCount).toBe(0);});
 it('does not open a modal for an already cancelled request',async()=>{const controller=new AbortController();controller.abort();expect(await chooseDrawingStudio({} as App,controller.signal)).toBe(false);expect(modals).toHaveLength(0);});
});
