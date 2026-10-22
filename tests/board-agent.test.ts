import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoardRequestScheduler,
  BoardRequestCoordination,
  buildBoardApiBody,
  buildBoardPrompt,
  createBoardAgent,
  parseBoardAgentResponse,
  BoardResponseStream,
  buildBoardStreamPrompt,
  requestBoardWithRepair,
} from "../src/board-agent.js";
import { builtInBoardAssets } from "../src/board-characters.js";
import { buildChatMessagesBody } from "../src/api-runner.js";
import type { AcpSessionHandle, startAcpSession } from "../src/acp-session.js";
import type { BoardAgent, BoardAgentEvent, BoardAgentRequest, BoardObject } from "../src/board-types.js";
import type { HttpStream } from "../src/api-stream.js";

const request = (): BoardAgentRequest => ({
  boardId: "board-1",
  sessionId: "session-1",
  requestId: "request-1",
  baseRevision: 2,
  sourceRevision: "source-1",
  sourceFile: "lesson.md",
  anchor: { kind: "markdown", key: "a", quote: "hello" },
  snapshot: {
    pngBase64: "aGVsbG8=",
    width: 500,
    height: 400,
    imageToBoard: [1, 0, 0, 1, 0, 0],
    anchor: { kind: "markdown", key: "a", quote: "hello" },
    layoutRevision: "layout-1",
  },
  objects: [],
  instruction: "",
  context: "Example lesson",
  character: {
    id: "tutor-round",
    version: 1,
    name: "Round",
    origin: "builtin",
    style: "round",
    width: 100,
    height: 100,
    createdAt: "now",
  },
});
const drawing = () => ({
  kind: "ellipse",
  x: 10,
  y: 20,
  width: 80,
  height: 60,
  color: "#6655aa",
  strokeWidth: 2,
});
const response = (
  operations: unknown[] = [{ type: "add", object: drawing() }],
): string =>
  JSON.stringify({
    requestId: "request-1",
    baseRevision: 2,
    description: "A smile",
    operations,
  });
const previous = (createdBy: "human" | "tutor" = "tutor"): BoardObject => ({
  ...drawing(),
  kind: "ellipse",
  id: "obj-1",
  anchor: request().anchor,
  createdBy,
  editedBy: createdBy,
  revision: 3,
  groupId: "old",
});
const apiReply = (content = response()) => ({
  status: 200,
  text: JSON.stringify({ choices: [{ message: { content } }] }),
});

describe("board drawing response validation", () => {
  it.each([1,1.25,2,3])("keeps host-default text legible at image pixel ratio %s without changing its box or position", ratio => {
    const input=request();input.drawingPixelRatio=ratio;
    input.snapshot.imageToBoard=[1/ratio,0,0,1/ratio,0,0];
    const text={...drawing(),kind:'text',height:12,text:'中文批注'};
    const result=parseBoardAgentResponse(response([{type:'add',object:text}]),input);
    expect(result).toMatchObject({ok:true,operations:[{object:{textStyle:{font:'handwritten',size:12}}}]});
    if(!result.ok||result.operations[0]?.type!=='add')throw Error('expected text');
    const object=result.operations[0].object;
    expect(object.x).toBeCloseTo(10/ratio);expect(object.y).toBeCloseTo(20/ratio);
    expect(object.width).toBeCloseTo(80/ratio);expect(object.height).toBeCloseTo(12/ratio);
    for(const prompt of [buildBoardPrompt(input),buildBoardStreamPrompt(input)]){
      expect(prompt).toContain(`textStyle.size >= ${12*ratio}`);
      expect(prompt).toContain('FONT SIZE in IMAGE pixels');
    }
  });
  it("rejects explicit Retina text below the CSS minimum in both protocols, while preserving historical small labels",()=>{
    const input=request();input.drawingPixelRatio=2;input.snapshot.imageToBoard=[.5,0,0,.5,0,0];
    const text={...drawing(),kind:'text',text:'中文批注',textStyle:{font:'handwritten',size:16,align:'left'}};
    const operation={type:'add',object:text};
    expect(parseBoardAgentResponse(response([operation]),input)).toMatchObject({ok:false,code:'invalid-response',error:'drawing-text-too-small'});
    const previews:BoardAgentEvent[]=[];const stream=new BoardResponseStream(input,e=>previews.push(e));
    expect(()=>stream.push(event(0,{type:'operation',operation},input)+event(1,{type:'turn.end'},input))).toThrow('drawing-text-too-small');
    expect(stream.finish()).toMatchObject({ok:false,code:'invalid-response',error:'drawing-text-too-small'});
    expect(previews.filter(e=>e.type==='preview')).toHaveLength(0);
    const old:BoardObject={...previous(),kind:'text',text:'历史文字',textStyle:{font:'handwritten',size:8,align:'left'}};
    input.objects=[old];input.objectToImage={[old.id]:[2,0,0,2,0,0]};
    expect(parseBoardAgentResponse(response([{type:'update',objectId:old.id,expectedRevision:old.revision,object:text}]),input)).toMatchObject({ok:true,operations:[{object:{textStyle:{size:8}}}]});
    expect(old.textStyle?.size).toBe(8);
  });
  it("uses each attached object's screenshot transform for summaries and updates without rewriting historical geometry", () => {
    const input=request(), old={...previous(),x:30,y:40};input.objects=[old];
    input.snapshot.imageToBoard=[.5,0,0,.5,0,0];
    input.objectToImage={'obj-1':[2,0,0,2,-40,-60]};
    const prompt=buildBoardPrompt(input);
    const detail=JSON.parse(prompt.split('\n').find(line=>line.startsWith('Current objects: '))!.slice('Current objects: '.length))[0];
    expect(detail).toMatchObject({x:30,y:40,objectToImage:[2,0,0,2,-40,-60],imageBounds:{x:20,y:20,width:160,height:120}});
    const operation={type:'update',objectId:old.id,expectedRevision:old.revision,object:{...drawing(),x:20,y:20,width:160,height:120,strokeWidth:4,fill:{kind:'solid',color:'#ffaa00',opacity:1}}};
    for(const result of [parseBoardAgentResponse(response([operation]),input),(()=>{
      const stream=new BoardResponseStream(input);stream.push(event(0,{type:'operation',operation},input)+event(1,{type:'turn.end'},input));return stream.finish();
    })()])expect(result).toMatchObject({ok:true,operations:[{type:'update',object:{id:old.id,x:30,y:40,width:80,height:60,strokeWidth:2,groupId:'old',fill:{color:'#ffaa00'}}}]});
    // New objects use the region's mapping, rather than inheriting an old object's offset.
    expect(parseBoardAgentResponse(response(),input)).toMatchObject({ok:true,operations:[{object:{x:5,y:10,width:40,height:30}}]});
    expect(old).toEqual({...previous(),x:30,y:40});
  });
  it("rejects unknown, reflected, singular or sheared object mappings before any preview or commit", () => {
    const mappings: NonNullable<BoardAgentRequest['objectToImage']>[] = [
      {'unknown':[1,0,0,1,0,0]}, {'obj-1':[0,0,0,1,0,0]},
      {'obj-1':[-1,0,0,1,0,0]}, {'obj-1':[1,0,1,1,0,0]}, {'obj-1':[1,0,0,1,Infinity,0]},
    ];
    for(const objectToImage of mappings){
      const input={...request(),objects:[previous()],objectToImage};
      expect(parseBoardAgentResponse(response(),input)).toMatchObject({ok:false,error:'invalid-snapshot-object-transform'});
      expect(()=>new BoardResponseStream(input)).toThrow('invalid-snapshot-object-transform');
    }
  });
  it("rebases signed path offsets without changing screen points or arrow direction",()=>{
    const input=request();
    const object={...drawing(),kind:'arrow',x:120,y:300,width:0,height:240,points:[{x:0,y:0},{x:0,y:-240}]};
    const operation={type:'add',object};
    const result=parseBoardAgentResponse(response([operation]),input);
    expect(result).toMatchObject({ok:true,operations:[{object:{x:120,y:60,height:240,points:[{x:0,y:240},{x:0,y:0}]}}]});
    const stream=new BoardResponseStream(input);
    stream.push(event(0,{type:'operation',operation},input)+event(1,{type:'turn.end'},input));
    expect(stream.finish()).toMatchObject({ok:true,operations:[{object:{x:120,y:60,height:240,points:[{x:0,y:240},{x:0,y:0}]}}]});
    expect(object.points[1]!.y).toBe(-240);
    for(const bad of [{...object,y:100},{...object,height:200},{...object,points:[{x:0,y:-200},{x:0,y:200}]}])
      expect(parseBoardAgentResponse(response([{type:'add',object:bad}]),input).ok).toBe(false);
  });
  it("accepts material fills with host-owned brush seeds and rejects incomplete recipes",()=>{
    const fill={kind:'brush',color:'#aa3300',opacity:1,brush:{kind:'crayon',opacity:.9}};
    const result=parseBoardAgentResponse(response([{type:'add',object:{...drawing(),fill}}]),request());
    expect(result).toMatchObject({ok:true,operations:[{object:{fill:{kind:'brush',brush:{kind:'crayon',opacity:.9,seed:expect.any(Number)}}}}]});
    for(const bad of [{...fill,brush:undefined},{...fill,kind:'solid'},{...fill,brush:{kind:'remote'}},{...fill,brush:{kind:'oil',seed:2}}])
      expect(parseBoardAgentResponse(response([{type:'add',object:{...drawing(),fill:bad}}]),request()).ok).toBe(false);
  });
  it("applies and preserves editable color fills through both protocols and rejects unsafe or unsupported fills", () => {
    const fill={kind:"solid" as const,color:"#ffcc00",opacity:0.8};
    const input=request();input.objects=[previous()];
    const operation={type:"update",objectId:"obj-1",expectedRevision:3,object:{...drawing(),fill}};
    const result=parseBoardAgentResponse(response([operation]),input);
    expect(result).toMatchObject({ok:true,operations:[{type:"update",object:{id:"obj-1",fill:{...fill,seed:expect.any(Number)}}}]});
    if(!result.ok || result.operations[0]?.type!=="update")throw new Error("expected fill update");
    const object=result.operations[0].object;
    input.objects=[object];
    expect(buildBoardPrompt(input)).toContain('"fill":{"kind":"solid","color":"#ffcc00","opacity":0.8}');
    const update={...operation,expectedRevision:object.revision,object:drawing()};
    expect(parseBoardAgentResponse(response([update]),input)).toMatchObject({ok:true,operations:[{object:{fill:object.fill}}]});
    const stream=new BoardResponseStream(input);
    stream.push(event(0,{type:"operation",operation:{...update,object:{...drawing(),fill:{...fill,kind:"none"}}}},input)+event(1,{type:"turn.end"},input));
    expect(stream.finish()).toMatchObject({ok:true,operations:[{object:{fill:{kind:"none",seed:object.fill!.seed}}}]});
    for(const bad of [{...fill,color:"url(https://example.com)"},{...fill,opacity:2},{...fill,kind:"remote"}])
      expect(parseBoardAgentResponse(response([{type:"add",object:{...drawing(),fill:bad}}]),request()).ok).toBe(false);
    expect(parseBoardAgentResponse(response([{type:"add",object:{...drawing(),kind:"text",text:"hello",fill}}]),request()).ok).toBe(false);
  });
  it("ignores copied numeric sketch seeds and never advertises host seeds to the model", () => {
    const operation = { type: "add", object: { ...drawing(), drawingStyle: { kind: "sketch", seed: 42 } } };
    const input = request();
    input.objects = [{ ...previous(), drawingStyle: { kind: "sketch", seed: 42 } }];
    expect(buildBoardPrompt(input)).not.toContain('"seed":42');
    const result = parseBoardAgentResponse(response([operation]), input);
    expect(result.ok).toBe(true);
    if (!result.ok || result.operations[0]?.type !== "add") throw new Error("expected addition");
    expect(result.operations[0].object.drawingStyle).toMatchObject({ kind: "sketch", seed: expect.any(Number) });
    expect(result.operations[0].object.drawingStyle?.seed).not.toBe(42);
    const stream = new BoardResponseStream(input);
    stream.push(event(0, { type: "operation", operation }, input) + event(1, { type: "turn.end" }, input));
    expect(stream.finish().ok).toBe(true);
    for (const seed of [-1, "42", { url: "https://example.com" }])
      expect(parseBoardAgentResponse(response([{ ...operation, object: { ...operation.object, drawingStyle: { kind: "sketch", seed } } }]), input).ok).toBe(false);
  });
  it("canonicalizes nonnegative hairline widths in both response protocols without accepting negative widths",()=>{
    for(const width of [0,0.2,0.49]){
      const input=request();input.snapshot.imageToBoard=[0.1,0,0,0.1,0,0];
      const operation={type:"add",object:{...drawing(),strokeWidth:width}};
      const result=parseBoardAgentResponse(response([operation]),input);
      expect(result).toMatchObject({ok:true,operations:[{object:{strokeWidth:0.1}}]});
      const stream=new BoardResponseStream(input);
      stream.push([{seq:0,type:"turn.begin",requestId:input.requestId,baseRevision:input.baseRevision},{seq:1,type:"operation",operation},{seq:2,type:"turn.end"}].map(e=>JSON.stringify(e)).join("\n"));
      expect(stream.finish()).toMatchObject({ok:true,operations:[{object:{strokeWidth:0.1}}]});
    }
    for(const width of [-1,201,null,"0"])
      expect(parseBoardAgentResponse(response([{type:"add",object:{...drawing(),strokeWidth:width}}]),request()).ok).toBe(false);
  });
  it("bounds dense painting context while retaining recent, human and text objects and full ownership validation", () => {
    const input = request();
    input.objects = Array.from({length: 6000}, (_, index) => ({
      ...previous(), id: `stroke-${index}`, kind: "path" as const,
      points: [{x:0,y:0}, {x:80,y:60}],
    }));
    input.objects[0] = {...previous("human"), id:"learner-question", kind:"text", text:"Please draw eyes"};
    input.objects[1] = {...previous("human"), id:"learner-stroke"};
    const before = JSON.stringify(input.objects);
    for (const prompt of [buildBoardPrompt(input), buildBoardStreamPrompt(input)]) {
      const details = JSON.parse(prompt.split("\n").find(line=>line.startsWith("Current objects: "))!.slice("Current objects: ".length));
      expect(details).toHaveLength(96);
      expect(details.map((object: {objectId:string})=>object.objectId)).toEqual(expect.arrayContaining(["learner-question", "learner-stroke", "stroke-5999"]));
      expect(prompt).toContain('"omitted":5904');
      expect(prompt.length).toBeLessThan(90_000);
    }
    expect(JSON.stringify(input.objects)).toBe(before);
    expect(parseBoardAgentResponse(response([{type:"remove",objectId:"learner-stroke",expectedRevision:3}]),input)).toMatchObject({ok:false});
    expect(parseBoardAgentResponse(response([{type:"remove",objectId:"stroke-2",expectedRevision:3}]),input)).toMatchObject({ok:true});
  });
  it("rejects promise-only replies to explicit drawing requests in both protocols", () => {
    const input = {...request(), instruction: "Draw a smile"};
    expect(parseBoardAgentResponse(response([]), input)).toMatchObject({ok:false, error:"drawing-request-produced-no-objects"});
    const stream = new BoardResponseStream(input);
    stream.push(JSON.stringify({seq:0,type:"turn.begin",requestId:input.requestId,baseRevision:input.baseRevision})+"\n"+
      JSON.stringify({seq:1,type:"reply.delta",text:"I will draw now"})+"\n"+JSON.stringify({seq:2,type:"turn.end"}));
    expect(stream.finish()).toMatchObject({ok:false,error:"drawing-request-produced-no-objects"});
  });
  it("assigns handwritten text, stable host sketch seeds and a separate visual group to a new response", () => {
    const result = parseBoardAgentResponse(response([
      { type: "add", object: drawing() },
      { type: "add", object: { ...drawing(), kind: "text", text: "Why does this change?" } },
    ]), request());
    if (!result.ok || result.operations[0]?.type !== "add" || result.operations[1]?.type !== "add") throw new Error("expected additions");
    const shape = result.operations[0].object;
    const text = result.operations[1].object;
    expect(shape.drawingStyle).toMatchObject({ kind: "sketch" });
    expect(Number.isInteger(shape.drawingStyle?.seed)).toBe(true);
    expect(text.textStyle).toMatchObject({ font: "handwritten", align: "left" });
    expect(shape.selectionGroupId).toMatch(/^selection-/);
    expect(shape.selectionGroupId).toBe(text.selectionGroupId);
    expect(shape.selectionGroupId).not.toBe(shape.groupId);
    const next = request();
    next.objects = [shape];
    const updated = parseBoardAgentResponse(response([{ type: "update", objectId: shape.id, expectedRevision: shape.revision, object: { ...drawing(), x: 20 } }]), next);
    if (!updated.ok || updated.operations[0]?.type !== "update") throw new Error("expected update");
    expect(updated.operations[0].object).toMatchObject({ id: shape.id, drawingStyle: shape.drawingStyle, selectionGroupId: shape.selectionGroupId });
  });
  it("preserves legacy drawing styles during updates and honors explicit text/geometry styles", () => {
    const input = request();
    input.objects = [previous()];
    const legacy = parseBoardAgentResponse(response([{ type: "update", objectId: "obj-1", expectedRevision: 3, object: drawing() }]), input);
    if (!legacy.ok || legacy.operations[0]?.type !== "update") throw new Error("expected update");
    expect(legacy.operations[0].object.drawingStyle).toBeUndefined();
    expect(legacy.operations[0].object.selectionGroupId).toBeUndefined();
    input.snapshot.imageToBoard = [0.5, 0, 0, 0.5, 0, 0];
    const styled = parseBoardAgentResponse(response([
      { type: "add", object: { ...drawing(), drawingStyle: { kind: "clean" } } },
      { type: "add", object: { ...drawing(), kind: "text", text: "x = 2", textStyle: { font: "sans", size: 24, align: "right" } } },
    ]), input);
    if (!styled.ok || styled.operations[0]?.type !== "add" || styled.operations[1]?.type !== "add") throw new Error("expected additions");
    expect(styled.operations[0].object.drawingStyle?.kind).toBe("clean");
    expect(styled.operations[1].object.textStyle).toEqual({ font: "sans", size: 12, align: "right" });
  });
  it("turns bounded model paths into deterministic native material-brush strokes", () => {
    const input = request();
    input.snapshot.imageToBoard = [0.5, 0, 0, 0.5, 5, 10];
    const stroke = {
      ...drawing(),
      kind: "path",
      x: 20,
      y: 30,
      width: 120,
      height: 80,
      strokeWidth: 36,
      points: [
        { x: 10, y: 20, pressure: 0.2, tiltX: -30, t: 0 },
        { x: 70, y: 40, pressure: 0.9, tiltX: 25, twist: 120, t: 80 },
      ],
      brush: { kind: "sumi", dryness: 0.72, flow: 0.56 },
    };
    const result = parseBoardAgentResponse(response([{ type: "add", object: stroke }]), input);
    if (!result.ok || result.operations[0]?.type !== "add") throw new Error("expected brush addition");
    const object = result.operations[0].object;
    expect(object).toMatchObject({
      kind: "path",
      x: 20,
      y: 35,
      width: 30,
      height: 10,
      strokeWidth: 18,
      brush: { kind: "sumi", dryness: 0.72, flow: 0.56 },
      points: [
        { x: 0, y: 0, pressure: 0.2, tiltX: -30, t: 0 },
        { x: 30, y: 10, pressure: 0.9, tiltX: 25, twist: 120, t: 80 },
      ],
    });
    expect(object.drawingStyle).toBeUndefined();
    expect(Number.isInteger(object.brush?.seed)).toBe(true);
  });
  it("keeps model brush input data-only and rejects invalid brush placement or samples", () => {
    const path = {
      ...drawing(),
      kind: "path",
      points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
    };
    for (const object of [
      { ...path, brush: { kind: "oil", seed: 3 } },
      { ...path, brush: { kind: "oil", resourceHashes: ["a".repeat(64)] } },
      { ...drawing(), brush: { kind: "pencil" } },
      { ...path, brush: { kind: "watercolor" }, drawingStyle: { kind: "sketch" } },
      { ...path, points: [{ x: 0, y: 0, pressure: 1.1 }, { x: 20, y: 20 }], brush: { kind: "pen" } },
    ]) expect(parseBoardAgentResponse(response([{ type: "add", object }]), request())).toMatchObject({ ok: false, code: "invalid-response" });
  });
  it("accepts exact available sticker versions independently of the chosen character", () => {
    const input = request();
    input.availableAssets = builtInBoardAssets();
    const asset = input.availableAssets.find(item => item.usage === "sticker")!;
    const sticker = { ...drawing(), kind: "sticker", assetId: asset.id, assetVersion: asset.version };
    const result = parseBoardAgentResponse(response([{ type: "add", object: sticker }]), input);
    if (!result.ok || result.operations[0]?.type !== "add") throw new Error("expected sticker");
    expect(result.operations[0].object).toMatchObject({ kind: "sticker", assetId: asset.id, assetVersion: 1 });
    expect(result.operations[0].object.characterId).toBeUndefined();
    for (const bad of [{ ...sticker, assetVersion: 2 }, { ...sticker, assetId: "https://example.com/image.png" }, { ...sticker, assetVersion: undefined }])
      expect(parseBoardAgentResponse(response([{ type: "add", object: bad }]), input)).toMatchObject({ ok: false, code: "invalid-response" });
  });
  it("rejects malformed seeds, grouping IDs, URLs and styles on the wrong kind", () => {
    for (const extra of [
      { selectionGroupId: "spoofed" }, { drawingStyle: { kind: "sketch", seed: -3 } },
      { textStyle: { font: "handwritten", size: 20, align: "left" } },
      { assetId: "asset", assetVersion: 1 }, { url: "https://example.com/image.png" },
    ]) expect(parseBoardAgentResponse(response([{ type: "add", object: { ...drawing(), ...extra } }]), request())).toMatchObject({ ok: false, code: "invalid-response" });
  });
  it("permits an empty response and describes buffer versions, teaching questions, styles and assets in the shared prompt", () => {
    const input = request();
    input.bufferRevision = "buffer-5";
    input.availableAssets = builtInBoardAssets();
    expect(parseBoardAgentResponse(response([]), input)).toMatchObject({ ok: true, operations: [] });
    const prompt = buildBoardPrompt(input);
    expect(prompt).toContain("buffer-5");
    expect(prompt).toContain("teaching question");
    expect(prompt).toContain("handwritten");
    expect(prompt).toContain("sumi");
    expect(prompt).toContain("bristleDensity");
    expect(prompt).toContain("purposeful full strokes");
    expect(prompt).toContain("Valid material-brush path example");
    expect(prompt).toContain("MUST NOT have brush");
    expect(prompt).toContain("never emit null");
    expect(prompt).toContain("pressureSize, pressureFlow and pressureOpacity are NUMBERS");
    expect(prompt).toContain("tutor-kaomoji-thinking");
    expect(prompt).toContain('"assetVersion":1');
    expect(prompt).not.toContain("assetPath");
  });
  it("provides a complete sticker example from the actual asset list with required color, size and nonzero stroke", () => {
    const input = request();
    input.availableAssets = builtInBoardAssets();
    const prompt = buildBoardPrompt(input);
    const prefix = "Complete sticker example: ";
    const example = JSON.parse(prompt.split("\n\n").find(line => line.startsWith(prefix))!.slice(prefix.length));
    expect(example).toMatchObject({ type: "add", object: { kind: "sticker", color: "#6655aa", strokeWidth: 2, width: 120, height: 64, assetId: "tutor-kaomoji-thinking", assetVersion: 1 } });
    expect(parseBoardAgentResponse(response([example]), input)).toMatchObject({ ok: true });
    expect(prompt).toContain("INCLUDING text, character and sticker");
    expect(prompt).toContain("strokeWidth MUST be a number from 0.5 through 200");
    expect(buildBoardPrompt(request())).not.toContain(prefix);
  });
  it("uses the real request identity in every response example and explicit screenshot bounds", () => {
    const input = request();
    input.baseRevision = 19;
    const prompt = buildBoardPrompt(input);
    const format = JSON.parse(prompt.split("\n\n").find(line => line.startsWith("Format: "))!.slice("Format: ".length));
    expect(format).toMatchObject({ requestId: input.requestId, baseRevision: 19 });
    expect(prompt).toContain("x + width <= 500");
    expect(prompt).toContain("y + height <= 400");
    expect(prompt).toContain("width >= 0");
    expect(prompt).toContain("never direction vectors");
    expect(prompt).toContain("NOT required output dimensions");
    expect(prompt).not.toContain('"baseRevision":0');
  });
  it("maps snapshot pixels to canonical quarter-turn coordinates and stamps ownership", () => {
    const input = request();
    input.snapshot.imageToBoard = [0, 0.5, -0.5, 0, 300, 100];
    const result = parseBoardAgentResponse(response(), input);
    expect(result.ok).toBe(true);
    if (!result.ok || result.operations[0]?.type !== "add")
      throw new Error("expected add");
    expect(result.operations[0].object).toMatchObject({
      x: 290,
      y: 105,
      width: 40,
      height: 30,
      rotation: Math.PI / 2,
      strokeWidth: 1,
      createdBy: "tutor",
      editedBy: "tutor",
      revision: 1,
      groupId: "group-request-1",
      anchor: input.anchor,
    });
    expect(result.operations[0].object.id).toMatch(/^obj-/);
  });

  it("rejects the whole response when an operation spoofs ownership or changes a learner object", () => {
    expect(
      parseBoardAgentResponse(
        response([
          { type: "add", object: { ...drawing(), createdBy: "human" } },
        ]),
        request(),
      ),
    ).toMatchObject({ ok: false, code: "invalid-response" });
    const input = request();
    input.objects = [previous("human")];
    const result = parseBoardAgentResponse(
      response([
        { type: "add", object: drawing() },
        { type: "remove", objectId: "obj-1", expectedRevision: 3 },
      ]),
      input,
    );
    expect(result).toMatchObject({ ok: false, code: "invalid-response" });
    expect(input.objects).toHaveLength(1);
    expect(input.objects[0]!.createdBy).toBe("human");
  });

  it("checks revision and anchor before updating tutor objects and retains object IDs", () => {
    const input = request();
    input.objects = [previous()];
    const operation = {
      type: "update",
      objectId: "obj-1",
      expectedRevision: 3,
      object: drawing(),
    };
    const result = parseBoardAgentResponse(response([operation]), input);
    expect(result).toMatchObject({
      ok: true,
      operations: [
        {
          type: "update",
          objectId: "obj-1",
          expectedRevision: 3,
          object: { id: "obj-1", revision: 4, createdBy: "tutor" },
        },
      ],
    });
    expect(
      parseBoardAgentResponse(
        response([{ ...operation, expectedRevision: 1 }]),
        input,
      ).ok,
    ).toBe(false);
    input.objects[0]!.editedBy = "human";
    expect(parseBoardAgentResponse(response([operation]), input).ok).toBe(
      false,
    );
    input.objects[0]!.editedBy = "tutor";
    input.objects[0]!.anchor = { kind: "pdf", page: 2 };
    expect(parseBoardAgentResponse(response([operation]), input).ok).toBe(
      false,
    );
  });

  it("rejects duplicate operations, stale identities, oversized output and non-JSON prose", () => {
    const input = request();
    input.objects = [previous()];
    const remove = { type: "remove", objectId: "obj-1", expectedRevision: 3 };
    expect(parseBoardAgentResponse(response([remove, remove]), input).ok).toBe(
      false,
    );
    expect(
      parseBoardAgentResponse(
        response().replace('"request-1"', '"old"'),
        input,
      ),
    ).toMatchObject({ ok: false, code: "stale-response" });
    expect(
      parseBoardAgentResponse(
        response().replace('"baseRevision":2', '"baseRevision":1'),
        input,
      ),
    ).toMatchObject({ ok: false, code: "stale-response" });
    expect(parseBoardAgentResponse("x".repeat(250_001), input).ok).toBe(false);
    expect(
      parseBoardAgentResponse(`I drew this: ${response()}`, input).ok,
    ).toBe(false);
    expect(
      parseBoardAgentResponse(`\`\`\`json\n${response()}\n\`\`\``, input).ok,
    ).toBe(true);
  });

  it("rejects off-screen geometry, unsafe colors, bad points, and unknown character assets", () => {
    for (const object of [
      { ...drawing(), x: 490 },
      { ...drawing(), width: -1 },
      { ...drawing(), color: "url(http://example.com)" },
      { ...drawing(), kind: "path" },
      {
        ...drawing(),
        kind: "path",
        points: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
      },
      {
        ...drawing(),
        kind: "character",
        characterId: "remote",
        characterVersion: 1,
      },
      {
        ...drawing(),
        kind: "character",
        characterId: "tutor-round",
        characterVersion: 2,
      },
    ])
      expect(
        parseBoardAgentResponse(response([{ type: "add", object }]), request())
          .ok,
      ).toBe(false);
    expect(
      parseBoardAgentResponse(
        response([
          {
            type: "add",
            object: {
              ...drawing(),
              kind: "character",
              characterId: "tutor-round",
              characterVersion: 1,
              expression: "thinking",
            },
          },
        ]),
        request(),
      ).ok,
    ).toBe(true);
  });

  it("tightens path bounds so renderer normalization does not move the intended line", () => {
    const result = parseBoardAgentResponse(
      response([
        {
          type: "add",
          object: {
            ...drawing(),
            kind: "arrow",
            points: [
              { x: 10, y: 30 },
              { x: 60, y: 30 },
            ],
          },
        },
      ]),
      request(),
    );
    expect(result).toMatchObject({
      ok: true,
      operations: [
        {
          object: {
            x: 20,
            y: 50,
            width: 50,
            height: 1,
            points: [
              { x: 0, y: 0 },
              { x: 50, y: 0 },
            ],
          },
        },
      ],
    });
  });

  it("accepts actual model output for a horizontal arrow with zero height", () => {
    const result = parseBoardAgentResponse(
      response([
        {
          type: "add",
          object: {
            ...drawing(),
            kind: "arrow",
            height: 0,
            points: [
              { x: 0, y: 0 },
              { x: 80, y: 0 },
            ],
          },
        },
      ]),
      request(),
    );
    expect(result).toMatchObject({
      ok: true,
      operations: [{ object: { width: 80, height: 1 } }],
    });
  });

  it("rejects invalid screenshot transforms before requesting or applying drawings", () => {
    for (const matrix of [
      [1, 0, 0, -1, 0, 0],
      [1, 1, 0, 1, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ]) {
      const input = request();
      input.snapshot.imageToBoard =
        matrix as typeof input.snapshot.imageToBoard;
      expect(parseBoardAgentResponse(response(), input).ok).toBe(false);
      expect(() => buildBoardApiBody("vision", input)).toThrow(
        "invalid-snapshot-transform",
      );
    }
  });
});

describe("board engine adapters", () => {
  it("uses image content without changing ordinary chat bodies", async () => {
    const transport = vi.fn(async () => apiReply());
    const agent = createBoardAgent({
      engine: "api",
      model: "vision",
      baseUrl: "https://example.com/v1/",
      apiKey: "secret",
      httpRequest: transport,
    });
    expect((await agent.request(request())).ok).toBe(true);
    const call = transport.mock.calls[0] as unknown as [
      { body: string; url: string },
    ];
    const body = JSON.parse(call[0].body);
    expect(call[0].url).toBe("https://example.com/v1/chat/completions");
    expect(body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
    expect(
      JSON.parse(
        buildChatMessagesBody("chat", [{ role: "user", content: "hi" }]),
      ).messages[0].content,
    ).toBe("hi");
    agent.dispose();
  });

  it("surfaces image capability errors without retrying as text", async () => {
    const transport = vi.fn(async () => ({
      status: 400,
      text: '{"error":{"message":"This model does not support image input"}}',
    }));
    const agent = createBoardAgent({
      engine: "api",
      model: "text-only",
      baseUrl: "https://example.com",
      apiKey: "key",
      httpRequest: transport,
    });
    expect(await agent.request(request())).toMatchObject({
      ok: false,
      code: "image-not-supported",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancelled HTTP call serial and discards its late result", async () => {
    let finish!: (value: ReturnType<typeof apiReply>) => void;
    const transport = vi.fn(
      () =>
        new Promise<ReturnType<typeof apiReply>>((resolve) => {
          finish = resolve;
        }),
    );
    const agent = createBoardAgent({
      engine: "api",
      model: "vision",
      baseUrl: "https://example.com",
      apiKey: "key",
      httpRequest: transport,
    });
    const pending = agent.request(request());
    agent.cancel();
    expect(await agent.request(request())).toMatchObject({
      ok: false,
      code: "busy",
    });
    finish(apiReply());
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    agent.dispose();
    expect(await agent.request(request())).toMatchObject({
      ok: false,
      code: "cancelled",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("opens an isolated image-capable ACP session with strict model and denied tools", async () => {
    const prompt = vi.fn(async () => ({
      ok: true,
      text: response(),
      stopReason: "end_turn",
    }));
    const cancel = vi.fn(),
      dispose = vi.fn();
    const startSession = vi.fn(
      async () =>
        ({
          session: { prompt, cancel },
          dispose,
        }) as unknown as AcpSessionHandle,
    );
    const agent = createBoardAgent({
      engine: "opencode",
      model: "provider/vision",
      cwd: "/vault",
      startSession: startSession as typeof startAcpSession,
    });
    expect((await agent.request(request())).ok).toBe(true);
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requireImageSupport: true,
        strictModelSelection: true,
        denyTools: true,
        cwd: "/vault",
        model: "provider/vision",
      }),
    );
    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({ type: "text" }),
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    await agent.request(request());
    expect(startSession).toHaveBeenCalledTimes(1);
    agent.cancel();
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await agent.request(request());
    expect(startSession).toHaveBeenCalledTimes(1);
    agent.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a session that finishes opening after cancellation", async () => {
    let opened!: (handle: AcpSessionHandle) => void;
    const startSession = vi.fn(
      () =>
        new Promise<AcpSessionHandle>((resolve) => {
          opened = resolve;
        }),
    );
    const dispose = vi.fn(),
      prompt = vi.fn();
    const agent = createBoardAgent({
      engine: "opencode",
      model: "vision",
      cwd: "/vault",
      startSession,
    });
    const pending = agent.request(request());
    agent.cancel();
    opened({
      session: { prompt } as unknown as AcpSessionHandle["session"],
      dispose,
    });
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("rejects a partially completed ACP response even when it contains valid JSON", async () => {
    const startSession = vi.fn(
      async () =>
        ({
          session: {
            prompt: async () => ({
              ok: true,
              text: response(),
              stopReason: "max_tokens",
            }),
            cancel: () => {},
          },
          dispose: () => {},
        }) as unknown as AcpSessionHandle,
    );
    const agent = createBoardAgent({
      engine: "opencode",
      model: "vision",
      cwd: "/vault",
      startSession: startSession as typeof startAcpSession,
    });
    expect(await agent.request(request())).toMatchObject({
      ok: false,
      code: "incomplete-response",
    });
  });
});

describe("BoardRequestScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for pen idle, coalesces changes and spaces automatic starts by three seconds", async () => {
    vi.useFakeTimers();
    const scheduler = new BoardRequestScheduler();
    const run = vi.fn(async () => {});
    scheduler.changed("ignored", run);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    scheduler.setEnabled(true);
    scheduler.changed("1", run);
    await vi.advanceTimersByTimeAsync(900);
    scheduler.changed("2", run);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.changed("2", run);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.changed("3", run);
    await vi.advanceTimersByTimeAsync(1999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("allows an explicit one-shot instruction while paused, without overlapping a pending request", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const first = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      second = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler();
    scheduler.requestNow("1", first);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.requestNow("2", second);
    await vi.advanceTimersByTimeAsync(10000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("invalidates running context, drops queued changes and prevents old work resuming after pause", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let signal!: AbortSignal;
    const first = (s: AbortSignal) => {
      signal = s;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const second = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler();
    scheduler.setEnabled(true);
    scheduler.requestNow("1", first);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.changed("2", second);
    scheduler.setEnabled(false);
    expect(signal.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(10000);
    expect(second).not.toHaveBeenCalled();
    scheduler.dispose();
    scheduler.requestNow("3", second);
    await vi.advanceTimersByTimeAsync(10000);
    expect(second).not.toHaveBeenCalled();
  });

  it("preserves a queued manual instruction across incidental invalidation before it starts", async () => {
    vi.useFakeTimers();
    const scheduler = new BoardRequestScheduler();
    const run = vi.fn(async () => {});
    scheduler.requestNow("manual", run);
    scheduler.invalidate({ preserveQueued: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("aborts active work without replaying it and preserves only an already queued instruction", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let signal!: AbortSignal;
    const first = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const second = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler();
    scheduler.requestNow("first", first);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.requestNow("second", second);
    scheduler.invalidate({ preserveQueued: true });
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    scheduler.invalidate({ preserveQueued: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("drops a preserved manual instruction when subsequently paused", async () => {
    vi.useFakeTimers();
    const scheduler = new BoardRequestScheduler();
    const run = vi.fn(async () => {});
    scheduler.setEnabled(true);
    scheduler.requestNow("manual", run);
    scheduler.invalidate({ preserveQueued: true });
    scheduler.setEnabled(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("keeps a manual instruction queued while the editor is unready and resumes only after wake", async () => {
    vi.useFakeTimers();
    let ready = false;
    const run = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler({ canRun: () => ready });
    scheduler.requestNow("manual", run);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("preserves the newest automatic change while composing without restarting its completed idle wait", async () => {
    vi.useFakeTimers();
    let ready = false;
    const first = vi.fn(async () => {}),
      latest = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler({ canRun: () => ready });
    scheduler.setEnabled(true);
    scheduler.changed("first", first);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.changed("latest", latest);
    scheduler.invalidate({ preserveQueued: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    ready = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("rechecks readiness at drain without consuming an instruction whose timer was already armed", async () => {
    vi.useFakeTimers();
    let ready = true;
    const run = vi.fn(async () => {});
    const scheduler = new BoardRequestScheduler({ canRun: () => ready });
    scheduler.requestNow("manual", run);
    ready = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    ready = true;
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("holds a shared lease after cancel/dispose until the old transport settles, then wakes the other view", async () => {
    vi.useFakeTimers();
    const coordination = new BoardRequestCoordination();
    const first = new BoardRequestScheduler({ coordination });
    const second = new BoardRequestScheduler({ coordination });
    let finish!: () => void;
    let signal!: AbortSignal;
    const oldTransport = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const nextTransport = vi.fn(async () => {});
    first.requestNow("old", oldTransport);
    await vi.advanceTimersByTimeAsync(0);
    first.dispose();
    expect(signal.aborted).toBe(true);
    expect(coordination.running).toBe(true);
    second.requestNow("new", nextTransport);
    await vi.advanceTimersByTimeAsync(10000);
    expect(nextTransport).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(nextTransport).toHaveBeenCalledTimes(1);
    expect(coordination.running).toBe(false);
    second.requestNow("another", nextTransport);
    await vi.advanceTimersByTimeAsync(0);
    expect(nextTransport).toHaveBeenCalledTimes(2);
    second.dispose();
  });

  it("shares the three-second automatic rate limit across view changes and disposed schedulers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const coordination = new BoardRequestCoordination();
    const first = new BoardRequestScheduler({ coordination });
    const second = new BoardRequestScheduler({ coordination });
    const starts: number[] = [];
    const run = vi.fn(async () => {
      starts.push(Date.now());
    });
    first.setEnabled(true);
    first.changed("first", run);
    await vi.advanceTimersByTimeAsync(1000);
    expect(starts).toEqual([1000]);
    first.dispose();
    second.setEnabled(true);
    second.changed("second", run);
    await vi.advanceTimersByTimeAsync(2999);
    expect(starts).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1000, 4000]);
    second.dispose();
  });

  it("deduplicates automatic observations queued in both views and retains the completed key after closing one", async () => {
    vi.useFakeTimers();
    const coordination = new BoardRequestCoordination();
    const first = new BoardRequestScheduler({ coordination });
    const second = new BoardRequestScheduler({ coordination });
    const run = vi.fn(async () => {});
    first.setEnabled(true);
    second.setEnabled(true);
    first.changed("shared-buffer", run);
    second.changed("shared-buffer", run);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    first.dispose();
    second.changed("shared-buffer", run);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    second.requestNow("shared-buffer", run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    second.dispose();
  });

  it("allows the newly focused view to retry cancelled context while still sharing its start limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const coordination = new BoardRequestCoordination();
    const first = new BoardRequestScheduler({ coordination });
    const second = new BoardRequestScheduler({ coordination });
    let finish!: () => void;
    first.requestNow(
      "same-buffer",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    first.invalidate();
    const run = vi.fn(async () => {});
    second.setEnabled(true);
    second.changed("same-buffer", run);
    await vi.advanceTimersByTimeAsync(2400);
    finish();
    await vi.advanceTimersByTimeAsync(499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    first.dispose();
    second.dispose();
  });
});

const event = (seq: number, fields: Record<string, unknown>, input = request()) => JSON.stringify({
  requestId: input.requestId, baseRevision: input.baseRevision, sourceRevision: input.sourceRevision,
  bufferRevision: input.bufferRevision ?? null, seq, ...fields,
}) + "\n";

describe("incremental board protocol", () => {
  it("deduplicates board text independently of observation revisions across shared views", () => {
    const shared = new BoardRequestCoordination();
    expect(shared.claimTextRequest("text-1", "请画一个圆")).toBe(true);
    expect(shared.claimTextRequest("text-1", " 请画一个圆 ")).toBe(false);
    expect(shared.claimTextRequest("text-1", "请画一个方框")).toBe(true);
    expect(shared.claimTextRequest("text-2", "请画一个圆")).toBe(true);
  });
  it("accepts a missing turn.end only with explicit normal transport completion", () => {
    const stream = new BoardResponseStream(request());
    stream.push(event(0, { type: "operation", operation: { type: "add", object: drawing() } }));
    expect(stream.finish()).toMatchObject({ ok: false, code: "incomplete-response" });
    expect(stream.finish(true)).toMatchObject({ ok: true, operations: [{ type: "add" }] });
  });
  it.each([
    "",
    event(0, { type: "turn.begin" }),
    event(0, { type: "reply.delta", text: "hello" }) + '{"seq":1',
    event(0, { type: "path.start", key: "unfinished", object: { ...drawing(), kind: "path", points: [{x:0,y:0},{x:10,y:10}] } }),
  ])("never treats a partial or empty turn as complete despite normal stop", data => {
    const stream = new BoardResponseStream(request());
    stream.push(data);
    expect(stream.finish(true)).toMatchObject({ ok: false, code: data ? "incomplete-response" : "provider-no-output" });
  });
  it("distinguishes incomplete drawing data after a normal stop from an interrupted transport",()=>{
    const input=request();
    for(const [data,reason] of [
      ['', 'provider-no-output'],
      [event(0,{type:'turn.begin'}), 'empty-drawing-response'],
      [event(0,{type:'reply.delta',text:'绘图'})+'{"seq":1', 'incomplete-drawing-json'],
      [event(0,{type:'path.start',key:'curve',object:{...drawing(),kind:'path',points:[{x:0,y:0},{x:10,y:10}]}}), 'unfinished-drawing-path'],
    ]){
      const parser=new BoardResponseStream(input);parser.push(data!);
      expect(parser.finish()).toMatchObject({ok:false,error:'incomplete-stream-response'});
      expect(parser.finish(true)).toMatchObject({ok:false,error:reason});
    }
  });
  it.each(["stop", "length", undefined])("checks provider completion proof: %s", async finishReason => {
    const httpStream: HttpStream = async input => {
      input.onResponse({ status:200, contentType:"text/event-stream" });
      input.onChunk(`data: ${JSON.stringify({choices:[{delta:{content:event(0,{type:"operation",operation:{type:"add",object:drawing()}})},finish_reason:finishReason}]})}\n\ndata: [DONE]\n\n`);
    };
    const agent = createBoardAgent({engine:"api",model:"vision",apiKey:"dummy",baseUrl:"https://example.com",httpStream});
    expect((await agent.request(request())).ok).toBe(finishReason === "stop");
    agent.dispose();
  });
  it("streams text and validated drawings before turn.end with stable final IDs and seeds", () => {
    const events: BoardAgentEvent[] = [];
    const input = request();
    const stream = new BoardResponseStream(input, update => events.push(update));
    const data = event(0, { type: "reply.delta", text: '看看这里：{“力”}\\n' }) + event(1, { type: "operation", operation: { type: "add", object: drawing() } });
    for (const character of data) stream.push(character);
    expect(events[0]).toEqual({ type: "reply", text: '看看这里：{“力”}\\n' });
    const preview = events[1];
    if (preview?.type !== "preview") throw new Error("expected preview");
    expect(stream.finish()).toMatchObject({ ok: false, code: "incomplete-response" });
    stream.push(event(2, { type: "turn.end" }));
    expect(stream.finish()).toMatchObject({ ok: true, operations: preview.operations });
    expect(input.objects).toEqual([]);
  });
  it("appends path points and reuses the same editable object through every preview", () => {
    const events: BoardAgentEvent[] = [];
    const stream = new BoardResponseStream(request(), update => events.push(update));
    stream.push(event(0, { type: "path.start", key: "smile", object: { ...drawing(), kind: "path", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] } }));
    stream.push(event(1, { type: "path.points", key: "smile", points: [{ x: 40, y: 30 }, { x: 80, y: 0 }] }));
    const previews = events.filter(update => update.type === "preview");
    expect(previews).toHaveLength(2);
    const first = previews[0]!.operations[0], next = previews[1]!.operations[0];
    if (first?.type !== "add" || next?.type !== "add") throw new Error("expected path addition");
    expect(first.object.points).toHaveLength(2);
    expect(next.object.points).toHaveLength(4);
    expect(first.object.id).toBe(next.object.id);
    expect(first.object.drawingStyle).toEqual(next.object.drawingStyle);
    stream.push(event(2, { type: "path.end", key: "smile" }) + event(3, { type: "turn.end" }));
    expect(stream.finish()).toMatchObject({ ok: true, operations: previews[1]!.operations });
  });
  it("streams pressure and tilt through one native brush stroke without changing its material seed", () => {
    const events: BoardAgentEvent[] = [];
    const stream = new BoardResponseStream(request(), update => events.push(update));
    stream.push(event(0, { type: "path.start", key: "ink", object: {
      ...drawing(), kind: "path", width: 80, height: 60, strokeWidth: 24,
      brush: { kind: "oil", bristleDensity: 0.8, impasto: 0.7 },
      points: [{ x: 0, y: 10, pressure: 0.25, tiltX: -20, t: 0 }, { x: 30, y: 20, pressure: 0.6, t: 40 }],
    } }));
    stream.push(event(1, { type: "path.points", key: "ink", points: [{ x: 80, y: 50, pressure: 0.95, tiltY: 35, t: 90 }] }));
    const previews = events.filter(update => update.type === "preview");
    expect(previews).toHaveLength(2);
    const first = previews[0]!.operations[0], second = previews[1]!.operations[0];
    if (first?.type !== "add" || second?.type !== "add") throw new Error("expected brush previews");
    expect(first.object.brush).toMatchObject({ kind: "oil", bristleDensity: 0.8, impasto: 0.7 });
    expect(first.object.brush?.seed).toBe(second.object.brush?.seed);
    expect(second.object.points?.at(-1)).toMatchObject({ pressure: 0.95, tiltY: 35, t: 90 });
    stream.push(event(2, { type: "path.end", key: "ink" }) + event(3, { type: "turn.end" }));
    expect(stream.finish()).toMatchObject({ ok: true, operations: previews[1]!.operations });
  });
  it("rejects duplicates, stale buffer/source versions and injected author fields before preview", () => {
    for (const data of [
      event(1, { type: "reply.delta", text: "bad sequence" }),
      event(0, { type: "reply.delta", text: "old", sourceRevision: "outdated" }),
      event(0, { type: "reply.delta", text: "old", bufferRevision: "outdated" }),
      event(0, { type: "operation", operation: { type: "add", object: { ...drawing(), createdBy: "human" } } }),
    ]) {
      const onEvent = vi.fn();
      const stream = new BoardResponseStream(request(), onEvent);
      expect(() => stream.push(data)).toThrow();
      expect(onEvent).not.toHaveBeenCalled();
      expect(stream.finish().ok).toBe(false);
    }
    const stream = new BoardResponseStream(request());
    stream.push(event(0, { type: "reply.delta", text: "first" }));
    expect(() => stream.push(event(0, { type: "reply.delta", text: "duplicate" }))).toThrow("invalid-event-sequence");
  });
  it("rejects points outside original bounds, unknown paths, unfinished paths and events after completion", () => {
    const start = event(0, { type: "path.start", key: "stroke", object: { ...drawing(), kind: "path", points: [{ x: 0, y: 0 }, { x: 2, y: 2 }] } });
    for (const data of [
      event(0, { type: "path.points", key: "unknown", points: [{ x: 0, y: 0 }] }),
      start + event(1, { type: "path.points", key: "stroke", points: [{ x: 100, y: 0 }] }),
      start + event(1, { type: "turn.end" }),
      event(0, { type: "turn.end" }) + event(1, { type: "reply.delta", text: "late" }),
    ]) {
      const stream = new BoardResponseStream(request());
      expect(() => stream.push(data)).toThrow();
      expect(stream.finish().ok).toBe(false);
    }
  });
  it("invalidates the whole group after an illegal update without modifying request objects", () => {
    const input = request();
    input.objects = [previous("human")];
    const before = structuredClone(input);
    const stream = new BoardResponseStream(input);
    stream.push(event(0, { type: "operation", operation: { type: "add", object: drawing() } }));
    expect(() => stream.push(event(1, { type: "operation", operation: { type: "remove", objectId: "obj-1", expectedRevision: 3 } }))).toThrow("invalid-object-update");
    expect(stream.finish().ok).toBe(false);
    expect(input).toEqual(before);
  });
  it("rejects malformed, oversized and incomplete frames and accepts legacy full responses", () => {
    for (const data of ["bad prose", '{"x":' + " ".repeat(160000)]) {
      const stream = new BoardResponseStream(request());
      expect(() => stream.push(data)).toThrow();
    }
    const incomplete = new BoardResponseStream(request());
    incomplete.push('{"type":');
    expect(incomplete.finish()).toMatchObject({ ok: false, code: "incomplete-response" });
    for (const data of [response(), "```json\n" + response() + "\n```", JSON.stringify(JSON.parse(response()), null, 2)]) {
      const stream = new BoardResponseStream(request());
      for (const char of data) stream.push(char);
      expect(stream.finish()).toMatchObject({ ok: true, description: "A smile" });
    }
  });
  it("keeps direct/ACP stream instructions compatible and includes bounded shared history", () => {
    const input = request();
    input.history = [{ role: "user", content: "Earlier teaching question" }];
    const body = JSON.parse(buildBoardApiBody("vision", input, true));
    expect(body).toMatchObject({ stream: true, messages: [{ role: "user", content: "Earlier teaching question" }, { role: "user" }] });
    expect(body.messages[1].content[0].text).toBe(buildBoardStreamPrompt(input));
    expect(buildBoardStreamPrompt(input)).toContain("path.points");
    expect(buildBoardStreamPrompt(input)).not.toContain("Return ONLY one JSON object");
  });
  it("feeds live SSE board events through the transport while the result is pending", async () => {
    const updates: BoardAgentEvent[] = [];
    let complete!: () => void;
    const httpStream: HttpStream = async input => {
      input.onResponse({ status: 200, contentType: "text/event-stream" });
      const send = (text: string) => input.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      send(event(0, { type: "reply.delta", text: "你好" }));
      send(event(1, { type: "operation", operation: { type: "add", object: drawing() } }));
      await new Promise<void>(resolve => { complete = resolve; });
      send(event(2, { type: "turn.end" }));
      input.onChunk('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    const agent = createBoardAgent({ engine: "api", model: "vision", apiKey: "dummy", baseUrl: "https://example.com", httpStream });
    const pending = agent.request(request(), update => updates.push(update));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ type: "reply", text: "你好" });
    complete();
    expect(await pending).toMatchObject({ ok: true, description: "你好", operations: (updates[1] as Extract<BoardAgentEvent, {type: "preview"}>).operations });
    agent.dispose();
  });
  it.each(["end_turn", "max_tokens", undefined])("checks ACP completion proof: %s", async stopReason => {
    const startSession = vi.fn(async () => ({
      session: { prompt: async () => ({ok:true, text:event(0,{type:"operation",operation:{type:"add",object:drawing()}}), stopReason}), cancel:vi.fn() },
      dispose:vi.fn(),
    }) as unknown as AcpSessionHandle);
    const agent = createBoardAgent({engine:"opencode",model:"vision",cwd:"/vault",startSession});
    expect((await agent.request(request())).ok).toBe(stopReason === "end_turn");
    agent.dispose();
  });
  it("uses ACP message chunks before prompt completion and preserves a warm cancelled session", async () => {
    let onUpdate!: Parameters<typeof startAcpSession>[0]["onUpdate"];
    let finish!: (result: { ok: boolean; text: string; stopReason: string }) => void;
    const cancel = vi.fn(() => finish({ ok: true, text: "", stopReason: "cancelled" }));
    const dispose = vi.fn();
    const startSession = vi.fn(async (options: Parameters<typeof startAcpSession>[0]) => {
      onUpdate = options.onUpdate;
      return { session: { prompt: () => new Promise(resolve => { finish = resolve; }), cancel }, dispose } as unknown as AcpSessionHandle;
    });
    const agent = createBoardAgent({ engine: "opencode", model: "vision", cwd: "/vault", startSession });
    const updates: BoardAgentEvent[] = [];
    const first = agent.request(request(), update => updates.push(update));
    await Promise.resolve();
    onUpdate({ type: "message", text: event(0, { type: "reply.delta", text: "现在看这里" }) });
    expect(updates[0]).toEqual({ type: "reply", text: "现在看这里" });
    agent.cancel();
    onUpdate({ type: "message", text: event(1, { type: "reply.delta", text: "late" }) });
    expect(await first).toMatchObject({ ok: false, code: "cancelled" });
    expect(updates).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    const second = agent.request(request());
    onUpdate({ type: "message", text: event(0, { type: "turn.end" }) });
    finish({ ok: true, text: "", stopReason: "end_turn" });
    expect(await second).toMatchObject({ ok: true });
    expect(startSession).toHaveBeenCalledTimes(1);
    agent.dispose();
  });
  it("releases an ACP runtime that ignores cancel after a short grace period", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const startSession = vi.fn(async () => ({ session: { prompt: () => new Promise(() => {}), cancel: vi.fn() }, dispose }) as unknown as AcpSessionHandle);
      const agent = createBoardAgent({ engine: "opencode", model: "vision", cwd: "/vault", startSession });
      const pending = agent.request(request());
      await Promise.resolve();
      agent.cancel();
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
      expect(dispose).toHaveBeenCalledTimes(1);
      agent.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("replacement board turns", () => {
  it("waits for the cancelled streaming HTTP turn before starting its immediate replacement", async () => {
    let calls = 0;
    let lateFirst!: () => void;
    let endSecond!: () => void;
    const transport: HttpStream = async input => {
      calls++;
      input.onResponse({ status: 200, contentType: "text/event-stream" });
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => {
          input.signal!.addEventListener("abort", () => { lateFirst = () => reject(new Error("cancelled")); });
        });
      } else {
        await new Promise<void>(resolve => { endSecond = resolve; });
        input.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: event(0, { type: "turn.end" }) } }] })}\n\ndata: [DONE]\n\n`);
      }
    };
    const agent = createBoardAgent({ engine: "api", model: "vision", apiKey: "dummy", baseUrl: "https://example.com", httpStream: transport });
    const first = agent.request(request());
    agent.cancel();
    const next = agent.request(request());
    expect(calls).toBe(1);
    lateFirst();
    expect(await first).toMatchObject({ ok: false, code: "cancelled" });
    await Promise.resolve();
    expect(calls).toBe(2);
    // The first turn's finally must not reset ownership of the second turn.
    expect(await agent.request(request())).toMatchObject({ ok: false, code: "busy" });
    endSecond();
    expect(await next).toMatchObject({ ok: true });
    agent.dispose();
  });
  it("queues an immediate replacement behind a cancelled ACP turn and preserves the warm handle", async () => {
    let onUpdate!: Parameters<typeof startAcpSession>[0]["onUpdate"];
    let finish!: (result: { ok: boolean; text: string; stopReason: string }) => void;
    const prompt = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const dispose = vi.fn();
    const startSession = vi.fn(async (options: Parameters<typeof startAcpSession>[0]) => {
      onUpdate = options.onUpdate;
      return { session: { prompt, cancel: vi.fn() }, dispose } as unknown as AcpSessionHandle;
    });
    const agent = createBoardAgent({ engine: "opencode", model: "vision", cwd: "/vault", startSession });
    const firstUpdates: BoardAgentEvent[] = [], secondUpdates: BoardAgentEvent[] = [];
    const first = agent.request(request(), update => firstUpdates.push(update));
    await Promise.resolve();
    agent.cancel();
    const next = agent.request(request(), update => secondUpdates.push(update));
    onUpdate({ type: "message", text: event(0, { type: "reply.delta", text: "old" }) });
    expect(firstUpdates).toEqual([]);
    expect(secondUpdates).toEqual([]);
    expect(prompt).toHaveBeenCalledTimes(1);
    finish({ ok: true, text: "", stopReason: "cancelled" });
    expect(await first).toMatchObject({ ok: false, code: "cancelled" });
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(2);
    onUpdate({ type: "message", text: event(0, { type: "reply.delta", text: "new" }) + event(1, { type: "turn.end" }) });
    finish({ ok: true, text: "", stopReason: "end_turn" });
    expect(await next).toMatchObject({ ok: true, description: "new" });
    expect(secondUpdates).toEqual([{ type: "reply", text: "new" }]);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    agent.dispose();
  });
  it("does not start superseded replacement intents after cancellation settles", async () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(() => new Promise(() => {}));
      const startSession = vi.fn(async () => ({ session: { prompt, cancel: vi.fn() }, dispose: vi.fn() }) as unknown as AcpSessionHandle);
      const agent = createBoardAgent({ engine: "opencode", model: "vision", cwd: "/vault", startSession });
      const first = agent.request(request());
      await Promise.resolve();
      agent.cancel();
      const superseded = agent.request(request());
      agent.cancel();
      const replacement = agent.request(request());
      await vi.advanceTimersByTimeAsync(500);
      expect(await first).toMatchObject({ ok: false, code: "cancelled" });
      expect(await superseded).toMatchObject({ ok: false, code: "cancelled" });
      expect(prompt).toHaveBeenCalledTimes(2);
      agent.cancel();
      await vi.advanceTimersByTimeAsync(500);
      expect(await replacement).toMatchObject({ ok: false, code: "cancelled" });
      agent.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("compact board stream identity", () => {
  it("binds identity once and streams small reply phrases, shapes and path segments with only sequence numbers", () => {
    const updates: BoardAgentEvent[] = [];
    const stream = new BoardResponseStream(request(), update => updates.push(update));
    const compact = (seq: number, payload: Record<string, unknown>) => JSON.stringify({ seq, ...payload }) + "\n";
    stream.push(event(0, { type: "turn.begin" }));
    stream.push(compact(1, { type: "reply.delta", text: "看看这个箭头，" }));
    expect(updates).toEqual([{ type: "reply", text: "看看这个箭头，" }]);
    stream.push(compact(2, { type: "reply.delta", text: "它指向哪里？" }));
    stream.push(compact(3, { type: "path.start", key: "arrow", object: { ...drawing(), kind: "arrow", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] } }));
    stream.push(compact(4, { type: "path.points", key: "arrow", points: [{ x: 80, y: 60 }] }));
    stream.push(compact(5, { type: "path.end", key: "arrow" }));
    stream.push(compact(6, { type: "turn.end" }));
    expect(stream.finish()).toMatchObject({ ok: true, description: "看看这个箭头，它指向哪里？" });
    expect(updates.filter(update => update.type === "preview")).toHaveLength(2);
    const prompt = buildBoardStreamPrompt(request());
    expect(prompt).toContain("5–20 Chinese characters");
    expect(prompt).toContain('"type":"turn.begin"');
    expect(prompt).toContain('"seq":1,"type":"reply.delta"');
  });
  it("rejects identity-free events before binding, stale bindings, partial override and identity changes", () => {
    for (const data of [
      '{"seq":0,"type":"reply.delta","text":"unbound"}\n',
      event(0, { type: "turn.begin", sourceRevision: "old" }),
      event(0, { type: "turn.begin" }) + '{"seq":1,"type":"reply.delta","text":"partial","requestId":"request-1"}\n',
      event(0, { type: "turn.begin" }) + event(1, { type: "reply.delta", text: "stale", requestId: "request-2" }),
      event(0, { type: "turn.begin" }) + event(1, { type: "turn.begin" }),
    ]) {
      const stream = new BoardResponseStream(request());
      expect(() => stream.push(data)).toThrow();
      expect(stream.finish().ok).toBe(false);
    }
  });
  it("accepts fully versioned events after a compact header without weakening their identity checks", () => {
    const stream = new BoardResponseStream(request());
    stream.push(event(0, { type: "turn.begin" }) + event(1, { type: "reply.delta", text: "hello" }) + event(2, { type: "turn.end" }));
    expect(stream.finish()).toMatchObject({ ok: true, description: "hello" });
  });
});

describe("host-bound source versions", () => {
  it("accepts a compact turn header with only request identity while keeping source and buffer bound by the host", () => {
    const updates: BoardAgentEvent[] = [];
    const input = { ...request(), bufferRevision: "buffer-current" };
    const stream = new BoardResponseStream(input, event => updates.push(event));
    stream.push(JSON.stringify({ seq: 0, type: "turn.begin", requestId: input.requestId, baseRevision: input.baseRevision }) + "\n");
    stream.push('{"seq":1,"type":"reply.delta","text":"看这个箭头，"}\n{"seq":2,"type":"turn.end"}\n');
    expect(stream.finish()).toMatchObject({ ok: true, description: "看这个箭头，" });
    expect(updates).toHaveLength(1);
  });
  it("checks optional source/buffer fields whenever supplied, including after binding", () => {
    for (const fields of [{ sourceRevision: "old-source" }, { bufferRevision: "old-buffer" }]) {
      const stream = new BoardResponseStream(request());
      stream.push('{"seq":0,"type":"turn.begin","requestId":"request-1","baseRevision":2}\n');
      expect(() => stream.push(JSON.stringify({ seq: 1, type: "reply.delta", text: "stale", ...fields }))).toThrow("stale-response");
      expect(stream.finish().ok).toBe(false);
    }
  });
  it("explicitly distinguishes new arrow objects from operation discriminators in its complete example", () => {
    const prompt = buildBoardStreamPrompt(request());
    expect(prompt).toContain('operation.type is always "add"');
    const arrow = prompt.split("\n").find(line => line.startsWith("Alternative arrow event"))!;
    const parsed = JSON.parse(arrow.slice(arrow.indexOf(": ") + 2));
    expect(parsed).toMatchObject({ type: "operation", operation: { type: "add", object: { kind: "arrow" } } });
    expect(parseBoardAgentResponse(response([parsed.operation]), request()).ok).toBe(true);
  });
});

describe("bounded drawing correction", () => {
  it("repairs illegible Retina font once before placement, with the original snapshot and one replacement preview",async()=>{
    const input=request();input.drawingPixelRatio=2;input.snapshot.imageToBoard=[.5,0,0,.5,0,0];
    const text={...drawing(),kind:'text',text:'中文批注',textStyle:{font:'handwritten',size:16,align:'left'}};
    const bad=parseBoardAgentResponse(response([{type:'add',object:text}]),input);
    const good=parseBoardAgentResponse(response([{type:'add',object:{...text,textStyle:{...text.textStyle,size:24}}}]),input);
    const run=vi.fn<BoardAgent['request']>().mockResolvedValueOnce(bad).mockResolvedValueOnce(good),events:BoardAgentEvent[]=[];
    expect(await requestBoardWithRepair({request:run,cancel:vi.fn(),dispose:vi.fn()},input,e=>events.push(e))).toEqual(good);
    expect(run).toHaveBeenCalledTimes(2);expect(run.mock.calls[1]![0].snapshot).toBe(input.snapshot);
    expect(run.mock.calls[1]![0].protocolCorrection).toContain('at least 24');
    expect(events).toEqual([{type:'reset'},{type:'preview',operations:[]}]);
  });
  it("feeds back the rejected image bounds while preserving the request and refusing the invalid drawing", async () => {
    const input = request();
    const invalid = parseBoardAgentResponse(response([{type:"add", object:{...drawing(), x:490}}]), input);
    expect(invalid).toMatchObject({ok:false,code:"invalid-response",error:"drawing-outside-snapshot",
      drawingBounds:{x:490,imageWidth:input.snapshot.width,imageHeight:input.snapshot.height}});
    const run = vi.fn<BoardAgent["request"]>().mockResolvedValue(invalid);
    expect(await requestBoardWithRepair({request:run,cancel:vi.fn(),dispose:vi.fn()}, input)).toEqual(invalid);
    expect(run).toHaveBeenCalledTimes(2);
    const retry = run.mock.calls[1]![0];
    expect(retry.snapshot).toBe(input.snapshot);
    expect(retry.requestId).toBe(input.requestId);
    expect(retry.protocolCorrection).toContain('"x":490');
    expect(retry.protocolCorrection).toContain(`"imageHeight":${input.snapshot.height}`);
    expect(retry.protocolCorrection).toContain("Do not repeat these rejected coordinates");
  });
  it.each(['incomplete-drawing-json','unfinished-drawing-path'])("replaces a normally finished but unusable drawing once: %s",async error=>{
    const good=parseBoardAgentResponse(response(),request());
    const run=vi.fn<BoardAgent['request']>().mockResolvedValueOnce({ok:false,code:'incomplete-response',error}).mockResolvedValueOnce(good);
    const events:BoardAgentEvent[]=[];
    expect(await requestBoardWithRepair({request:run,cancel:vi.fn(),dispose:vi.fn()},request(),e=>events.push(e))).toEqual(good);
    expect(run).toHaveBeenCalledTimes(2);expect(events).toEqual([{type:'reset'},{type:'preview',operations:[]}]);
    expect(run.mock.calls[1]![0].protocolCorrection).toContain('COMPLETE replacement');
  });
  it.each(['incomplete-stream-response','incomplete-api-response','incomplete-response: length','incomplete-response: content_filter'])("does not mistake interruption or provider termination for a format retry: %s",async error=>{
    const run=vi.fn<BoardAgent['request']>().mockResolvedValue({ok:false,code:'incomplete-response',error});
    await requestBoardWithRepair({request:run,cancel:vi.fn(),dispose:vi.fn()},request());expect(run).toHaveBeenCalledOnce();
  });
  it("replaces a rejected preview and retries geometry once using the same snapshot and identity", async () => {
    const events: BoardAgentEvent[] = [];
    const input = request();
    const good = parseBoardAgentResponse(response(), input);
    const run = vi.fn<BoardAgent["request"]>()
      .mockImplementationOnce(async (_request, emit) => {
        if (good.ok) emit?.({ type: "preview", operations: good.operations });
        return { ok: false, code: "invalid-response", error: "drawing-outside-snapshot" };
      }).mockResolvedValueOnce(good);
    const agent = { request: run, cancel: vi.fn(), dispose: vi.fn() };
    expect(await requestBoardWithRepair(agent, input, event => events.push(event))).toEqual(good);
    expect(events.at(-1)).toEqual({ type: "preview", operations: [] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toMatchObject({ ...input, protocolCorrection: expect.stringContaining("IMAGE bounds") });
    expect(run.mock.calls[1]![0].snapshot).toBe(input.snapshot);
    expect(input.protocolCorrection).toBeUndefined();
  });
  it.each(["stale-response", "invalid-object-update", "unknown-asset-reference", "http-400", "cancelled"])("does not retry %s", async error => {
    const run = vi.fn<BoardAgent["request"]>().mockResolvedValue({ ok: false, code: "invalid-response", error });
    await requestBoardWithRepair({ request: run, cancel: vi.fn(), dispose: vi.fn() }, request());
    expect(run).toHaveBeenCalledOnce();
  });
  it("stops after one correction, and never retries after invalidation", async () => {
    const run = vi.fn<BoardAgent["request"]>().mockResolvedValue({ ok: false, code: "invalid-response", error: "point-outside-drawing" });
    const agent = { request: run, cancel: vi.fn(), dispose: vi.fn() };
    expect(await requestBoardWithRepair(agent, request())).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(2);
    run.mockClear();
    let current = true;
    run.mockImplementationOnce(async () => { current = false; return { ok: false, code: "invalid-response", error: "drawing-outside-snapshot" }; });
    expect(await requestBoardWithRepair(agent, request(), undefined, () => current)).toMatchObject({ code: "cancelled" });
    expect(run).toHaveBeenCalledOnce();
  });
  it("distinguishes streamed schema/geometry rejection from network failure in both transports", async () => {
    const invalid = event(0, { type: "turn.begin" }) + event(1, { type: "operation", operation: { type: "add", object: { ...drawing(), x: 490 } } });
    const transport: HttpStream = async input => {
      input.onResponse({ status: 200, contentType: "text/event-stream" });
      input.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: invalid } }] })}\n\n`);
    };
    const api = createBoardAgent({ engine: "api", model: "vision", baseUrl: "https://example.com", apiKey: "test", httpStream: transport });
    const startSession = vi.fn(async (options: Parameters<typeof startAcpSession>[0]) => ({
      session: { prompt: async () => { options.onUpdate({ type: "message", text: invalid }); return { ok: true, text: invalid }; }, cancel: vi.fn() }, dispose: vi.fn(),
    }) as unknown as AcpSessionHandle);
    const acp = createBoardAgent({ engine: "opencode", model: "vision", cwd: "/tmp", startSession });
    for (const agent of [api, acp]) {
      expect(await agent.request(request())).toMatchObject({ ok: false, code: "invalid-response", error: "drawing-outside-snapshot" });
      agent.dispose();
    }
  });
  it("requires actual operations for semantic drawing requests without drawing keywords", () => {
    const input = { ...request(), instruction: "把它用一幅小图表现出来", requiresDrawing: true };
    expect(parseBoardAgentResponse(response([]), input)).toMatchObject({ ok: false, error: "drawing-request-produced-no-objects" });
    const stream = new BoardResponseStream(input);
    stream.push(event(0, { type: "reply.delta", text: "好的" }, input) + event(1, { type: "turn.end" }, input));
    expect(stream.finish()).toMatchObject({ ok: false, error: "drawing-request-produced-no-objects" });
    const explanation = { ...input, instruction: "包豪斯画派是什么", requiresDrawing: false };
    expect(parseBoardAgentResponse(response([]), explanation)).toMatchObject({ ok: true });
  });
});

describe('provider failures versus drawing corrections',()=>{
  it.each([undefined,'provider-access-403'])('never retries an empty ACP end_turn as a format error: %s',async diagnostic=>{
    const prompt=vi.fn(async()=>({ok:!diagnostic,text:'',stopReason:'end_turn',error:diagnostic,diagnostic}));
    const startSession=vi.fn(async()=>({session:{prompt,error:null,cancel:vi.fn()},dispose:vi.fn()})) as unknown as typeof startAcpSession;
    const agent=createBoardAgent({engine:'opencode',model:'actual/vision',cwd:'/vault',startSession});
    const result=await requestBoardWithRepair(agent,request());
    expect(prompt).toHaveBeenCalledOnce();expect(result).toMatchObject({ok:false,failure:{engine:'opencode',model:'actual/vision',category:diagnostic?'access':'no-output',status:diagnostic?403:undefined}});agent.dispose();
  });
  it('ignores a recovered transport diagnostic when drawing completed successfully',async()=>{
    const startSession=vi.fn(async()=>({session:{prompt:async()=>({ok:true,text:response(),stopReason:'end_turn',diagnostic:'provider-rate-limit-429'}),cancel:vi.fn()},dispose:vi.fn()})) as unknown as typeof startAcpSession;
    const agent=createBoardAgent({engine:'opencode',model:'actual/vision',cwd:'/vault',startSession});
    expect(await agent.request(request())).toMatchObject({ok:true});agent.dispose();
  });
  it('does not retry HTTP 403 even if the body mentions invalid JSON',async()=>{
    const httpStream=vi.fn<HttpStream>(async input=>{input.onResponse({status:403,contentType:'application/json'});input.onChunk('{"error":{"message":"forbidden invalid JSON"}}');});
    const agent=createBoardAgent({engine:'api',model:'vision',baseUrl:'https://example.com',apiKey:'secret',httpStream});
    expect(await requestBoardWithRepair(agent,request())).toMatchObject({ok:false,failure:{category:'access',status:403,retryable:false}});expect(httpStream).toHaveBeenCalledOnce();agent.dispose();
  });
});
