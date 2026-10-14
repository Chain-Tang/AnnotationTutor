// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createSemanticVectorizationProvider, createVTracerVectorizationProvider, SvgVectorizationProvider } from "../src/board-vectorization.js";
import { sha256Hex } from "../src/board-brush-pack.js";
import type { BoardVectorAsset, VectorizationProgress } from "../src/board-types.js";

const asset = (roles: string[]): BoardVectorAsset => ({
  format: "board-vector-v1", id: "semantic-character", version: 1, name: "Character", width: 100, height: 100,
  rootIds: ["root"], createdAt: "2026-09-23T00:00:00.000Z",
  nodes: [{ id: "root", name: "Character", kind: "group", transform: [1,0,0,1,0,0], opacity: 1, blendMode: "normal", visible: true, locked: false },
    ...roles.map((role,index)=>({id:`part-${index}`,parentId:"root",name:role,semanticRole:role,kind:"path" as const,transform:[1,0,0,1,0,0] as [number,number,number,number,number,number],opacity:1,blendMode:"normal" as const,visible:true,locked:false,path:[{op:"M" as const,x:index,y:0},{op:"L" as const,x:index+1,y:1}],fill:{kind:"solid" as const,color:"#111111",opacity:1}}))],
});
const request = { requestId: "vector-1", mode: "semantic" as const, image: { bytes: new Uint8Array([1]), mimeType: "image/png" as const, width: 32, height: 32 } };

describe("dual-mode vectorization", () => {
  it("repairs missing semantic parts and reports bounded stages", async () => {
    let calls=0;const progress:VectorizationProgress[]=[];
    const provider=createSemanticVectorizationProvider({id:"vision",model:"vision-model",maxRepairs:2,available:async()=>({available:true}),complete:async()=>JSON.stringify(asset(calls++? ["background","back-hair","body","clothing","face","facial-features","front-hair","hands","props","effects"]:["face"]))});
    const result=await provider.vectorize(request,undefined,undefined,event=>progress.push(event));
    expect(calls).toBe(2);expect(result.repairCount).toBe(1);expect(result.semanticPartRatio).toBeGreaterThan(.8);
    expect(progress.map(event=>event.stage)).toContain("repair");expect(progress.at(-1)?.stage).toBe("complete");
  });

  it("normalizes trace SVG through the safe importer and exposes stage progress", async () => {
    const progress:VectorizationProgress[]=[];
    const provider=new SvgVectorizationProvider("trace",{trace:true,semantic:false},async()=>({svg:'<svg viewBox="0 0 10 10"><path id="logo" d="M0 0L10 10" stroke="#111" fill="none"/></svg>'}));
    const result=await provider.vectorize({...request,mode:"trace"},undefined,undefined,event=>progress.push(event));
    expect(result.asset.nodes.some(node=>node.id==="logo")).toBe(true);
    expect(progress.at(-1)?.stage).toBe("complete");
  });

  it("loads VTracer only through a checksum-verified optional resource",async()=>{
    const resource=new Uint8Array([0,97,115,109,1]),hash=await sha256Hex(resource);let executions=0;
    const provider=createVTracerVectorizationProvider({manifest:{version:"test",sha256:hash,license:"MIT",source:"https://github.com/visioncortex/vtracer"},readResource:async()=>resource,execute:async input=>{executions++;expect(input.resource).toEqual(resource);return '<svg viewBox="0 0 8 8"><rect id="trace" width="8" height="8" fill="#000"/></svg>';}});
    expect(await provider.availability()).toEqual({available:true});const result=await provider.vectorize({...request,mode:"trace"});expect(result.asset.nodes.some(node=>node.id==="trace")).toBe(true);expect(executions).toBe(1);
    const invalid=createVTracerVectorizationProvider({manifest:{version:"test",sha256:"0".repeat(64),license:"MIT",source:"test"},readResource:async()=>resource,execute:async()=>""});
    await expect(invalid.availability()).resolves.toMatchObject({available:false,reason:expect.stringMatching(/校验失败/)});
  });
});
