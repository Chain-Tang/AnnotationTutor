import {describe,it,expect,vi} from "vitest";
import {runSupportResponse,supportControlSchema,hostSupportReply,type SupportAction} from "../src/support-response.js";
import {learningApiProtocol} from "../src/learning-api-protocol.js";
import {streamChatCompletion,type HttpStream} from "../src/api-stream.js";
import {DirectTutorAdapter} from "../src/tutor-agent-adapters.js";
const raw=(action:SupportAction,reply="")=>JSON.stringify({control:{action},reply});
const immediate={type:"immediate-support",phase:"urgent"} as const;
function fixture(){const shown:string[]=[],signal=new AbortController();return {shown,signal,options:{text:'我不确定能否保持安全',signal:signal.signal,present:(delta:string)=>{shown.push(delta);return true;},ensureCurrent:async()=>{}}};}
describe('ephemeral semantic support response gate (fake model boundary)',()=>{
 it('keeps a normal reply streaming in one request with no forced support script',async()=>{
  const f=fixture(),transport=vi.fn(async(_instructions:string,onDelta:(d:string)=>void)=>{onDelta(raw({type:'none'},'听你说。'));return {text:''};});
  const result=await runSupportResponse({...f.options,transport});expect(result.text).toBe('听你说。');expect(result.tracking).toBeUndefined();expect(f.shown.join('')).toBe(result.text);expect(transport).toHaveBeenCalledOnce();
 });
 it('suppresses unsafe model prose and presents bounded support only after completed transport',async()=>{
  const f=fixture(),data=raw(immediate,'UNSAFE_MODEL_TRAVEL_AND_ALWAYS_ONLINE'),transport=vi.fn(async(_i:string,onDelta:(d:string)=>void)=>{onDelta(data.slice(0,-1));await Promise.resolve();expect(f.shown).toEqual([]);onDelta(data.slice(-1));return {text:data};});
  const result=await runSupportResponse({...f.options,transport});expect(result.tracking).toBe('private');expect(result.text).toBe(hostSupportReply(immediate,f.options.text));expect(result.text).not.toContain('UNSAFE_MODEL');expect(f.shown).toEqual([result.text]);expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['cancel','truncated','suffix','source'] as const)('does not present a late fixed response after %s',async kind=>{
  const f=fixture();let stale=false;const data=raw(immediate,'PRIVATE'),transport=vi.fn(async(_i:string,d:(s:string)=>void)=>{d(kind==='truncated'?data.slice(0,-1):data);if(kind==='suffix')d(' extra');if(kind==='cancel')f.signal.abort();if(kind==='source')stale=true;return {text:data};});
  await expect(runSupportResponse({...f.options,transport,ensureCurrent:async()=>{if(stale)throw Error('changed');}})).rejects.toThrow();expect(f.shown).toEqual([]);expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['answer','pause','forget','invite','expert'])('rejects a learning/file action without authority or writes: %s',type=>{
  expect(supportControlSchema.safeParse({action:{type,questionId:crypto.randomUUID(),concept:'value-limit'}}).success).toBe(false);
 });
 it('does not recover a provider failure as an unverified safety success',async()=>{
  const f=fixture(),transport=vi.fn(async(_i:string,d:(s:string)=>void)=>{d(raw(immediate));throw Error('HTTP 403');});
  await expect(runSupportResponse({...f.options,transport})).rejects.toThrow('403');expect(f.shown).toEqual([]);expect(transport).toHaveBeenCalledOnce();
 });
 it('does not feed callbacks from a settled request into a later request',async()=>{
  const f=fixture();let late!:(d:string)=>void;
  await runSupportResponse({...f.options,transport:async(_i,d)=>{late=d;return {text:raw(immediate)};}});
  const before=[...f.shown];late(raw({type:'none'},'LATE'));expect(f.shown).toEqual(before);
 });
 it('does not turn an empty ordinary reply into invented support',async()=>{
  const f=fixture();await expect(runSupportResponse({...f.options,transport:async()=>({text:raw({type:'none'})})})).rejects.toThrow('empty-reply');expect(f.shown).toEqual([]);
 });
 it('honors cancellation triggered by the fixed-response presenter',async()=>{
  const f=fixture();await expect(runSupportResponse({...f.options,present:()=>{f.signal.abort();return true;},transport:async()=>({text:raw(immediate)})})).rejects.toMatchObject({name:'AbortError'});
 });
 it.each(['availability','exclusive','departure','unsafe-contact'] as const)('uses a nonexclusive response without exposing generated promises: %s',async need=>{
  const f=fixture(),action={type:'support-boundary',need} as const;
  const result=await runSupportResponse({...f.options,transport:async()=>({text:raw(action,'PROMISE_PERMANENT_AVAILABILITY')})});
  expect(result.text).toBe(hostSupportReply(action,f.options.text));expect(result.text).not.toContain('PROMISE_PERMANENT');
 });
 it('does not invent a self-harm impulse when the learner only cannot confirm safety',()=>{
  const reply=hostSupportReply({type:'immediate-support',phase:'connecting'},'我不确定自己是否安全，愿意联系可信的人')!;
  expect(reply).toContain('目前无法确保自己的安全');expect(reply).not.toContain('有伤害自己的冲动');
  const english=hostSupportReply(immediate,'I cannot be sure I can stay safe')!;
  expect(english).toContain('concerned about your immediate safety');expect(english).not.toContain('you may hurt yourself');
 });
 it('respects an unsafe-contact report without inventing a route, monitoring or indefinite presence',()=>{
  const reply=hostSupportReply({type:'support-boundary',need:'unsafe-contact'},'家人不是安全的人')!;
  expect(reply).toContain('你信任、且能安全联系到');expect(reply).not.toMatch(/我不会走开|一直陪|永远|已联系|必须去|明天/);
 });
 it.each(['disputed-fact','unknown-history','disagreement'] as const)('cannot stream invented memory or a saved-correction claim: %s',async need=>{
  const f=fixture(),action={type:'memory-clarification',need} as const;
  const data=raw(action,'你昨天看过提示，我已改好记录。'),transport=vi.fn(async(_i:string,onDelta:(s:string)=>void)=>{
   onDelta(data.slice(0,-1));await Promise.resolve();expect(f.shown).toEqual([]);onDelta(data.slice(-1));return {text:data};
  });
  const result=await runSupportResponse({...f.options,text:'你记错了',transport});
  expect(f.shown).toEqual([result.text]);expect(result.text).not.toMatch(/昨天|看过提示|已改好/);expect(transport).toHaveBeenCalledOnce();
 });
 it('rejects arbitrary learner facts and a record target on the memory clarification channel',()=>{
  for(const extra of [{fact:'我独立做对三次'},{evidenceId:crypto.randomUUID()},{questionId:crypto.randomUUID()},{recordUpdated:true}]){
   expect(supportControlSchema.safeParse({action:{type:'memory-clarification',need:'disputed-fact',...extra}}).success).toBe(false);
  }
 });
 it.each(['cancel','source','truncated'] as const)('does not display a memory clarification after %s',async kind=>{
  const f=fixture();let stale=false;const data=raw({type:'memory-clarification',need:'disputed-fact'},'INVENTED_MEMORY');
  await expect(runSupportResponse({...f.options,ensureCurrent:async()=>{if(stale)throw Error('changed');},transport:async(_i,delta)=>{
   delta(kind==='truncated'?data.slice(0,-1):data);if(kind==='cancel')f.signal.abort();if(kind==='source')stale=true;return {text:data};
  }})).rejects.toThrow();expect(f.shown).toEqual([]);
 });
 it('keeps a reliably provided past fact available in an ordinary streaming response',async()=>{
  const f=fixture(),reply='这轮提供的上一条消息说的是想休息。';
  const result=await runSupportResponse({...f.options,text:'上一条说什么',transport:async(_i,delta)=>{delta(raw({type:'none'},reply));return {text:''};}});
  expect(result.text).toBe(reply);expect(f.shown.join('')).toBe(reply);
 });
 it('shortens a repeated memory acknowledgment using only provided replies, without inventing a save or hint',async()=>{
  const f=fixture(),action={type:'memory-clarification',need:'disputed-fact'} as const;
  const first=hostSupportReply(action,'你记错了')!;
  const result=await runSupportResponse({...f.options,text:'继续时别算独立',priorReplies:[first],transport:async()=>({text:raw(action,'我记住了，你用过提示')})});
  expect(result.text.length).toBeLessThan(first.length);expect(result.text).not.toMatch(/记住|提示|保存/);
  expect(hostSupportReply(action,'再说一次',[first,result.text])!.length).toBeLessThan(result.text.length);
  expect(hostSupportReply(action,'你记错了',['任意过去说法'])).toBe(first);
 });
 it('does not count a different clarification or unprovided history as repetition',()=>{
  const a={type:'memory-clarification',need:'unknown-history'} as const,b={type:'memory-clarification',need:'disputed-fact'} as const;
  expect(hostSupportReply(a,'昨天的题',[hostSupportReply(b,'你记错了')!])).toBe(hostSupportReply(a,'昨天的题'));
 });
 it('answers offline capability from bounded host facts without changing storage settings',async()=>{
  const f=fixture(),action={type:'capability-info',topic:'offline'} as const;
  const result=await runSupportResponse({...f.options,text:'离线可以看聊天记录吗',transport:async()=>({text:raw(action,'只有模型要联网，聊天必须复制到笔记')})});
  expect(result.text).toContain('云端识别');expect(result.text).toContain('保存设置');expect(result.text).not.toMatch(/只有|必须复制/);
  expect(supportControlSchema.safeParse({action:{...action,saveEnabled:true}}).success).toBe(false);
 });
 it.each([
  '假如学生说用了提示，该怎么准确区分完成与独立？这是讨论规则，没有我的学习记录。',
  'Tutor 怎么区分自评、有提示完成和独立完成？',
  'How does Tutor distinguish a learner report from independently completed work?',
 ])('explains evidence rules without assigning a hypothetical history to the caller: %s',async text=>{
  const f=fixture(),action={type:'capability-info',topic:'learning-evidence'} as const;
  const transport=vi.fn(async()=>({text:raw(action,'你昨天看过提示，我已把记录改为独立完成。')}));
  const result=await runSupportResponse({...f.options,text,transport});
  expect(result.text).not.toMatch(/你说做过|你的自述|你昨天|已把记录|your account|you (?:used|completed|practiced)/i);
  expect(result.text).toMatch(/学习者自述|learner's report/i);
  expect(result.text).toMatch(/不把旧题改成独立完成|does not relabel the earlier attempt/i);
  expect(result.text).toMatch(/没有修改或评分|changes or scores nothing/i);
  expect(f.shown).toEqual([result.text]);expect(transport).toHaveBeenCalledOnce();
 });
 it.each(['assessment','monitoring'] as const)('bounds the %s capability without inventing a diagnosis or contact',async topic=>{
  const f=fixture(),action={type:'capability-info',topic} as const;
  expect(supportControlSchema.safeParse({action}).success).toBe(true);
  const result=await runSupportResponse({...f.options,text:'你能替我评估、监护或联系老师吗',transport:async(_i,delta)=>{
   delta(raw(action,'诊断需要当面，我已经联系老师，会一直监护。'));return {text:''};
  }});
  expect(f.shown).toEqual([result.text]);expect(result.text).not.toMatch(/当面|已经联系|一直监护|你患有/);
  expect(result.text).toContain(topic==='assessment'?'不能':'不会自行联系');
 });
 it.each(['pause','read-one-sentence','write-one-question'] as const)('offers one bounded optional action: %s',async step=>{
  const f=fixture(),action={type:'small-step',step} as const;
  expect(supportControlSchema.safeParse({action}).success).toBe(true);
  const transport=vi.fn(async(_i:string,delta:(s:string)=>void)=>{delta(raw(action,'先翻书，再读三行，最后复述。'));return {text:''};});
  const result=await runSupportResponse({...f.options,text:'现在只给我一个小步骤',transport});
  expect(f.shown).toEqual([result.text]);expect(result.text).not.toContain('先翻书，再读三行，最后复述。');
  expect(result.text).toContain('愿意');expect(transport).toHaveBeenCalledOnce();
  expect(supportControlSchema.safeParse({action:{...action,save:true}}).success).toBe(false);
 });
 it('rejects arbitrary micro-step prose, execution fields and late cancelled actions',async()=>{
  expect(supportControlSchema.safeParse({action:{type:'small-step',step:'contact-any-person'}}).success).toBe(false);
  expect(supportControlSchema.safeParse({action:{type:'small-step',step:'pause',instruction:'take medication'}}).success).toBe(false);
  const f=fixture();await expect(runSupportResponse({...f.options,transport:async(_i,delta)=>{
   delta(raw({type:'small-step',step:'pause'}));f.signal.abort();return {text:''};
  }})).rejects.toMatchObject({name:'AbortError'});expect(f.shown).toEqual([]);
 });
 it('uses the narrow support schema in the actual named tool request',async()=>{
  const f=fixture(),protocol=learningApiProtocol('https://api.deepseek.com/v1','deepseek-flash',true,'support'),args=raw(immediate,'UNSAFE'),calls:unknown[]=[];
  const http:HttpStream=async req=>{const body=JSON.parse(req.body);calls.push(body);expect(body.tool_choice.function.name).toBe('submit_tutor_reply');expect(JSON.stringify(body.tools)).not.toContain('questionId');expect(body).not.toHaveProperty('response_format');req.onResponse({status:200,contentType:'application/json'});req.onChunk(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call1',type:'function',function:{name:'submit_tutor_reply',arguments:args}}]},finish_reason:'tool_calls'}]}));};
  const result=await runSupportResponse({...f.options,transport:async(instructions,onDelta)=>{const r=await streamChatCompletion({baseUrl:'https://api.deepseek.com/v1',apiKey:'TEST',model:'deepseek-flash',signal:f.signal.signal,messages:[{role:'system',content:instructions}],...protocol.options,onDelta,timeoutMs:1000},http);if(!r.ok)throw Error(r.error);return {text:r.text};}});
  expect(calls).toHaveLength(1);expect(result.text).toBe(hostSupportReply(immediate,f.options.text));
 });
 it('applies the same non-mutating gate to a Direct Tutor expert artifact',async()=>{
  const emit=vi.fn(),http:HttpStream=async req=>{req.onResponse({status:200,contentType:'application/json'});req.onChunk(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call2',type:'function',function:{name:'submit_tutor_reply',arguments:raw(immediate,'UNSAFE')}}]},finish_reason:'tool_calls'}]}));};
  const adapter=new DirectTutorAdapter({baseUrl:'https://api.deepseek.com/v1',apiKey:'TEST',model:'deepseek-flash',httpStream:http});
  const result=await adapter.run({prompt:'我现在不安全',context:'authorized data only',signal:new AbortController().signal,emit,task:{} as never});
  expect((result[0]!.data as {text:string}).text).toBe(hostSupportReply(immediate,'我现在不安全'));expect(emit.mock.calls.flat().map(c=>JSON.stringify(c)).join('')).not.toContain('UNSAFE');
 });
});
