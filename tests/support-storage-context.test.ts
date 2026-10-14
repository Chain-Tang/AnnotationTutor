import {describe,it,expect,vi} from "vitest";
import {localLearnerAuthority} from "../src/learning-control-v3.js";
import {resolveSupportStorageContext} from "../src/support-storage-context.js";
import {hostSupportReply,runSupportResponse,supportControlSchema,supportStorageLease,type SupportStorageContext} from "../src/support-response.js";

const action={type:"capability-info",topic:"storage"} as const;
describe('actual persistence facts, separate from prose and receipts',()=>{
 it.each(['sidebar','board','legacy-card'] as const)('uses actual chat settings for local %s only',entry=>{
  const identity={entry,kind:'conversation',authority:localLearnerAuthority()} as const;
  expect(resolveSupportStorageContext(identity,true)).toEqual({surface:'chat',chatLog:'enabled'});
  expect(resolveSupportStorageContext(identity,false)).toEqual({surface:'chat',chatLog:'disabled'});
 });
 it('keeps annotation persistence distinct from disabled shared chat',()=>{
  expect(resolveSupportStorageContext({entry:'annotation',kind:'conversation',authority:localLearnerAuthority()},false)).toEqual({surface:'annotation'});
 });
 it('does not trust serialized authority, source labels or external clients',()=>{
  const authority=localLearnerAuthority();
  for(const identity of [undefined,{entry:'sidebar',kind:'conversation'},{entry:'sidebar',kind:'conversation',authority:JSON.parse(JSON.stringify(authority))},{entry:'external',kind:'conversation',authority},{entry:'sidebar',kind:'document-edit',authority}] as const)
   expect(resolveSupportStorageContext(identity,true)).toEqual({surface:'unknown'});
 });
 it.each([{surface:'chat',chatLog:'enabled'},{surface:'chat',chatLog:'disabled'},{surface:'annotation'},{surface:'temporary',summaryStorage:'available'},{surface:'temporary',summaryStorage:'unavailable'},{surface:'unknown'}] as const)('does not convert %j into a successful save/delete or provider confidentiality',storage=>{
  const reply=hostSupportReply(action,'你会保存困扰吗',[],storage)!;
  expect(reply).toContain('不是删除回执');expect(reply).toContain('供应商');expect(reply).not.toMatch(/已删除|本次已(?:经|成功)?保存|这次已(?:经|成功)?保存|什么都没保存|不留任何记录/);
  if(storage.surface==='chat')expect(reply).toContain(storage.chatLog==='enabled'?'开启本地聊天记录':'关闭本地聊天记录');
  if(storage.surface==='annotation')expect(reply).toContain('批注');
  if(storage.surface==='temporary')expect(reply).toContain(storage.summaryStorage==='available'?'明确确认':'摘要保存不可用');
  if(storage.surface==='unknown')expect(reply).toContain('无法');
 });
 it('provides bounded storage facts in the primary request and suppresses fabricated guarantees',async()=>{
  const shown:string[]=[],storageContext=vi.fn(():SupportStorageContext=>({surface:'chat',chatLog:'disabled'}));
  const raw=JSON.stringify({control:{action},reply:'没有写入任何地方，已经删除，供应商不保存'});
  const transport=vi.fn(async(instructions:string,delta:(s:string)=>void)=>{expect(instructions).toContain('"chatLog":"disabled"');delta(raw.slice(0,-1));await Promise.resolve();expect(shown).toEqual([]);delta(raw.slice(-1));return {text:raw};});
  const result=await runSupportResponse({text:'聊天是否保存',signal:new AbortController().signal,storageContext,present:s=>{shown.push(s);return true;},ensureCurrent:async()=>{},transport});
  expect(result.text).toContain('关闭本地聊天记录');expect(result.text).not.toContain('已经删除');expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['none','capability-info'] as const)('invalidates a late %s response after the chat setting changes',async type=>{
  let enabled=true;const shown:string[]=[],raw=JSON.stringify({control:{action:type==='none'?{type}:action},reply:'STALE'});
  const transport=vi.fn(async()=>{enabled=false;return {text:raw};});
  await expect(runSupportResponse({text:'现在会保存吗',signal:new AbortController().signal,storageContext:()=>({surface:'chat',chatLog:enabled?'enabled':'disabled'}),present:s=>{shown.push(s);return true;},ensureCurrent:async()=>{},transport})).rejects.toMatchObject({name:'AbortError'});
  expect(shown).toEqual([]);expect(transport).toHaveBeenCalledOnce();
 });
 it('gives ordinary streaming replies the actual facts without a second classifier or fixed boilerplate',async()=>{
  const shown:string[]=[],reply='普通自然回复',raw=JSON.stringify({control:{action:{type:'none'}},reply});
  const transport=vi.fn(async(instructions:string,delta:(s:string)=>void)=>{expect(instructions).toContain('"surface":"annotation"');delta(raw);return {text:''};});
  const result=await runSupportResponse({text:'请解释正文',signal:new AbortController().signal,storageContext:()=>({surface:'annotation'}),present:s=>{shown.push(s);return true;},ensureCurrent:async()=>{},transport});
  expect(shown.join('')).toBe(reply);expect(result.text).toBe(reply);expect(transport).toHaveBeenCalledOnce();
 });
 it('rejects extra secrets or model receipts in host facts before transport',async()=>{
  const transport=vi.fn();
  for(const injected of [{surface:'chat',chatLog:'disabled',apiKey:'SECRET'},{surface:'unknown',deleted:true},{surface:'temporary',summaryStorage:'available',path:'/private'}]){
   await expect(runSupportResponse({text:'保存吗',signal:new AbortController().signal,storageContext:()=>injected as SupportStorageContext,present:()=>true,ensureCurrent:async()=>{},transport})).rejects.toThrow('support-storage-context-invalid');
  }
  expect(transport).not.toHaveBeenCalled();
  expect(supportStorageLease().context).toEqual({surface:'unknown'});
 });
 it('does not accept settings or a successful deletion claim from model control',()=>{
  for(const extra of [{chatLog:'disabled'},{storageContext:{surface:'temporary'}},{deleted:true},{saved:true}])expect(supportControlSchema.safeParse({action:{...action,...extra}}).success).toBe(false);
 });
 it('preserves helped history when explaining later independent evidence, without judging an actual attempt',()=>{
  const reply=hostSupportReply({type:'capability-info',topic:'learning-evidence'},'提示后完成怎么判断')!;
  expect(reply).toContain('不把旧题改成独立完成');expect(reply).toContain('自述');expect(reply).toContain('没有修改或评分');
 });
});
