import {it,expect} from 'vitest';
import {teachingInstructions} from '../src/teaching-policy.js';
import {buildApiMessages,contextBlock} from '../src/chat-prompt.js';
import {adultSupportInstructions} from '../src/adult-support-policy.js';
import {supportInstructions} from '../src/support-session.js';
it('ordinary and optional non-saving conversations receive identical adult safety and memory priorities',()=>{
 const policy=adultSupportInstructions();
 const ordinary=buildApiMessages([],{teaching:{mode:'answer',audience:'adult',version:1}},'今天只想聊聊','Chinese')[0]!.content;
 expect(ordinary).toContain(policy);expect(supportInstructions()).toContain(policy);
 // These are policy propagation checks, not a model/clinical evaluation.
 expect(ordinary).not.toContain('No tools, profiles, external experts or learning assessment');
 expect(supportInstructions()).toContain('No tools, profiles, external experts or learning assessment');
});
it('carries an explicit user teaching preference without changing execution mode',()=>{
 const messages=buildApiMessages([],{teaching:{mode:'hint',audience:'adult',version:1}},'help','Chinese');
 expect(messages[0]!.content).toContain('Teaching preference: hint');
 expect(teachingInstructions()).toContain('A recall streak is not proof of mastery');
});
it('prioritizes the selected passage in long documents and states actual observation',()=>{
 const result=contextBlock({content:'x'.repeat(8000)+'MY_SELECTION'+'y'.repeat(8000),selection:'MY_SELECTION',observation:{source:'note',version:'v',scope:'selection',hasImage:false}},true);
 expect(result).toContain('MY_SELECTION');expect(result).toContain('"hasImage":false');
});
it('states missing history without denying provided evidence or conversation',()=>{
 const prompt=(history:Parameters<typeof buildApiMessages>[0],ctx:Parameters<typeof buildApiMessages>[1])=>buildApiMessages(history,ctx,'你记错了','Chinese')[0]!.content;
 expect(prompt([],{})).toContain('no prior conversation turns and no related learning evidence');
 expect(prompt([{role:'user',content:'我看过提示'}],{})).not.toContain('This request contains no prior');
 expect(prompt([],{learningSummary:'evidence: hinted attempt'})).not.toContain('This request contains no prior');
});
it('does not contain the personal hint example that was taken as a learner fact',()=>{
 const instructions=teachingInstructions();
 expect(instructions).not.toContain('这轮按有提示练习来理解');expect(instructions).toContain('first-person report');
 expect(instructions).toContain('Once continuity at a is established, substitution is valid');
 expect(instructions).toContain('Do not insert this subject or analogy into unrelated conversations');
});
