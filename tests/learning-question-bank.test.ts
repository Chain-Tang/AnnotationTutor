import {describe,it,expect,vi,afterEach} from 'vitest';
import {questionTemplates,instantiateQuestion,nextQuestion} from '../src/learning-question-bank.js';
import {conceptIds,gradeMathAnswer} from '../src/learning-episode.js';
import {compileMathPlot} from '../src/board-math.js';
import {LearningDialogue} from '../src/learning-dialogue.js';
import {LearningV2Store} from '../src/learning-v2.js';
afterEach(()=>vi.useRealTimers());
const setup=()=>{const f=new Map<string,string>();const store=new LearningV2Store({read:async p=>f.get(p)??null,list:async p=>[...f.keys()].filter(k=>k.startsWith(p+'/')),write:async(p,t)=>{f.set(p,t);},compareWrite:async(p,b,n)=>{if((f.get(p)??null)!==b)throw Error('conflict');f.set(p,n);}},'v2');const dialogue=new LearningDialogue(store,async()=>[]);const conversationId=crypto.randomUUID();const turn=(text:string)=>dialogue.prepare({text,conversationId,requestId:crypto.randomUUID(),source:{path:'a.md',version:'1'}});const act=async(type:any,text='')=>dialogue.apply(await turn(text),{type},new AbortController().signal);return {store,dialogue,turn,act};};
describe('54 bounded authored templates',()=>{
  it('has exactly three templates for each concept and pool',()=>{expect(questionTemplates).toHaveLength(54);expect(new Set(questionTemplates.map(t=>t.id)).size).toBe(54);for(const c of conceptIds)for(const p of ['practice','transfer','delayed'] as const)expect(questionTemplates.filter(t=>t.concept===c&&t.pool===p)).toHaveLength(3);});
  for(const c of conceptIds)for(const p of ['practice','transfer','delayed'] as const)it(`${c}/${p} answers and bounded parameters`,()=>{
    for(let seed=0;seed<75;seed++){const q=instantiateQuestion(c,p,seed),same=instantiateQuestion(c,p,seed);expect(q.prompt).toBe(same.prompt);expect(q.answer).toBe(same.answer);expect(q.id).not.toBe(same.id);
      expect(gradeMathAnswer({id:q.id,prompt:q.prompt,answer:q.answer,explanation:q.explanation,kind:q.kind as 'choice'|'number'},q.answer)).toBe(true);
      if(q.kind==='choice')expect(q.choices).toContain(q.answer);else expect(Number.isFinite(Number(q.answer))).toBe(true);
      if(q.math){const objects=compileMathPlot(q.math,{width:600,height:600});expect(objects.some(o=>o.kind==='ellipse')).toBe(true);expect(seed%3===1?q.math.curves[0]?.valueAt[0]?.y:q.math.limits[0]?.value).toBe(Number(q.answer));}
    }
  });
  it('matches the independently reviewed answer key for all 54 templates',()=>{
    const key={
      'value-limit':[['9','0','5'],['6','不相等','2'],['-1','5','2.5']],
      'one-sided':[['不存在','5','2'],['5','不存在','2'],['4','存在','2']],
      neighborhood:[['0.1','0.4','0.25'],['0.2','0.25','足够'],['0.05','0.06','能']],
      removable:[['6','8','是'],['2','6','2'],['0','2','能']],
      jump:[['不能','2','跳跃间断'],['3','不能','-2'],['-5','不属于','不会']],
      continuity:[['不连续','2','连续'],['8','不够','2'],['2','不能','3']],
    };
    for(const c of conceptIds)for(const [p,pool]of (['practice','transfer','delayed'] as const).entries())for(let variant=0;variant<3;variant++)expect(instantiateQuestion(c,pool,variant).answer).toBe(key[c][p]![variant]);
  });
  it('checks equations independently at boundary parameters',()=>{for(const seed of [0,2,72,74]){const q=instantiateQuestion('value-limit','practice',seed),{a,b}=q.parameters;if(seed%3===0)expect(Number(q.answer)).toBe(a!**2);if(seed%3===2)expect(Number(q.answer)).toBe(a!+b!);const continuity=instantiateQuestion('continuity','delayed',seed);if(seed%3===2)expect(Number(continuity.answer)).toBe(continuity.parameters.a!*(continuity.parameters.b!-1));}expect(()=>instantiateQuestion('jump','practice',NaN)).toThrow();expect(()=>instantiateQuestion('jump','practice',1e7)).toThrow();});
  it('never reuses a displayed delayed prompt, even for unused parameter changes',()=>{const seen=[];for(let i=0;i<5;i++){const q=nextQuestion('jump','delayed',seen);expect(seen.some(p=>p.prompt===q.prompt)).toBe(false);seen.push(q);}const practice=instantiateQuestion('value-limit','practice');const transfer=nextQuestion('value-limit','transfer',[practice]);const delayed=nextQuestion('value-limit','delayed',[practice,transfer]);expect(delayed.templateId).not.toBe(transfer.templateId);expect(delayed.prompt).not.toBe(practice.prompt);});
});
describe('delayed evidence and scheduling',()=>{
  it('schedules unseen questions and restarts after help or a failed delayed answer',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-27T04:00:00Z'));const f=setup();await f.dialogue.apply(await f.turn('练习'),{type:'invite',concept:'value-limit'},new AbortController().signal);await f.act('accept','好的');
    const answer=async()=>{const e=(await f.store.list())[0]!,q=e.questions.find(q=>q.id===e.currentQuestionId)!;await f.act('answer',q.answer);};
    await answer();await answer();let e=(await f.store.list())[0]!;expect(e.reviewDue).toBe(new Date(Date.now()+86400000).toISOString());
    await f.act('resume','继续');expect((await f.store.list())[0]!.questions).toHaveLength(2);
    for(const [advance,nextDays] of [[1,3],[3,7],[7,0]]){vi.setSystemTime(Date.now()+advance!*86400000);const seen=(await f.store.list())[0]!.questions.map(q=>q.prompt);await f.act('resume','继续');e=(await f.store.list())[0]!;const q=e.questions.at(-1)!;expect(q.pool).toBe('delayed');expect(seen).not.toContain(q.prompt);await answer();e=(await f.store.list())[0]!;expect(e.evidence.at(-1)?.kind).toBe('delayed');expect(e.reviewDue).toBe(nextDays?new Date(Date.now()+nextDays*86400000).toISOString():undefined);}
  });
});
it('an exact current choice cannot be misclassified as disputing a previous result',async()=>{const f=setup();await f.dialogue.apply(await f.turn('练习'),{type:'invite',concept:'value-limit'},new AbortController().signal);await f.act('accept','好');let e=(await f.store.list())[0]!;await f.act('answer',e.questions[0]!.answer);e=(await f.store.list())[0]!;const q=e.questions.at(-1)!;await f.dialogue.apply(await f.turn(q.answer),{type:'correct',evidenceId:e.evidence[0]!.id},new AbortController().signal);e=(await f.store.list())[0]!;expect(e.status).toBe('completed');expect(e.evidence.at(-1)?.corrects).toBeUndefined();expect(e.evidence.at(-1)?.evaluator).toBe('deterministic');});
