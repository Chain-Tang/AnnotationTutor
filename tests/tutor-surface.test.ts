import { describe, expect, it } from "vitest";
import { surfaceCommitResult, surfaceDeltaMatches } from "../src/tutor-surface.js";
describe("R04 precise surface receipts",()=>{
  it("checks the fixed applied difference without claiming unrelated later objects",()=>{
    const grant={clientId:"a",targets:["board"],read:true,write:true,humanObjectIds:[],learningMemory:false};
    const changes={id:"once",taskId:"task",targetId:"board",baseRevision:"0",operations:[{type:"add",id:"object"}],dependencies:[]};
    const before=[{id:"modified",x:0},{id:"deleted",x:0}];
    const applied=[{id:"modified",x:1},{id:"created",x:2}];
    const result=surfaceCommitResult(changes,grant,{id:"board",source:"a.md",revision:"1",surface:"studio"},before,applied);
    expect(result.receipt).toMatchObject({createdIds:["created"],updatedIds:["modified"],deletedIds:["deleted"]});
    expect(surfaceDeltaMatches(result.receipt,[...applied,{id:"later-human"}])).toBe(true);
    expect(surfaceDeltaMatches(result.receipt,[{id:"modified",x:9},applied[1]!])).toBe(false);
    expect(surfaceDeltaMatches(result.receipt,[...applied,{id:"deleted",x:0}])).toBe(false);
    expect(surfaceDeltaMatches(result.receipt,[applied[0]!])).toBe(false);
    expect(result.receipt.createdIds).not.toContain("later-human");expect(result.objects).toEqual([]);
  });
});
