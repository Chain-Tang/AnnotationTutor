// The service worker owns explicit pairing and one-shot requests. A failed
// connection is followed by a status query, never by another paid POST.
import { type AskMessage, type AskProgress, type BridgeConfig, type ConvertMessage, type ConvertResult, type PageMessage, type RuntimeMessage, type SelectionMessage } from "./messages.js";
import { type AskStreamEvent, type CapturePayload } from "./protocol.js";
import { BridgeClient, validRequestId } from "./bridge-client.js";

const bridge = new BridgeClient(chrome.storage.local);
type Operation = {tabId:number;abort:AbortController;config?:BridgeConfig};
const operations = new Map<string,Operation>();
type Receipt = {requestId:string;clientId:string;vaultId:string;kind:"ask"|"capture";state:string};
let receiptTail:Promise<unknown> = Promise.resolve();
async function receipts():Promise<Receipt[]> {const data=await chrome.storage.local.get("clipperRequests");return Array.isArray(data.clipperRequests)?data.clipperRequests as Receipt[]:[];}
function remember(receipt:Receipt, create=false):Promise<void> {
  const next=receiptTail.catch(()=>{}).then(async()=>{
    const all=await receipts(),index=all.findIndex(item=>item.requestId===receipt.requestId&&item.clientId===receipt.clientId);
    if(create&&index>=0)throw new Error("request-already-submitted");
    if(index>=0)all[index]=receipt;
    else {if(all.length>=4096)throw new Error("request-history-capacity-reached");all.push(receipt);}
    await chrome.storage.local.set({clipperRequests:all});
  });receiptTail=next;return next;
}
function assertActive(op:Operation):void {if(op.abort.signal.aborted)throw new Error("cancelled");}
async function configure(op:Operation,capability:"capture"|"ask"):Promise<BridgeConfig> {
  const config=await bridge.load();assertActive(op);
  if(!config||!config.capabilities.includes(capability))throw new Error("capability-not-granted");
  op.config=config;return config;
}
async function requestState(config:BridgeConfig,requestId:string):Promise<string> {
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),2500);
  try{
    const response=await bridge.fetch(config,`/requests/${requestId}`,{signal:abort.signal});
    if(!response.ok)return response.status===404?"not-received":"status-unavailable";
    const data=await response.json() as {state?:unknown};return typeof data.state==="string"?data.state:"status-unavailable";
  }catch{return "status-unavailable";}finally{clearTimeout(timer);}
}
async function cancel(requestId:string,tabId:number|undefined):Promise<void> {
  const op=operations.get(requestId);if(!op||op.tabId!==tabId)return;
  op.abort.abort();
  if(op.config){
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),2500);
    try{await bridge.fetch(op.config,`/requests/${requestId}/cancel`,{method:"POST",signal:abort.signal});}catch{/* The closed POST also aborts the host operation. */}finally{clearTimeout(timer);}
  }
}
function cancelTab(tabId:number){for(const [id,op] of operations)if(op.tabId===tabId)void cancel(id,tabId);}
chrome.tabs.onRemoved.addListener(cancelTab);
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==="loading")cancelTab(tabId);});

let offscreen:Promise<void>|undefined;
async function htmlToMarkdown(html:string,baseUrl:string):Promise<string> {
  offscreen ??= (async()=>{if(!await chrome.offscreen.hasDocument?.())await chrome.offscreen.createDocument({url:"offscreen.html",reasons:[chrome.offscreen.Reason.DOM_PARSER],justification:"Convert the page selected by the learner into Markdown."});})().finally(()=>{offscreen=undefined;});
  await offscreen;
  const message:ConvertMessage={type:"convert",html,baseUrl};
  const result=await chrome.runtime.sendMessage(message) as ConvertResult;
  if(result?.error||typeof result?.markdown!=="string")throw new Error("page-conversion-failed");
  return result.markdown;
}
async function fetchSource(url:string,signal:AbortSignal):Promise<string|undefined> {
  try{const res=await fetch(url,{credentials:"omit",signal});return res.ok?await res.text():undefined;}catch{return undefined;}
}
function notify(ok:boolean):void {
  void chrome.action.setBadgeText({text:ok?"✓":"!"});
  void chrome.action.setBadgeBackgroundColor({color:ok?"#16a34a":"#dc2626"});
  setTimeout(()=>void chrome.action.setBadgeText({text:""}),2000);
}
async function handleCapture(message:PageMessage|SelectionMessage,tabId:number|undefined):Promise<{ok:boolean;error?:string}> {
  if(tabId===undefined)return {ok:false,error:"page-required"};
  const requestId=crypto.randomUUID(),op:Operation={tabId,abort:new AbortController()};operations.set(requestId,op);
  let receipt:Receipt|undefined;
  try{
    const config=await configure(op,"capture");
    let payload:CapturePayload;
    if(message.type==="selection")payload={v:1,kind:"selection",requestId,url:message.url,title:message.title,capturedAt:new Date().toISOString(),markdown:message.selections.map(value=>value.exact).join("\n\n"),selections:message.selections};
    else {
      const [markdown,sourceHtml]=await Promise.all([htmlToMarkdown(message.html,message.url),fetchSource(message.url,op.abort.signal)]);assertActive(op);
      payload={v:1,kind:"page",requestId,url:message.url,title:message.title,capturedAt:new Date().toISOString(),markdown,renderedHtml:message.html,...(sourceHtml?{sourceHtml}:{}),...(message.selections?.length?{selections:message.selections}:{})};
    }
    receipt={requestId,clientId:config.clientId,vaultId:config.vaultId,kind:"capture",state:"submitted"};
    await remember(receipt,true);assertActive(op);
    const response=await bridge.fetch(config,"/capture",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:op.abort.signal});
    const value=await response.json() as {state?:string};
    receipt.state=value.state??"failed";await remember(receipt);
    const ok=response.ok&&value.state==="completed";notify(ok);return {ok,...(!ok?{error:receipt.state}:{})};
  }catch{
    if(receipt&&op.config){receipt.state=await requestState(op.config,requestId);await remember(receipt).catch(()=>{});}
    const ok=receipt?.state==="completed";notify(ok);return {ok,error:ok?undefined:op.abort.signal.aborted?"cancelled":receipt?.state??"capture-unavailable"};
  }finally{operations.delete(requestId);}
}
function progress(tabId:number,event:AskProgress):void {void chrome.tabs.sendMessage(tabId,event).catch(()=>{});}
async function handleAsk(message:AskMessage,tabId:number|undefined):Promise<void> {
  if(tabId===undefined||!validRequestId(message.reqId))return;
  const reqId=message.reqId;
  if(operations.has(reqId))return;
  const op:Operation={tabId,abort:new AbortController()};operations.set(reqId,op);
  let receipt:Receipt|undefined,finished=false;
  const fail=(error:string)=>progress(tabId,{type:"ask-error",reqId,error});
  try{
    const config=await configure(op,"ask");
    const previous=(await receipts()).find(item=>item.requestId===reqId&&item.clientId===config.clientId);
    if(previous){fail(`request-${await requestState(config,reqId)}`);return;}
    const markdown=await htmlToMarkdown(message.html,message.url);assertActive(op);
    const payload={v:1,kind:"ask",requestId:reqId,url:message.url,title:message.title,question:message.question,markdown,...(message.selections?.length?{selections:message.selections}:{})};
    receipt={requestId:reqId,clientId:config.clientId,vaultId:config.vaultId,kind:"ask",state:"submitted"};await remember(receipt,true);assertActive(op);
    const response=await bridge.fetch(config,"/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:op.abort.signal});
    if(!response.ok||!response.body)throw new Error("ask-unavailable");
    if(!response.headers.get("Content-Type")?.startsWith("text/event-stream")){fail(`request-${await requestState(config,reqId)}`);return;}
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
    while(!finished){
      const chunk=await reader.read();if(chunk.done)break;assertActive(op);
      buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>2_000_000)throw new Error("response-too-large");
      let split:number;
      while((split=buffer.indexOf("\n\n"))!==-1){
        const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);
        for(const line of frame.split("\n")){
          if(!line.startsWith("data:"))continue;
          const event=JSON.parse(line.slice(5).trim()) as AskStreamEvent;
          if(event.type==="accepted")continue;
          if(event.type==="delta"){if(!finished)progress(tabId,{type:"ask-delta",reqId,text:event.text});}
          else if(event.type==="done"){finished=true;receipt.state="completed";await remember(receipt);progress(tabId,{type:"ask-done",reqId,text:event.text});}
          else if(event.type==="error"){finished=true;receipt.state=event.error;await remember(receipt);fail(event.error);}
        }
      }
    }
    if(!finished)throw new Error("stream-closed");
  }catch{
    if(receipt&&op.config){receipt.state=await requestState(op.config,reqId);await remember(receipt).catch(()=>{});}
    fail(op.abort.signal.aborted?"cancelled":receipt?`request-${receipt.state}`:"ask-unavailable");
  }finally{operations.delete(reqId);}
}
async function connection(explicit:boolean){
  const result=await bridge.connect(explicit);
  if(result.ok){
    const config=await bridge.load();
    if(config){
      const pending=(await receipts()).filter(item=>item.clientId===config.clientId&&item.vaultId===config.vaultId&&["submitted","queued","running","status-unavailable"].includes(item.state)).slice(0,16);
      for(const item of pending){item.state=await requestState(config,item.requestId);await remember(item);}
    }
  }
  return result;
}
chrome.runtime.onMessage.addListener((message:RuntimeMessage,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id)return undefined;
  if(message.type==="selection"||message.type==="page"){
    void handleCapture(message,sender.tab?.id).then(sendResponse,()=>sendResponse({ok:false,error:"capture-unavailable"}));return true;
  }
  if(message.type==="ask"){void handleAsk(message,sender.tab?.id);sendResponse();return undefined;}
  if(message.type==="cancel-ask"){void cancel(message.reqId,sender.tab?.id).then(()=>sendResponse({ok:true}));return true;}
  if(message.type==="test-pairing"||message.type==="connect-bridge"){
    // Pairing can only originate from the extension's own popup, never a page.
    if(sender.tab||sender.url!==chrome.runtime.getURL("popup.html")){sendResponse({ok:false});return undefined;}
    void connection(message.type==="connect-bridge").then(sendResponse,()=>sendResponse({ok:false}));return true;
  }
  return undefined;
});
