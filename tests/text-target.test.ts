import {describe,it,expect} from 'vitest';
import {captureTextTarget,resolveTextTarget,uniqueTextTarget} from '../src/text-target.js';
describe('stable translation target',()=>{
 it('refuses ambiguous reading selections',()=>expect(uniqueTextTarget('word then word','word')).toBeNull());
 it('retains the second occurrence through an insertion before it',()=>{
   const before='word then word',target=captureTextTarget(before,10,14);
   expect(resolveTextTarget(target,'new '+before)).toEqual({start:14,end:18});
 });
 it('never substitutes another occurrence when selected text was edited',()=>{
   expect(resolveTextTarget(captureTextTarget('word then word',10,14),'word then changed')).toBeNull();
 });
 it('accepts unrelated trailing edits',()=>expect(resolveTextTarget(captureTextTarget('word then word',0,4),'word then changed')).toEqual({start:0,end:4}));
 it.each([[0,4],[5,9]])('rejects deletion of an indistinguishable repeated occurrence at %s', (start,end)=>{
   expect(resolveTextTarget(captureTextTarget('word word',start,end),'word')).toBeNull();
 });
 it('rejects insertion of an indistinguishable adjacent occurrence',()=>{
   expect(resolveTextTarget(captureTextTarget('word',0,4),'word word')).toBeNull();
 });
 it('only maps empty insertion anchors when explicitly allowed and outside a concurrent edit',()=>{
   const target=captureTextTarget('before after',7,7);
   expect(resolveTextTarget(target,target.content)).toBeNull();
   expect(resolveTextTarget(target,'new before after',true)).toEqual({start:11,end:11});
   expect(resolveTextTarget(target,'before NEWafter',true)).toBeNull();
 });
 it('rejects invalid snapshot bounds and empty text searches',()=>{
   expect(resolveTextTarget(captureTextTarget('word',-1,4),'word')).toBeNull();
   expect(uniqueTextTarget('word','')).toBeNull();
 });
});
