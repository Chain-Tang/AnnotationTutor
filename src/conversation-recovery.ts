import { ConversationTransportError } from "./conversation-diagnostics.js";

type Attempt = { timeoutMs: number; freshConnection: boolean; onDelta(delta: string): boolean | void };

function interrupted(): DOMException { return new DOMException("Conversation cancelled", "AbortError"); }

/** One logical turn shares its deadline and two-call budget across connection
 * recovery and format correction. A partial stream is never replayed. */
export class ConversationRecovery {
  private calls = 0;
  private deadline?: number;
  constructor(private readonly options: {
    signal: AbortSignal;
    timeoutMs: number;
    ensureCurrent(): Promise<void>;
    reserveAdditional(): Promise<void>;
    onReconnect?(): void;
    delayMs?: number;
  }) {}

  private remaining(): number {
    if (this.options.signal.aborted) throw interrupted();
    this.deadline ??= Date.now() + this.options.timeoutMs;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new ConversationTransportError({ok:false,text:"",receivedBytes:0,error:"api-request-timeout"});
    return remaining;
  }

  /** Called only by the existing, proven parser-correction gate. */
  async reserveCorrection(errorCode: string): Promise<void> {
    if (this.calls >= 2) throw new Error(errorCode);
    this.remaining();
    await this.options.ensureCurrent();
    await this.options.reserveAdditional();
    await this.options.ensureCurrent();
    this.remaining();
  }

  private async pause(): Promise<void> {
    const remaining = this.remaining();
    await new Promise<void>((resolve,reject) => {
      const signal=this.options.signal;
      const finish=(error?:Error):void=>{clearTimeout(timer);signal.removeEventListener("abort",abort);error?reject(error):resolve();};
      const abort=():void=>finish(interrupted());
      const timer=setTimeout(()=>finish(),Math.min(this.options.delayMs ?? 600,remaining));
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
    });
    this.remaining();
  }

  async run(send:(attempt:Attempt)=>Promise<{text:string}>,onDelta:(delta:string)=>boolean|void):Promise<{text:string}> {
    let forwarded = false;
    const attempt=async():Promise<{text:string}>=>{
      await this.options.ensureCurrent();
      if(this.calls>=2)throw new Error("learning-model-call-limit");
      const timeoutMs=this.remaining();
      this.calls++;
      let accepting=true;
      try{return await send({timeoutMs,freshConnection:this.calls>1,onDelta:delta=>{
        if(!accepting||this.options.signal.aborted)return;
        forwarded ||= delta.length>0;
        return onDelta(delta);
      }});}finally{accepting=false;}
    };
    try{return await attempt();}
    catch(error){
      if(this.calls!==1||forwarded||!(error instanceof ConversationTransportError)||
        !error.retryableConnection||error.receivedBytes!==0||error.status!==undefined)throw error;
      await this.options.ensureCurrent();
      this.options.onReconnect?.();
      await this.pause();
      await this.options.ensureCurrent();
      await this.options.reserveAdditional();
      await this.options.ensureCurrent();
      return attempt();
    }
  }
}
