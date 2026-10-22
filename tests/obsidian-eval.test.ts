import {readFileSync} from 'node:fs';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {it,expect,vi} from 'vitest';

// Run the actual CLI helper with a fake child pipe, not an Obsidian/model claim.
function helper(result:unknown,execute=false){
 const spawn=vi.fn((..._args:unknown[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
  queueMicrotask(async()=>{
   const argv=_args[1] as string[],argument=argv.find(s=>s.startsWith('code='))!.slice(5);
   // Deliberately emulate an incoming socket decoding each byte separately.
   const lossy=[...Buffer.from(argument)].map(b=>Buffer.from([b]).toString()).join('');
   const response=execute?await new Function('require',`return (${lossy});`)(createRequire(import.meta.url)):{__tutorEvaluationId__:'qa-id',result};
   const bytes=Buffer.from('Obsidian CLI\n=> '+JSON.stringify(response)+'\n');
   for(const byte of bytes)child.stdout.write(Buffer.from([byte]));
  });return child;
 });
 const source=readFileSync(new URL('../scripts/obsidian-eval.mjs',import.meta.url),'utf8').replace(/\r\n?/g,'\n').replace(/^import .*;\n/gm,'').replace('export function evaluateObsidian','function evaluateObsidian');
 const evaluate=new Function('spawn','randomUUID',source+'\nreturn evaluateObsidian;')(spawn,()=> 'qa-id') as (code:string,options:{vault:string;timeout:number})=>Promise<unknown>;
 return {evaluate,spawn};
}
it('decodes split UTF-8 bytes without corrupting Chinese or emoji in a verification result',async()=>{
 const expected={text:'函数值与极限，先休息 🐳',nested:['你好']},r=helper(expected);
 expect(await r.evaluate('synthetic',{vault:'Tutor-Acceptance',timeout:1000})).toEqual(expected);
 expect(r.spawn).toHaveBeenCalledOnce();expect(r.spawn.mock.calls[0]![1]).toContain('vault=Tutor-Acceptance');
});
it('does not mistake an arrow inside the result for the CLI response marker',async()=>{
 const expected={text:'const f = (x) => x²; 中文'},r=helper(expected);
 expect(await r.evaluate('synthetic',{vault:'Tutor-Acceptance',timeout:1000})).toEqual(expected);
});
it('preserves a long Unicode instruction across a lossy incoming CLI socket',async()=>{
 const expected={text:'函数值不等于极限 🐳，这条说明没有修改或评分。'.repeat(1200),quote:'"\\n" 是字面转义，不是换行',separator:'行\n隔\u2028符'},r=helper(undefined,true);
 expect(await r.evaluate(`(async()=>(${JSON.stringify(expected)}))()`,{vault:'Tutor-Acceptance',timeout:3000})).toEqual(expected);
 const argv=r.spawn.mock.calls[0]![1] as string[];expect(argv.find(a=>a.startsWith('code='))).not.toMatch(/[^\x00-\x7f]/);
});
it('waits for the decoded asynchronous expression without duplicate execution',async()=>{
 const r=helper(undefined,true);expect(await r.evaluate('Promise.resolve({count:1,text:"中文"})',{vault:'Tutor-Acceptance',timeout:1000})).toEqual({count:1,text:'中文'});expect(r.spawn).toHaveBeenCalledOnce();
});
it('preserves categorical host errors across the same Unicode transport',async()=>{
 const r=helper(undefined,true);await expect(r.evaluate('(()=>{throw Error("合成错误");})()',{vault:'Tutor-Acceptance',timeout:1000})).rejects.toThrow('合成错误');expect(r.spawn).toHaveBeenCalledOnce();
});
