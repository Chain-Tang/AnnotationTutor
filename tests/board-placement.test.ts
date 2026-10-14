import {describe,it,expect} from 'vitest';
import {findDrawingRect,placeDrawingGroup,objectClientBounds,rectUnion,safeDrawingRect,mapRect,overlaps} from '../src/board-placement.js';
import type {BoardObject,BoardMatrix} from '../src/board-types.js';
const matrix:BoardMatrix=[1,0,0,1,0,0];
const object=(props:Partial<BoardObject>={}):BoardObject=>({id:'a',kind:'rect',anchor:{kind:'markdown',key:'p',quote:'text'},x:20,y:50,width:300,height:180,strokeWidth:2,color:'#000000',createdBy:'tutor',editedBy:'tutor',revision:1,groupId:'g',...props});
const space=()=>({viewport:{x:0,y:0,width:1000,height:800},protected:[{x:0,y:0,width:1000,height:220}]});
describe('host layout allocation',()=>{
  it('reserves a bounded landscape area below text even in a very tall window',()=>{
    const s=space();s.viewport.height=3000;const r=findDrawingRect(s)!;
    expect(r).not.toBeNull();expect(r.width).toBe(520);expect(r.height).toBe(380);expect(r.y).toBeGreaterThanOrEqual(220);expect(safeDrawingRect(s,r)).toBe(true);
  });
  it('rejects fragmented narrow gaps instead of squeezing a diagram between lines',()=>{
    const s=space();s.protected=Array.from({length:16},(_,i)=>({x:0,y:i*50,width:1000,height:20}));expect(findDrawingRect(s)).toBeNull();
  });
  it('preserves a whole response and moves it clear of source text and existing art',()=>{
    const s=space();s.protected.push({x:0,y:220,width:350,height:580});
    const original=[object(),object({id:'b',kind:'text',x:80,y:80,width:180,height:40,text:'f(x)',textStyle:{font:'sans',size:20,align:'left'}})];
    const result=placeDrawingGroup(original,matrix,s)!;
    expect(result).not.toBeNull();expect(safeDrawingRect(s,rectUnion(result.map(o=>objectClientBounds(o,matrix))))).toBe(true);
    expect(result[1]!.x-result[0]!.x).toBe(60);expect(result[1]!.y-result[0]!.y).toBe(30);expect(original[0]!.x).toBe(20);
  });
  it('leaves a safe composition unchanged',()=>{const a=object({x:400,y:300});expect(placeDrawingGroup([a],matrix,space())).toEqual([a]);});
  it('does not shrink unreadably or flatten a very tall mathematical plot',()=>{
    expect(placeDrawingGroup([object({height:1200})],matrix,space())).toBeNull();
    expect(placeDrawingGroup([object({kind:'text',text:'label',textStyle:{font:'sans',size:10,align:'left'}})],matrix,space())).toBeNull();
  });
  it.each(([matrix,[0,2,-2,0,800,0],[ -1,0,0,-1,1000,800],[0,-1,1,0,0,800]] as BoardMatrix[]).map(m=>({m})))('uses final zoom/rotation matrices consistently (%j)',({m})=>{
    const o=object({width:120,height:80,rotation:Math.PI/4});const s=space();const result=placeDrawingGroup([o],m,s)!;
    expect(result).not.toBeNull();expect(safeDrawingRect(s,objectClientBounds(result[0]!,m))).toBe(true);
    expect(result[0]!.width/result[0]!.height).toBeCloseTo(1.5);expect(result[0]!.rotation).toBe(o.rotation);
  });
  it('conservatively avoids thin obstacles and returns a real fit for deterministic varied scenes',()=>{
    for(let i=0;i<60;i++){
      const s=space();s.protected.push({x:(i*67)%750,y:221,width:1+i%70,height:200+i%230});
      const r=findDrawingRect(s);if(r)expect(safeDrawingRect(s,r)).toBe(true);
    }
  });
  it('maps all corners, including reflected coordinates',()=>{expect(mapRect({x:10,y:20,width:30,height:40},[0,2,-2,0,200,100])).toEqual({x:80,y:120,width:80,height:60});});
  it('does not count edge contact as an overlap',()=>{expect(overlaps({x:0,y:0,width:10,height:10},{x:10,y:0,width:5,height:10})).toBe(false);});
});
