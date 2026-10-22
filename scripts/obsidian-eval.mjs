import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
/** Obsidian may retain its CLI socket after emitting an async eval result.
 * Finish on the complete JSON response, not on the lifetime of that socket.
 * Call serially: Obsidian dispatches CLI evals through one shared channel. */
export function evaluateObsidian(code,{timeout=120000,vault='Documents'}={}){
  return new Promise((resolve,reject)=>{
    const id=randomUUID();
    // The host's CLI socket can split an incoming UTF-8 instruction between
    // bytes of a Chinese character. Keep that wire request ASCII; decode once
    // in the host before evaluation. Output still needs the stream decoder below.
    const encoded=Buffer.from(`(${code})`,'utf8').toString('base64');
    const wrapped=`Promise.resolve().then(()=>eval(require('node:buffer').Buffer.from(${JSON.stringify(encoded)},'base64').toString('utf8'))).then(result=>({__tutorEvaluationId__:${JSON.stringify(id)},result}),error=>({__tutorEvaluationId__:${JSON.stringify(id)},error:String(error)}))`;
    const child=spawn('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli',[`vault=${vault}`,'eval',`code=${wrapped}`],{stdio:['ignore','pipe','pipe']});
    // CLI pipe chunks are bytes. Decode across chunk boundaries before JSON
    // assembly, or a split Chinese/emoji character silently becomes U+FFFD.
    child.stdout.setEncoding('utf8');
    let output='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('Obsidian evaluation timed out before a complete JSON result')),timeout);
    child.stdout.on('data',chunk=>{output+=chunk;for(const marker of output.matchAll(/(?:^|\n)[ \t]*=> /g)){let value;try{value=JSON.parse(output.slice(marker.index+marker[0].length).trim());}catch{continue;}if(value?.__tutorEvaluationId__!==id)continue;finish(value.error?new Error(value.error):null,value.result);return;}});
    child.on('error',error=>finish(error));
    child.on('close',code=>{if(!settled)finish(new Error(`Obsidian evaluation ended (${code}): ${output.slice(-2000)}`));});
    // Keep stderr bounded; do not log arbitrary command inputs or credentials.
    child.stderr.resume();
  });
}
