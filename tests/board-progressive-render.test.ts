import { describe, expect, it } from "vitest";
import { planProgressiveScene } from "../src/board-progressive-render.js";
import type { BoardDocument, BoardLayer, BoardObject } from "../src/board-types.js";

const layer = (id: string, order: number): BoardLayer => ({id, name:id, order, visible:true, locked:false, opacity:1, blendMode:"normal", kind:"vector"});
const object = (id: string, layerId: string): BoardObject => ({
  id, layerId, kind:"ink", anchor:{kind:"canvas", pageId:"main"}, x:0, y:0, width:10, height:10,
  color:"#000", strokeWidth:2, createdBy:"human", editedBy:"human", revision:1, groupId:"group",
});
const board = (layers: BoardLayer[], objects: BoardObject[]): BoardDocument => ({
  id:"test", schemaVersion:5, sourceType:"standalone", sourceFile:"test", createdAt:"", updatedAt:"",
  revision:1, objects, layers,
} as BoardDocument);

describe("progressive scene eligibility", () => {
  it("keeps objects within their ordered, isolated layers", () => {
    const back=layer("back",0), front=layer("front",1);
    const objects=[object("front-1","front"),object("back-1","back"),object("back-2","back")];
    expect(planProgressiveScene(board([front,back],objects),objects,1)?.map(item=>[item.layer.id,item.objects.map(o=>o.id)]))
      .toEqual([["back",["back-1","back-2"]],["front",["front-1"]]]);
  });
  it("leaves small scenes, groups, clipping and paint operations on the exact compositor", () => {
    const ink=object("one","main"), main=layer("main",0);
    expect(planProgressiveScene(board([main],[ink]),[ink])).toBeNull();
    expect(planProgressiveScene(board([{...main,opacity:0.5}],[ink]),[ink],1)).toBeNull();
    expect(planProgressiveScene(board([{...main,clippedToBelow:true}],[ink]),[ink],1)).toBeNull();
    expect(planProgressiveScene(board([{...main,kind:"group"}],[ink]),[ink],1)).toBeNull();
    expect(planProgressiveScene({...board([main],[ink]),paintOperations:[{}]} as BoardDocument,[ink],1)).toBeNull();
  });
  it("rejects objects that need asynchronous assets or a separate paint path", () => {
    const main=layer("main",0), ink=object("one","main");
    expect(planProgressiveScene(board([main],[{...ink,kind:"vector"}]),[{...ink,kind:"vector"}],1)).toBeNull();
    expect(planProgressiveScene(board([main],[{...ink,fill:{kind:"brush",color:"#000",opacity:1,seed:1}}]),[{...ink,fill:{kind:"brush",color:"#000",opacity:1,seed:1}}],1)).toBeNull();
  });
});
