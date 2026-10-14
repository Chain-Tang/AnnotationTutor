import {describe,it,expect} from 'vitest';
import {AcpTurnDiagnostics,executionFailure,drawingDiagnostics,recordDrawingDiagnostic} from '../src/ai-execution.js';

describe('bounded execution diagnostics',()=>{
  it('attributes child errors only to the active session and clears them between turns',()=>{
    const log=new AcpTurnDiagnostics();
    const error=(session:string)=>`ERROR time=now level=ERROR service=session.prompt sessionID=${session} error="OpenCode's free tier can only be used from within OpenCode"\n`;
    log.push(error('A'));log.begin('A');log.push(error('B'));expect(log.current()).toBeUndefined();
    const line=error('A');log.push(line.slice(0,50));expect(log.current()).toBeUndefined();log.push(line.slice(50));
    expect(log.current()).toBe('provider-access-403');
    log.end();log.push(error('A'));log.begin('A');expect(log.current()).toBeUndefined();
    log.push(`level=ERROR time=2020-01-01T00:00:00.000Z sessionID=A status=403\n`);expect(log.current()).toBeUndefined();
    log.push('x'.repeat(10000)+'\n');expect(log.current()).toBeUndefined();
  });
  it('never invents a provider refusal for unknown empty output',()=>{
    expect(executionFailure('api','vision','forbidden field in a drawing','invalid-response')).toMatchObject({category:'validation'});
    expect(executionFailure('opencode','actual/model','provider-no-output','provider-no-output')).toMatchObject({category:'no-output',status:undefined,recovery:'connection'});
    expect(executionFailure('opencode','actual/model','provider-access-403')).toMatchObject({category:'access',status:403,retryable:false,engine:'opencode',model:'actual/model'});
    expect(executionFailure('api','actual','rate limit','http-429',429)).toMatchObject({category:'rate-limit',status:429});
  });
  it('retains only 50 metadata records and protects records from consumer mutation',()=>{
    for(let i=0;i<60;i++)recordDrawingDiagnostic({requestId:String(i),engine:'api',model:'v',elapsedMs:1,outputChars:0,operationCount:0,ok:false});
    expect(drawingDiagnostics()).toHaveLength(50);expect(drawingDiagnostics()[0]?.requestId).toBe('10');
    const copy=drawingDiagnostics();copy[0]!.model='changed';expect(drawingDiagnostics()[0]?.model).toBe('v');
    expect(Object.keys(copy[0]!)).not.toContain('prompt');
  });
});
