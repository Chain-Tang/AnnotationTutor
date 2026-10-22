import {z} from 'zod';
import type {RecognitionProvider,RecognitionRequest,RecognitionResult} from '../board-types.js';
export const inkBridgeRequestSchema=z.object({format:z.literal('tutor-ink-request-v1'),id:z.string().uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),language:z.enum(['zh-Hans','en-US']),strokes:z.array(z.object({id:z.string().min(1).max(160),points:z.array(z.object({x:z.number().finite(),y:z.number().finite(),t:z.number().finite().optional()}).strict()).min(1).max(20000)}).strict()).min(1).max(500),writingArea:z.object({width:z.number().positive(),height:z.number().positive()}),textContext:z.string().max(1000)}).strict();
export type InkBridgeRequest=z.infer<typeof inkBridgeRequestSchema>;
export async function inkBridgeRequest(input:RecognitionRequest):Promise<InkBridgeRequest>{
  const strokes=input.strokes.map(s=>({id:s.id,points:s.points.map(p=>({x:p.x,y:p.y,...(p.t===undefined?{}:{t:p.t})}))}));
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(strokes))))].map(n=>n.toString(16).padStart(2,'0')).join('');
  return inkBridgeRequestSchema.parse({format:'tutor-ink-request-v1',id:crypto.randomUUID(),fingerprint,language:input.languages[0]?.startsWith('zh')?'zh-Hans':'en-US',strokes,writingArea:input.writingArea,textContext:input.textContext?.slice(-1000)??''});
}
export function readInkBridgeResult(request:InkBridgeRequest,raw:unknown):RecognitionResult{
  const result=z.object({format:z.literal('tutor-ink-result-v1'),id:z.string(),fingerprint:z.string(),language:z.string(),strokeIds:z.array(z.string()),text:z.string().max(16000),alternatives:z.array(z.string().max(16000)).max(20)}).strict().parse(raw);
  if(result.id!==request.id||result.fingerprint!==request.fingerprint||JSON.stringify(result.strokeIds)!==JSON.stringify(request.strokes.map(s=>s.id))||result.language!==request.language)throw new Error('recognition-stale-or-mismatched');
  return {text:result.text,alternatives:result.alternatives,language:result.language,provider:'android-mlkit-local',model:result.language,segments:[{text:result.text,strokeIds:result.strokeIds}]};
}
export class AndroidInkProvider implements RecognitionProvider{
  readonly id='android-mlkit-local';
  constructor(private readonly config:{port:number;token:string;request:(url:string,body?:unknown)=>Promise<{status:number;json:unknown}>}){}
  async availability(){try{const r=await this.config.request(`http://127.0.0.1:${this.port()}/status`);return {available:r.status===200,reason:r.status===200?undefined:'companion-unavailable'};}catch{return {available:false,reason:'companion-unavailable'};}}
  private port(){if(!Number.isInteger(this.config.port)||this.config.port<1024||this.config.port>65535||this.config.token.length<32)throw new Error('pair-companion-first');return this.config.port;}
  async recognize(input:RecognitionRequest,signal?:AbortSignal){const request=await inkBridgeRequest(input);if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const result=await this.config.request(`http://127.0.0.1:${this.port()}/recognize`,request);if(signal?.aborted)throw new DOMException('Cancelled','AbortError');if(result.status!==200)throw new Error(`companion-recognition-failed-${result.status}`);return readInkBridgeResult(request,result.json);}
}
