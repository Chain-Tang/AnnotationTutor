import {EventEmitter} from 'node:events';
import {request} from 'node:https';
import {it,expect,vi,beforeEach} from 'vitest';
import {nodeHttpStream,streamChatCompletion} from '../src/api-stream.js';
import {beginConversationDiagnostic,conversationDiagnostics} from '../src/conversation-diagnostics.js';
vi.mock('node:https',()=>({request:vi.fn()}));
beforeEach(()=>{vi.mocked(request).mockReset();});
function socketError(code:string,message:string){
 vi.mocked(request).mockImplementation(((_url:unknown,_options:unknown,_callback:unknown)=>{
  const req=Object.assign(new EventEmitter(),{destroy:vi.fn(),end:()=>queueMicrotask(()=>req.emit('error',Object.assign(new Error(message),{code})))});
  return req;
 }) as unknown as typeof request);
}
it.each(['ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC','ERR_OSSL_BAD_DECRYPT','ERR_TLS_CERT_ALTNAME_INVALID'])('reports secure connection failure without leaking crypto stack or private address: %s',async code=>{
 socketError(code,'OPENSSL_internal:BAD_DECRYPT at /private/secret test.example?token=PRIVATE');
 const owner={},diagnostic=beginConversationDiagnostic(owner,{entry:'sidebar',engine:'api',model:'deepseek-flash',format:'reply_tool'});
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000,onDelta:()=>{throw Error('no-content-expected');}});
 diagnostic.finish(result);expect(result).toMatchObject({ok:false,error:'api-secure-connection-failed',text:''});expect(result.status).toBeUndefined();
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|OPENSSL|private|token/);expect(conversationDiagnostics(owner)[0]!.errorCode).toBe('connection');expect(request).toHaveBeenCalledOnce();
});
it.each(['ECONNRESET','ENOTFOUND','UNRECOGNIZED_SOCKET_ERROR'])('keeps socket failure bounded and does not retry: %s',async code=>{
 socketError(code,'private endpoint and request data');
 await expect(nodeHttpStream({url:'https://test.example',headers:{},body:'',timeoutMs:1000,onResponse:()=>{},onChunk:()=>{}})).rejects.toThrow(code==='UNRECOGNIZED_SOCKET_ERROR'?'api-transport-failed':'api-connection-failed');
 expect(request).toHaveBeenCalledOnce();
});
it('does not reclassify a downstream schema/presenter failure as a connection error',async()=>{
 vi.mocked(request).mockImplementation(((_url:unknown,_options:unknown,callback:(response:unknown)=>void)=>{
  const response=Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'text/event-stream'},setEncoding:vi.fn()});
  const req=Object.assign(new EventEmitter(),{destroy:vi.fn(),end:()=>queueMicrotask(()=>{callback(response);response.emit('data','data: {}\n\n');})});return req;
 }) as unknown as typeof request);
 await expect(nodeHttpStream({url:'https://test.example',headers:{},body:'',timeoutMs:1000,onResponse:()=>{},onChunk:()=>{throw Error('teaching-control-schema-question-id');}})).rejects.toThrow('teaching-control-schema-question-id');
 expect(request).toHaveBeenCalledOnce();
});
