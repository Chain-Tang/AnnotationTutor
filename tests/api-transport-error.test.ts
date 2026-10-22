import {EventEmitter} from 'node:events';
import {request} from 'node:https';
import {it,expect,vi,beforeEach} from 'vitest';
import {nodeHttpStream,streamChatCompletion,SocketTransportError,verifiedConnectionReceipt,type HttpStream} from '../src/api-stream.js';
import {beginConversationDiagnostic,conversationDiagnostics,ConversationTransportError} from '../src/conversation-diagnostics.js';
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
 diagnostic.finish(result);expect(result).toMatchObject({ok:false,error:'api-secure-connection-failed',text:'',receivedBytes:0,
   connectionIssue:code==='ERR_TLS_CERT_ALTNAME_INVALID'?'tls-certificate':'tls-record',retryableConnection:code!=='ERR_TLS_CERT_ALTNAME_INVALID'});expect(result.status).toBeUndefined();
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|OPENSSL|private|token/);expect(conversationDiagnostics(owner)[0]!.errorCode).toBe('connection');expect(request).toHaveBeenCalledOnce();
});
it.each([
 ['ECONNRESET','reset'],['ECONNREFUSED','refused'],['EAI_AGAIN','dns-temporary'],['ENOTFOUND','dns-not-found'],['ETIMEDOUT','timeout'],['EPIPE','pipe']
] as const)('provides an authenticated finite zero-byte socket receipt for %s without replay',async(code,connectionIssue)=>{
 socketError(code,'PRIVATE socket detail');
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000});
 expect(result).toMatchObject({ok:false,error:'api-connection-failed',text:'',receivedBytes:0,connectionIssue,retryableConnection:true});
 const error=new ConversationTransportError(result);
 expect(error).toMatchObject({category:'connection',receivedBytes:0,retryableConnection:true,status:undefined});
 expect(request).toHaveBeenCalledOnce();expect(JSON.stringify(error)).not.toContain('PRIVATE');
});
it.each(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_SSL_HANDSHAKE_FAILURE','UNKNOWN_SOCKET'])('does not mark certificate, generic TLS or unknown failure retryable: %s',async code=>{
 socketError(code,'PRIVATE');
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000});
 expect(result.retryableConnection).toBe(false);expect(new ConversationTransportError(result).retryableConnection).toBe(false);
 expect(request).toHaveBeenCalledOnce();
});
it('uses a fresh socket only when requested without weakening TLS',async()=>{
 socketError('ECONNRESET','PRIVATE');
 const options={baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000};
 await streamChatCompletion(options);expect(vi.mocked(request).mock.calls[0]?.[1]).not.toHaveProperty('agent');
 await streamChatCompletion({...options,freshConnection:true});
 expect(vi.mocked(request).mock.calls[1]?.[1]).toMatchObject({agent:false});
 expect(vi.mocked(request).mock.calls[1]?.[1]).not.toHaveProperty('rejectUnauthorized');
 expect(request).toHaveBeenCalledTimes(2);
});
it.each([': 心跳\n\n','data: {"choices":'])('counts received UTF-8 bytes before incomplete SSE emits any text: %s',async part=>{
 const transport:HttpStream=async input=>{input.onResponse({status:200,contentType:'text/event-stream'});input.onChunk(part);throw new SocketTransportError('reset');};
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000},transport);
 expect(result).toMatchObject({ok:false,status:200,text:'',receivedBytes:Buffer.byteLength(part),connectionIssue:'reset',retryableConnection:true});
 expect(new ConversationTransportError(result)).toMatchObject({receivedBytes:Buffer.byteLength(part),status:200,retryableConnection:true});
});
it('does not trust error text, metadata lookalikes or copied connection results',async()=>{
 const options={baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000};
 for(const failure of [new Error('api-connection-failed'),Object.assign(new Error('api-connection-failed'),{connectionIssue:'reset',retryableConnection:true})]){
  const result=await streamChatCompletion(options,async()=>{throw failure;});
  expect(result).toMatchObject({ok:false,receivedBytes:0});expect(result).not.toHaveProperty('retryableConnection');
  expect(new ConversationTransportError(result).retryableConnection).toBe(false);
 }
 const trusted=await streamChatCompletion(options,async()=>{throw new SocketTransportError('reset');});
 expect(new ConversationTransportError(trusted).retryableConnection).toBe(true);
 expect(new ConversationTransportError({...trusted}).retryableConnection).toBe(false);
 expect(new ConversationTransportError({ok:false,text:'',receivedBytes:0,error:'api-connection-failed',retryableConnection:true,connectionIssue:'reset'}).retryableConnection).toBe(false);
});
it.each(['stream','complete'] as const)('includes received UTF-8 byte totals on successful %s responses',async mode=>{
 const body=mode==='stream'?'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
   :'{"choices":[{"message":{"content":"你好"},"finish_reason":"stop"}]}';
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000},async input=>{
  input.onResponse({status:200,contentType:mode==='stream'?'text/event-stream':'application/json'});input.onChunk(body);
 });
 expect(result).toMatchObject({ok:true,text:'你好',receivedBytes:Buffer.byteLength(body)});
 expect(result).not.toHaveProperty('retryableConnection');
});
it('preserves the immutable byte receipt when public result fields or copied receipt are changed',async()=>{
 const part='data: {"choices":';
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000},async input=>{input.onChunk(part);throw new SocketTransportError('reset');});
 result.receivedBytes=0;
 const receipt=verifiedConnectionReceipt(result)!;
 (receipt as {receivedBytes:number}).receivedBytes=0;
 expect(new ConversationTransportError(result).receivedBytes).toBe(Buffer.byteLength(part));
});
it('does not turn a presenter-thrown socket-shaped error into a transport receipt',async()=>{
 const failure=new SocketTransportError('reset');
 const result=await streamChatCompletion({baseUrl:'https://test.example/v1',apiKey:'TEST',model:'test',messages:[],timeoutMs:1000,onDelta:()=>{throw failure;}},async input=>{
  input.onResponse({status:200,contentType:'text/event-stream'});input.onChunk('data: {"choices":[{"delta":{"content":"reply"}}]}\n\n');
 });
 expect(result.text).toBe('reply');expect(result).not.toHaveProperty('retryableConnection');
 expect(new ConversationTransportError(result).retryableConnection).toBe(false);
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
