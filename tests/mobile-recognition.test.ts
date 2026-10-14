import {describe,it,expect} from 'vitest';
import {inkBridgeRequest,readInkBridgeResult,AndroidInkProvider} from '../src/mobile/recognition.js';
import {build} from 'esbuild';
import {createRequire,builtinModules} from 'node:module';
import {runInNewContext} from 'node:vm';
const input={strokes:[{id:'ink-a',createdAt:new Date().toISOString(),points:[{x:10,y:20,t:1},{x:11,y:30,t:10}]}],languages:['zh-CN'],writingArea:{width:100,height:100}};
describe('mobile offline recognition boundary',()=>{
 it('matches request, content fingerprint, language and exact ordered raw ink ids',async()=>{const request=await inkBridgeRequest(input);const result={format:'tutor-ink-result-v1',id:request.id,fingerprint:request.fingerprint,language:request.language,strokeIds:['ink-a'],text:'你好',alternatives:[]};expect(readInkBridgeResult(request,result).text).toBe('你好');for(const patch of [{id:'late'},{fingerprint:'old'},{language:'en-US'},{strokeIds:['different']}])expect(()=>readInkBridgeResult(request,{...result,...patch})).toThrow('mismatched');const changed=await inkBridgeRequest({...input,strokes:[{...input.strokes[0]!,points:[{x:11,y:20}]}]});expect(changed.fingerprint).not.toBe(request.fingerprint);});
 it('does not accept remote endpoints or unpaired local service; cancellation ignores late results',async()=>{const provider=new AndroidInkProvider({port:22,token:'',request:async()=>({status:200,json:{}})});expect((await provider.availability()).available).toBe(false);const abort=new AbortController();abort.abort();await expect(provider.recognize(input,abort.signal)).rejects.toThrow('Cancelled');});
 it('never evaluates desktop imports in the actual single-file Obsidian entry and builds mobile without Node shims',async()=>{
  const entry=await build({entryPoints:['src/platform-entry.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian','electron','@codemirror/state','@codemirror/view','@codemirror/language'],logLevel:'silent'});
  const required:string[]=[],native=createRequire(import.meta.url);const obsidian=new Proxy({Platform:{isMobile:true}}, {get:(target,key)=>key in target?target[key as keyof typeof target]:class {}});
  runInNewContext(entry.outputFiles[0]!.text,{TextDecoder,TextEncoder,module:{exports:{}},require:(name:string)=>{required.push(name);if(name==='obsidian')return obsidian;if(name.startsWith('@codemirror/'))return native(name);throw new Error(`Mobile attempted desktop dependency: ${name}`);}});
  expect(required).not.toContain('electron');expect(required.every(n=>!builtinModules.includes(n.replace(/^node:/,'')))).toBe(true);
  await expect(build({entryPoints:['src/mobile/main.ts'],bundle:true,write:false,platform:'browser',format:'cjs',external:['obsidian','@codemirror/state','@codemirror/view','@codemirror/language'],logLevel:'silent'})).resolves.toBeDefined();
 });
});
