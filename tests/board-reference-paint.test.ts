import {describe,it,expect,vi} from 'vitest';
import {reconstructReference,playReferenceStrokes} from '../src/board-reference-paint.js';
import {boardObjectSchema} from '../src/board-model.js';
import {requestsReferencePainting,requestsBoardTextDrawing,requestsDrawing} from '../src/board-drawing-intent.js';
import {tutorRouteForText} from '../src/tutor-conversation.js';
import {referencePaintPresets} from '../src/board-reference-style.js';
const anchor={kind:'markdown' as const,key:'a',quote:'lesson'};
const target={x:40,y:30,width:200,height:200};
const pixels={width:2,height:2,data:new Uint8ClampedArray([0,0,255,255,255,0,0,255,0,0,255,255,255,0,0,255])};
describe('reference brush reconstruction',()=>{
 it('preserves transparent holes as opposite-winding native regions, not white cover-up objects',()=>{
  const data=new Uint8ClampedArray(32*32*4);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)if(x<8||x>=24||y<8||y>=24){const p=(y*32+x)*4;data[p]=255;data[p+3]=255;}
  const result=reconstructReference({width:32,height:32,data},{x:0,y:0,width:320,height:320},anchor,'ring');
  const fills=result.objects.filter(o=>o.fill);
  expect(fills).toHaveLength(1);
  const winding=(x:number,y:number)=>{
   const points=fills[0]!.points!;let count=0;
   for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;
    const side=(b.x-a.x)*(y-a.y)-(x-a.x)*(b.y-a.y);
    if(a.y<=y&&b.y>y&&side>0)count++;if(a.y>y&&b.y<=y&&side<0)count--;
   }return count;
  };
  expect(winding(40,160)).not.toBe(0);expect(winding(160,160)).toBe(0);
 });
 it('stores separate editable contours and deterministic material fills for each preset',()=>{
  const data=new Uint8ClampedArray(32*32*4);for(let i=0;i<1024;i++){data[i*4]=210;data[i*4+1]=40;data[i*4+3]=255;}
  for(const style of Object.values(referencePaintPresets)){
   const result=reconstructReference({width:32,height:32,data},target,anchor,'style',6000,style);
   expect(result.regionCount).toBe(1);expect(result.objects).toHaveLength(2);
   const [fill,outline]=result.objects;
   expect(fill!.fill?.kind).toBe(style.colorMode==='solid'?'solid':'brush');
   if(style.colorMode==='brush')expect(fill!.fill!.brush?.kind).toBe(style.colorBrush);
   expect(outline!.brush?.kind).toBe(style.outlineBrush);
   for(const object of result.objects)expect(boardObjectSchema.parse(JSON.parse(JSON.stringify(object)))).toEqual(object);
   expect(reconstructReference({width:32,height:32,data},target,anchor,'style',6000,style)).toEqual(result);
  }
 });
 it('retains a small saturated blue subject among dominant warm and neutral colours',()=>{
  const data=new Uint8ClampedArray(96*96*4);
  for(let y=0;y<96;y++)for(let x=0;x<96;x++){
   const p=(y*96+x)*4,blue=x>=40&&x<56&&y>=40&&y<56;
   data[p]=blue?0:(x<32?255:40);data[p+1]=blue?30:(x<64?180:80);data[p+2]=blue?240:10;data[p+3]=255;
  }
  const result=reconstructReference({width:96,height:96,data},target,anchor,'blue');
  expect(result.samplingWidth).toBe(96);
  expect(result.objects.some(o=>o.fill?.color==='#001ef0')).toBe(true);
 });
 it('creates deterministic native editable paths, without embedding a bitmap',()=>{
  const a=reconstructReference(pixels,target,anchor,'REPAINT-test');
  expect(a.regionCount).toBe(2);expect(a.objects).toHaveLength(2);expect(reconstructReference(pixels,target,anchor,'REPAINT-test')).toEqual(a);
  expect(a.objects.map(o=>o.fill?.color)).toContain('#0000ff');expect(a.objects.map(o=>o.fill?.color)).toContain('#ff0000');
  for(const o of a.objects){expect(boardObjectSchema.safeParse(o).success).toBe(true);expect(o.fill?.kind).toBe('solid');expect(o.kind).toBe('path');expect(o.assetId).toBeUndefined();expect(o.selectionGroupId).toBe('REPAINT-test');}
 });
 it('skips transparent samples and reduces sampling rather than truncating the bottom of a complex image',()=>{
  const transparent={...pixels,data:new Uint8ClampedArray(16)};
  expect(reconstructReference(transparent,target,anchor,'REPAINT-test').objects).toHaveLength(0);
  const data=new Uint8ClampedArray(64*64*4);for(let i=0;i<4096;i++){data[i*4]=(i*37)%256;data[i*4+1]=(i*17)%256;data[i*4+3]=255;}
  const result=reconstructReference({width:64,height:64,data},target,anchor,'REPAINT-test',100);
  expect(result.objects.length).toBeLessThanOrEqual(100);expect(Math.max(...result.objects.map(o=>o.y+o.height))).toBeGreaterThan(180);
 });
 it('does not publish another preview when cancelled or changed during playback',async()=>{
  const {objects}=reconstructReference(pixels,target,anchor,'REPAINT-test');
  const abort=new AbortController(),preview=vi.fn();
  await expect(playReferenceStrokes(objects,{signal:abort.signal,valid:()=>true,instant:()=>false,preview,wait:async()=>{abort.abort();}})).rejects.toThrow('cancelled');
  expect(preview).toHaveBeenCalledTimes(1);
  await expect(playReferenceStrokes(objects,{valid:()=>false,instant:()=>true,preview,wait:async()=>{}})).rejects.toThrow('cancelled');
  expect(preview).toHaveBeenCalledTimes(1);
 });
 it('instant completion exposes the exact final objects without changing IDs or data',async()=>{
  const {objects}=reconstructReference(pixels,target,anchor,'REPAINT-test');const before=structuredClone(objects),preview=vi.fn();
  await playReferenceStrokes(objects,{valid:()=>true,instant:()=>true,preview,wait:async()=>{}});
  expect(preview).toHaveBeenCalledExactlyOnceWith(objects);expect(objects).toEqual(before);
 });
 it('rejects invalid buffers and unbounded allocations',()=>{
  expect(()=>reconstructReference({...pixels,data:new Uint8ClampedArray(1)},target,anchor,'x')).toThrow();
  expect(()=>reconstructReference(pixels,{...target,width:Infinity},anchor,'x')).toThrow();
 });
});
describe('explicit drawing intent',()=>{
 const context={mode:'ask' as const,pinned:false,hasBoard:true};
 it.each(['在页面上输出一个鲸鱼娘的形象','根据这篇文章画一个鲸鱼娘角色','请在正文旁画一个吉卜力风格角色','Draw an anime character based on this paragraph'])('routes reference art using document context: %s',text=>{
  expect(tutorRouteForText(text,context)).toBe('board');expect(requestsReferencePainting(text)).toBe(true);
 });
 it.each(['画一个表格','在正文插入一张图','insert a diagram into this note'])('keeps actual note edits: %s',text=>expect(tutorRouteForText(text,context)).toBe('chat'));
 it.each(['不要生成角色','do not generate a character','不要画角色','画个简笔笑脸','画个力学示意图'])('does not invoke image generation for %s',text=>expect(requestsReferencePainting(text)).toBe(false));
});

describe('learner text instructions',()=>{
 it.each(['请你绘制一个二次元的米老鼠','请帮我画一个圆','draw a circle'])('accepts direct request %s',text=>expect(requestsBoardTextDrawing(text)).toBe(true));
 it.each(['请解释这幅画','这是一幅画','不要画角色','请你不要画角色','please explain this drawing'])('keeps other text as context %s',text=>expect(requestsBoardTextDrawing(text)).toBe(false));
});

it('retains an explicit native drawing clause while excluding image generation',()=>{
 const text='不要生成图片，直接用画笔画一个角色';
 expect(requestsDrawing(text)).toBe(true);expect(requestsReferencePainting(text)).toBe(false);
});
