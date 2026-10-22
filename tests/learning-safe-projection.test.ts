import {it,expect} from 'vitest';
import {createEpisode,recordAttempt} from '../src/learning-episode.js';
import {learningContext} from '../src/learning-context.js';
import {safeLegacyEvidence} from '../src/learning-safe-projection.js';
import {learningExpertContext} from '../src/learning-experts.js';
import {createEpisodeV3,questionRefV3} from '../src/learning-v3.js';
import {instantiateQuestion} from '../src/learning-question-bank.js';
import type {EpisodeV2} from '../src/learning-v2.js';
it('projects verifiable legacy values while removing raw feedback/reflection/explanation across all consumers',()=>{
 let e=recordAttempt(createEpisode({path:'math.md',version:'1'},'value-limit'),'4');e.reflection='PRIVATE_REFLECTION';e.evidence[0]!.feedback='PRIVATE_FEEDBACK';
 const evidence=structuredClone(e.evidence[0]!);Object.assign(evidence,{id:crypto.randomUUID(),answer:'PRIVATE_DISCLOSURE',kind:'explanation',evaluator:'tutor',outcome:'unreviewed'});e.evidence.push(evidence);
 const results=[JSON.stringify(safeLegacyEvidence(e)),learningContext([e],{source:'math.md'}).summary,learningExpertContext(e,{source:'math.md',revision:'1',text:'authorized excerpt'})];
 for(const result of results){expect(result).toContain('legacy-unverified');for(const raw of ['PRIVATE_REFLECTION','PRIVATE_FEEDBACK','PRIVATE_DISCLOSURE'])expect(result).not.toContain(raw);}
});
it('does not trust old v2 question prompts, answer keys, feedback or arbitrary answer prose',()=>{
 const q=instantiateQuestion('value-limit','practice',0);const now=new Date().toISOString();
 const e:EpisodeV2={format:2,id:crypto.randomUUID(),revision:1,source:{path:'math.md',version:'1'},concept:'value-limit',consent:{at:now,requestId:crypto.randomUUID(),conversationId:crypto.randomUUID()},reviewStep:0,status:'active',questions:[{...q,prompt:'PRIVATE_PROMPT',answer:'PRIVATE_KEY',explanation:'PRIVATE_EXPLANATION'}],currentQuestionId:q.id,evidence:[{id:crypto.randomUUID(),requestId:crypto.randomUUID(),at:now,questionId:q.id,kind:'unassisted',answer:q.answer,help:{hints:0,answerShown:false},evaluator:'deterministic',outcome:'incorrect',feedback:'PRIVATE_FEEDBACK'}],requests:[],links:[],createdAt:now,updatedAt:now};
 const context=learningContext([e],{source:'math.md'}).summary;expect(context).toContain('correct');expect(context).not.toContain('PRIVATE_');
 e.evidence[0]!.answer='答案是9，但是PRIVATE_DISCLOSURE';expect(JSON.stringify(safeLegacyEvidence(e))).toContain('legacy-unverified');expect(JSON.stringify(safeLegacyEvidence(e))).not.toContain('PRIVATE_');
});
it('reads v1 and v3 together while keeping new structured evidence independent of old text',()=>{const old=createEpisode({path:'legacy.md',version:'1'},'jump');old.reflection='PRIVATE';const e=createEpisodeV3({path:'math.md',version:'1'},questionRefV3('continuity','practice'),{at:new Date().toISOString(),requestId:crypto.randomUUID(),conversationId:crypto.randomUUID(),invitationId:crypto.randomUUID()});const snapshot=learningContext([old,e],{episodeId:e.id});expect(snapshot.episodes).toMatchObject([{format:3,id:e.id}]);expect(snapshot.summary).not.toContain('PRIVATE');});
