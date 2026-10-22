import { boardVectorAssetSchema } from "./board-model.js";
import { importSafeSvg } from "./board-vector.js";
import { sha256Hex } from "./board-brush-pack.js";
import type { BoardVectorAsset, VectorizationProgress, VectorizationProvider, VectorizationRequest, VectorizationResult } from "./board-types.js";

export type SvgVectorizationExecutor = (
  request: VectorizationRequest,
  signal?: AbortSignal,
  onPreviewSvg?: (svg: string) => void,
) => Promise<{ svg?: string; asset?: BoardVectorAsset; model?: string; warnings?: string[] }>;

export type VTracerResourceManifest={version:string;sha256:string;license:"MIT";source:string};
export type VTracerExecutor=(input:{resource:Uint8Array;image:VectorizationRequest["image"];maxColors:number;simplify:number},signal?:AbortSignal,onPreviewSvg?:(svg:string)=>void)=>Promise<string>;

/** Verified optional-pack boundary. The WASM bytes stay outside main.js and are never evaluated as script. */
export function createVTracerVectorizationProvider(options:{
  manifest:VTracerResourceManifest;
  readResource():Promise<Uint8Array|null>;
  execute:VTracerExecutor;
}):VectorizationProvider{
  let verified:Uint8Array|undefined,loadError:string|undefined;
  const load=async()=>{
    if(verified)return verified;
    const bytes=await options.readResource();if(!bytes)throw new Error("VTracer 可选资源尚未安装");
    if(!/^[a-f\d]{64}$/i.test(options.manifest.sha256)||await sha256Hex(bytes)!==options.manifest.sha256.toLowerCase())throw new Error("VTracer 资源校验失败");
    verified=bytes;return bytes;
  };
  const provider=new SvgVectorizationProvider("vtracer",{trace:true,semantic:false},async(request,signal,onPreviewSvg)=>{
    const resource=await load(),svg=await options.execute({resource,image:request.image,maxColors:Math.max(2,Math.min(64,request.maxColors??16)),simplify:Math.max(0,Math.min(1,request.simplify??.55))},signal,onPreviewSvg);
    return {svg,model:`vtracer-${options.manifest.version}`,warnings:[]};
  },async()=>{try{await load();loadError=undefined;return {available:true};}catch(error){loadError=error instanceof Error?error.message:String(error);return {available:false,reason:loadError};}});
  return provider;
}

/** Adapter boundary for optional VTracer WASM, StarVector, OmniSVG or another remote service. */
export class SvgVectorizationProvider implements VectorizationProvider {
  public constructor(
    public readonly id: string,
    private readonly modes: { trace: boolean; semantic: boolean },
    private readonly execute: SvgVectorizationExecutor,
    private readonly available: () => Promise<{ available: boolean; reason?: string }> = async () => ({ available: true }),
  ) {}
  public availability(): Promise<{ available: boolean; reason?: string }> { return this.available(); }
  public async capabilities(): Promise<{ trace: boolean; semantic: boolean; previews: boolean }> {
    return { ...this.modes, previews: true };
  }
  public async vectorize(
    request: VectorizationRequest,
    signal?: AbortSignal,
    onPreview?: (asset: BoardVectorAsset) => void,
    onProgress?: (progress: VectorizationProgress) => void,
  ): Promise<VectorizationResult> {
    if (!this.modes[request.mode]) throw new Error(`${this.id} does not support ${request.mode} vectorization`);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const started = performance.now();
    const stages: NonNullable<VectorizationResult["stages"]> = [];
    const stage = (name: VectorizationProgress["stage"], message?: string, asset?: BoardVectorAsset) => {
      const at = new Date().toISOString();
      const previous = stages.at(-1);
      if (previous) previous.completedAt ??= at;
      if (!stages.length || stages.at(-1)!.stage !== name) stages.push({ stage: name, startedAt: at, ...(message ? { message } : {}) });
      onProgress?.({ stage: name, ...(message ? { message } : {}), ...(asset ? { asset } : {}) });
    };
    stages.push({ stage: "preprocess", startedAt: new Date().toISOString() });
    const parse = (svg: string, preview = false): BoardVectorAsset => importSafeSvg(svg, {
      id: `vector-${request.requestId}`.slice(0, 160), version: 1,
      name: preview ? "Vector preview" : request.mode === "trace" ? "Traced artwork" : "Semantic artwork",
    }).asset;
    stage(request.mode === "trace" ? "generate" : "plan", request.mode === "trace" ? "Tracing raster contours" : "Planning semantic parts");
    const output = await this.execute(request, signal, svg => {
      if (!onPreview || signal?.aborted) return;
      try { const asset=parse(svg, true);onPreview(asset);onProgress?.({stage:"generate",asset}); } catch { /* Partial provider frames may not be valid SVG yet. */ }
    });
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const parsed = output.asset ? boardVectorAssetSchema.parse(output.asset) : output.svg ? parse(output.svg) : undefined;
    if (!parsed) throw new Error("Vectorization provider returned neither SVG nor a vector asset");
    stage("validate", "Validating safe vector scene", parsed);
    const pathNodes = parsed.nodes.filter(node => node.kind === "path"), semanticNodes = parsed.nodes.filter(node => !!node.semanticRole || !/^path-\d+$/.test(node.name));
    stage("complete", "Vector scene ready", parsed);stages.at(-1)!.completedAt=new Date().toISOString();
    return {
      asset: parsed,
      source: { provider: this.id, model: output.model, generatedAt: new Date().toISOString() },
      latencyMs: Math.max(0, performance.now() - started),
      editability: {
        namedPartRatio: parsed.nodes.length ? semanticNodes.length / parsed.nodes.length : 0,
        pathCount: pathNodes.length,
        commandCount: pathNodes.reduce((sum, node) => sum + (node.path?.length ?? 0), 0),
      },
      stages,
      semanticPartRatio: parsed.nodes.length ? semanticNodes.length / parsed.nodes.length : 0,
      repairCount: 0,
      warnings: output.warnings ?? [],
    };
  }
}

const EXPECTED_CHARACTER_ROLES = ["background","back-hair","body","clothing","face","facial-features","front-hair","hands","props","effects"];
function extractJson(text:string):unknown{
  const clean=text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""),start=clean.indexOf("{"),end=clean.lastIndexOf("}");
  if(start<0||end<start)throw new Error("Semantic vector provider returned no JSON object");
  return JSON.parse(clean.slice(start,end+1));
}
function semanticWarnings(asset:BoardVectorAsset):string[]{
  const warnings:string[]=[];const ids=new Set(asset.nodes.map(node=>node.id));
  for(const node of asset.nodes){if(node.parentId&&!ids.has(node.parentId))warnings.push(`Node ${node.id} references a missing parent`);if(node.kind==="path"&&(node.path?.length??0)<2)warnings.push(`Path ${node.id} is empty`);}
  const roles=new Set(asset.nodes.map(node=>node.semanticRole).filter(Boolean));
  for(const role of EXPECTED_CHARACTER_ROLES)if(!roles.has(role))warnings.push(`Missing semantic part: ${role}`);
  return warnings;
}

/** Vision-model semantic reconstruction. The model returns the internal AST, never executable SVG/XML. */
export function createSemanticVectorizationProvider(options:{
  id:string;model?:string;maxRepairs?:number;
  available():Promise<{available:boolean;reason?:string}>;
  complete(input:{prompt:string;image:VectorizationRequest["image"];repairRound:number;warnings:string[]},signal?:AbortSignal):Promise<string>;
}):VectorizationProvider{
  return {
    id:options.id,availability:options.available,
    async capabilities(){return {trace:false,semantic:true,previews:true};},
    async vectorize(request,signal,onPreview,onProgress){
      if(request.mode!=="semantic")throw new Error(`${options.id} supports semantic vectorization only`);
      const started=performance.now(),stages:NonNullable<VectorizationResult["stages"]>=[],mark=(stage:VectorizationProgress["stage"],message:string,asset?:BoardVectorAsset,repairRound?:number)=>{stages.push({stage,startedAt:new Date().toISOString(),message,completedAt:new Date().toISOString()});onProgress?.({stage,message,...(asset?{asset}:{}),...(repairRound?{repairRound}:{})});};
      mark("preprocess","Preparing the selected image only");let warnings:string[]=[],asset:BoardVectorAsset|undefined,repairCount=0;
      const maxRepairs=Math.max(0,Math.min(3,options.maxRepairs??2));
      for(let round=0;round<=maxRepairs;round++){
        if(signal?.aborted)throw signal.reason??new DOMException("Aborted","AbortError");
        mark(round?"repair":"plan",round?`Repairing semantic scene (${round}/${maxRepairs})`:"Planning named character parts",asset,round||undefined);
        const text=await options.complete({prompt:["Reconstruct the selected raster as one BoardVectorAsset JSON object. Return JSON only; never return SVG/XML, markdown, scripts, URLs, filters or event attributes.",
          'Required root: {"format":"board-vector-v1","id":"semantic-asset","version":1,"name":"...","width":number,"height":number,"rootIds":[string],"nodes":[...],"createdAt":"ISO-8601"}.',
          'Every node requires id,name,kind,transform:[a,b,c,d,e,f],opacity:0..1,blendMode:"normal",visible:boolean,locked:boolean and optional parentId/semanticRole.',
          'Allowed kinds are group,path,shape,text,image,component-instance. Path commands are objects using op M/L/Q/C/A/Z with the matching finite coordinates; close filled silhouettes with Z.',
          'Solid fill example: {"kind":"solid","color":"#RRGGBB","opacity":1}. Stroke example: {"paint":{"kind":"solid","color":"#RRGGBB","opacity":1},"width":2,"lineCap":"round","lineJoin":"round"}.',
          "Build broad silhouettes first, keep separate editable parts, use curves instead of dense line segments, and keep every child after its parent.",
          `Prefer these semantic roles for a person: ${EXPECTED_CHARACTER_ROLES.join(", ")}.`,`User direction: ${request.prompt??"Preserve the visible artwork."}`].join("\n"),image:request.image,repairRound:round,warnings},signal);
        asset=boardVectorAssetSchema.parse(extractJson(text));warnings=semanticWarnings(asset);onPreview?.(asset);mark("validate",warnings.length?warnings.join("; "):"Semantic scene is valid",asset,round||undefined);
        repairCount=round;if(!warnings.length)break;
      }
      if(!asset)throw new Error("Semantic vectorization produced no asset");
      const pathNodes=asset.nodes.filter(node=>node.kind==="path"),semanticNodes=asset.nodes.filter(node=>!!node.semanticRole);
      mark("complete","Semantic vector scene ready",asset);
      return {asset,source:{provider:options.id,model:options.model,generatedAt:new Date().toISOString()},latencyMs:performance.now()-started,editability:{namedPartRatio:asset.nodes.length?semanticNodes.length/asset.nodes.length:0,pathCount:pathNodes.length,commandCount:pathNodes.reduce((sum,node)=>sum+(node.path?.length??0),0)},stages,semanticPartRatio:asset.nodes.length?semanticNodes.length/asset.nodes.length:0,repairCount,warnings};
    },
  };
}

/** Lightweight built-in trace fallback. A downloaded VTracer executor can replace it without changing the UI contract. */
export function createRasterTraceVectorizationProvider(options?:{
  id?:string;
  decode?(image:VectorizationRequest["image"]):Promise<{data:Uint8ClampedArray;width:number;height:number}>;
}):VectorizationProvider{
  const decode=options?.decode??(async image=>{
    if(typeof createImageBitmap!=="function"||typeof OffscreenCanvas!=="function")throw new Error("VTracer resource is not installed and browser raster decoding is unavailable");
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(image.bytes).buffer],{type:image.mimeType})),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext("2d",{willReadFrequently:true});
    if(!context)throw new Error("trace-canvas-unavailable");context.drawImage(bitmap,0,0);const data=context.getImageData(0,0,bitmap.width,bitmap.height).data;bitmap.close();return {data,width:canvas.width,height:canvas.height};
  });
  return {id:options?.id??"local-trace",availability:async()=>({available:true}),capabilities:async()=>({trace:true,semantic:false,previews:true}),async vectorize(request,signal,onPreview,onProgress){
    if(request.mode!=="trace")throw new Error("Local trace supports trace mode only");const started=performance.now();onProgress?.({stage:"preprocess",message:"Decoding selected pixels"});
    const image=await decode(request.image);if(signal?.aborted)throw signal.reason??new DOMException("Aborted","AbortError");
    const maxSide=96,step=Math.max(1,Math.ceil(Math.max(image.width,image.height)/maxSide)),quantize=(value:number)=>Math.round(value/32)*32;
    const nodes:BoardVectorAsset["nodes"]=[],rootId="trace-root";let serial=0;
    for(let y=0;y<image.height;y+=step){let runColor="",runStart=0;const flush=(end:number)=>{if(!runColor)return;nodes.push({id:`trace-${++serial}`,name:`path-${serial}`,kind:"shape",parentId:rootId,transform:[1,0,0,1,0,0],opacity:1,blendMode:"normal",visible:true,locked:false,shape:{kind:"rect",x:runStart,y,width:end-runStart,height:Math.min(step,image.height-y)},fill:{kind:"solid",color:runColor,opacity:1}});};for(let x=0;x<image.width;x+=step){const index=(Math.min(image.height-1,y+Math.floor(step/2))*image.width+Math.min(image.width-1,x+Math.floor(step/2)))*4,alpha=image.data[index+3]!;const color=alpha<24?"":`#${[image.data[index]!,image.data[index+1]!,image.data[index+2]!].map(channel=>Math.min(255,quantize(channel)).toString(16).padStart(2,"0")).join("")}`;if(color!==runColor){flush(x);runColor=color;runStart=x;}}flush(image.width);if(nodes.length>5000)throw new Error("Trace result exceeds 5,000 nodes; increase simplification");}
    const asset=boardVectorAssetSchema.parse({format:"board-vector-v1",id:`trace-${request.requestId}`.slice(0,160),version:1,name:"Quick traced artwork",width:image.width,height:image.height,rootIds:[rootId],createdAt:new Date().toISOString(),nodes:[{id:rootId,name:"Trace",kind:"group",semanticRole:"traced-artwork",transform:[1,0,0,1,0,0],opacity:1,blendMode:"normal",visible:true,locked:false},...nodes]});
    onPreview?.(asset);onProgress?.({stage:"complete",message:"Quick trace ready",asset});return {asset,source:{provider:options?.id??"local-trace",model:"palette-run-v1",generatedAt:new Date().toISOString()},latencyMs:performance.now()-started,editability:{namedPartRatio:1/asset.nodes.length,pathCount:0,commandCount:0},semanticPartRatio:1/asset.nodes.length,repairCount:0,warnings:["VTracer data pack is not installed; used the built-in palette trace fallback."]};
  }};
}
