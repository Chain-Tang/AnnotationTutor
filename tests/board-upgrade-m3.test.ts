import {describe,it,expect} from 'vitest';
import {BoardDabStream,generateBrushDabs} from '../src/board-paint.js';
import {defaultBoardBrush} from '../src/board-brushes.js';
import {inkSelectionFingerprint,isCurrentInkSelection} from '../src/ink-transcript.js';
import type {BoardObject,BoardPoint} from '../src/board-types.js';
describe('M3 incremental material strokes',()=>{
 it.each(['watercolor','oil','crayon','chalk','pencil'] as const)('matches final %s samples across uneven pointer batches',kind=>{
  const style=defaultBoardBrush(kind,31),points:BoardPoint[]=Array.from({length:140},(_,i)=>({x:i*1.7,y:Math.sin(i/8)*20,pressure:.2+i%7/10,t:i*12,tiltX:i%60,tiltY:10}));
  const stream=new BoardDabStream(style,24),result=[];
  for(let i=1;i<points.length;i+=9)result.push(...stream.append(points.slice(0,i)));
  result.push(...stream.append(points));expect(result).toEqual(generateBrushDabs(points,style,24));
  expect(stream.append(points)).toEqual([]);
 });
 it('retains raw ink and rejects recognition after movement, erasure, replacement or deletion',()=>{
  const object:BoardObject={id:'a',kind:'ink',inkId:'raw',anchor:{kind:'canvas',pageId:'main'},x:0,y:0,width:20,height:10,color:'#111111',strokeWidth:2,createdBy:'human',editedBy:'human',revision:1,groupId:'g'};
  const ink={raw:{id:'raw',createdAt:new Date().toISOString(),points:[{x:0,y:0},{x:20,y:10}]}};
  const fingerprint=inkSelectionFingerprint([object],ink);
  expect(isCurrentInkSelection(['a'],fingerprint,[structuredClone(object)],ink)).toBe(true);
  for(const altered of [{...object,x:1},{...object,erasedRanges:[[0,1] as [number,number]]},{...object,inkId:'other'}])expect(isCurrentInkSelection(['a'],fingerprint,[altered],ink)).toBe(false);
  expect(isCurrentInkSelection(['a'],fingerprint,[],ink)).toBe(false);
  const changed=structuredClone(ink);changed.raw.points[0]!.x=1;expect(isCurrentInkSelection(['a'],fingerprint,[object],changed)).toBe(false);
  expect(ink.raw.points[0]!.x).toBe(0);
 });
});
