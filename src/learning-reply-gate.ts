/** Presentation is an observed host fact, never inferred from a model callback.
 * A void/no-op callback is unknown. "provided" does not mean the learner read it. */
export type LearningPresentationObservation={state:"provided"|"unknown";presentationId:string};
export type LearningHelpTicket={presentationId:string};
export type LearningReplyPresenter={
  present(input:{text:string;presentationId:string;signal:AbortSignal}):LearningPresentationObservation|void|Promise<LearningPresentationObservation|void>;
  /** E.g. annotations confirm only after appendDialogue succeeds, not their no-op stream callback. */
  complete?(input:{presentationId:string;signal:AbortSignal}):LearningPresentationObservation|void|Promise<LearningPresentationObservation|void>;
};
export type LearningReplyPlan<Ticket extends LearningHelpTicket>={
  mode:"stream"|"buffer"|"suppress";
  presentationId:string;
  help?:{
    /** Must confirm protection AND prepared episode persistence before resolving. */
    beforeHelp(signal:AbortSignal):Promise<Ticket>;
    /** No generation signal: cancellation must not suppress cleanup of an observed fact.
     * The host maps provided -> v3 presented and only performs monotonic writes. */
    confirmPresentation(ticket:Ticket,observation:LearningPresentationObservation):Promise<void>;
  };
};
export type LearningReplyGateOutcome={presentationId?:string;/** prepared means confirmed, never proof that a failed write did nothing. */prepared:boolean;preparation:"not-started"|"confirmed"|"unknown";state:"provided"|"unknown";confirmed:"provided"|"unknown"|"none";offeredChars:number};
export class LearningReplyGateError extends Error {
  constructor(readonly code:string,readonly outcome:LearningReplyGateOutcome){super(code);this.name=code==="learning-reply-cancelled"?"AbortError":"LearningReplyGateError";}
}
export const LEARNING_REPLY_GATE_LIMITS=Object.freeze({maxBufferedChars:48_000,maxChunkChars:2_048});
type Options<C,Ticket extends LearningHelpTicket>={
  signal:AbortSignal;
  presenter:LearningReplyPresenter;
  /** Pure routing only. Put any persistent work inside help.beforeHelp. */
  plan(control:C):LearningReplyPlan<Ticket>;
  maxBufferedChars?:number;
};

/** One gate per generated reply. Connect parser.onError to abort(), call the
 * parser's finish() first, then await this finish(). This gate never retries a
 * model, preparation, presentation, or failed confirmation. */
export class LearningReplyGate<C,Ticket extends LearningHelpTicket=LearningHelpTicket> {
  private plan?:LearningReplyPlan<Ticket>;
  private queue:string[]=[];
  private buffered=0;
  private offered=0;
  private hadText=false;
  private ticket?:Ticket;
  private preparationStarted=false;
  private observed:"provided"|"unknown"="unknown";
  private confirmed:"provided"|"unknown"|"none"="none";
  private errorCode?:string;
  private worker?:Promise<void>;
  private finishing=false;
  private finished=false;
  private completion?:Promise<LearningReplyGateOutcome>;
  private readonly maxBuffered:number;
  private readonly onAbort=()=>this.abort();
  constructor(private readonly options:Options<C,Ticket>){
    this.maxBuffered=options.maxBufferedChars??LEARNING_REPLY_GATE_LIMITS.maxBufferedChars;
    if(!Number.isInteger(this.maxBuffered)||this.maxBuffered<1||this.maxBuffered>LEARNING_REPLY_GATE_LIMITS.maxBufferedChars)throw new Error("learning-reply-buffer-limit-invalid");
    options.signal.addEventListener("abort",this.onAbort,{once:true});if(options.signal.aborted)this.abort();
  }
  status():LearningReplyGateOutcome{return {presentationId:this.plan?.presentationId,prepared:this.ticket!==undefined,preparation:this.ticket?"confirmed":this.preparationStarted?"unknown":"not-started",state:this.observed,confirmed:this.confirmed,offeredChars:this.offered};}
  private reject(code:string):never{this.stop(code);throw new LearningReplyGateError(this.errorCode!,this.status());}
  private stop(code:string):void{this.errorCode??=code;this.queue=[];this.buffered=0;}
  abort(_reason?:unknown):void{if(!this.finished)this.stop(this.options.signal.aborted?"learning-reply-cancelled":"learning-reply-aborted");}
  acceptControl(control:C):void {
    if(this.errorCode)this.reject(this.errorCode);
    if(this.plan||this.finishing)this.reject("learning-reply-control-repeated");
    let plan:LearningReplyPlan<Ticket>;try{plan=this.options.plan(control);}catch{this.reject("learning-reply-plan-rejected");}
    if(!["stream","buffer","suppress"].includes(plan.mode)||typeof plan.presentationId!=="string"||!plan.presentationId||plan.presentationId.length>200||
      plan.help&&(typeof plan.help.beforeHelp!=="function"||typeof plan.help.confirmPresentation!=="function"))this.reject("learning-reply-plan-invalid");
    this.plan=plan;
  }
  enqueue(delta:string):void {
    if(this.errorCode)this.reject(this.errorCode);
    if(!this.plan)this.reject("learning-reply-control-required");
    if(this.finishing)this.reject("learning-reply-already-finishing");
    if(typeof delta!=="string")this.reject("learning-reply-delta-invalid");
    if(!delta||this.plan.mode==="suppress")return;
    if(this.buffered+delta.length>this.maxBuffered)this.reject("learning-reply-buffer-exceeded");
    this.hadText=true;this.buffered+=delta.length;
    // Coalesce tiny transport chunks; both stored characters and queue nodes are bounded.
    for(let offset=0;offset<delta.length;){const last=this.queue.length-1,room=last<0?0:LEARNING_REPLY_GATE_LIMITS.maxChunkChars-this.queue[last]!.length;
      if(room>0){const part=delta.slice(offset,offset+room);this.queue[last]+=part;offset+=part.length;}
      else{const part=delta.slice(offset,offset+LEARNING_REPLY_GATE_LIMITS.maxChunkChars);this.queue.push(part);offset+=part.length;}}
    if(this.plan.mode==="stream")this.kick();
  }
  private kick():void {
    if(this.worker||this.errorCode||!this.queue.length)return;
    const run=Promise.resolve().then(()=>this.drain()).catch(()=>{this.stop(this.errorCode??"learning-reply-unavailable");});
    this.worker=run.finally(()=>{this.worker=undefined;if(this.queue.length&&!this.errorCode&&(this.finishing||this.plan?.mode==="stream"))this.kick();});
  }
  private async confirm(observation:LearningPresentationObservation):Promise<void>{
    if(observation.state==="provided")this.observed="provided";
    if(!this.ticket||!this.plan?.help||this.confirmed==="provided"||this.confirmed===observation.state)return;
    try{await this.plan.help.confirmPresentation(this.ticket,observation);this.confirmed=observation.state;}
    catch{this.stop("learning-reply-confirmation-not-confirmed");throw new Error("learning-reply-confirmation-not-confirmed");}
  }
  private observation(value:LearningPresentationObservation|void):LearningPresentationObservation {
    if(value===undefined)return {state:"unknown",presentationId:this.plan!.presentationId};
    if(!value||value.presentationId!==this.plan!.presentationId||!["provided","unknown"].includes(value.state)){
      this.stop("learning-reply-presentation-identity-mismatch");return {state:"unknown",presentationId:this.plan!.presentationId};
    }
    return value;
  }
  private async drain():Promise<void>{
    const plan=this.plan!;
    if(this.errorCode)return;
    if(plan.help&&!this.ticket){
      this.preparationStarted=true;
      let ticket:Ticket;try{ticket=await plan.help.beforeHelp(this.options.signal);}catch{this.stop(this.options.signal.aborted?"learning-reply-cancelled":"learning-reply-preparation-not-confirmed");return;}
      if(!ticket||ticket.presentationId!==plan.presentationId){this.stop("learning-reply-prepared-identity-mismatch");return;}
      this.ticket=ticket;
    }
    if(this.errorCode||this.options.signal.aborted){if(this.options.signal.aborted)this.abort();await this.confirm({state:"unknown",presentationId:plan.presentationId});return;}
    while(this.queue.length&&!this.errorCode){
      const text=this.queue.shift()!;let receipt:LearningPresentationObservation|void;
      try{this.offered+=text.length;receipt=await this.options.presenter.present({text,presentationId:plan.presentationId,signal:this.options.signal});}
      catch{this.stop("learning-reply-presentation-failed");await this.confirm({state:"unknown",presentationId:plan.presentationId});return;}
      this.buffered=Math.max(0,this.buffered-text.length);
      await this.confirm(this.observation(receipt));
      if(this.options.signal.aborted)this.abort();
    }
  }
  finish():Promise<LearningReplyGateOutcome>{
    if(this.completion)return this.completion;
    this.finishing=true;
    this.completion=(async()=>{
      try{
        if(!this.plan)this.stop("learning-reply-control-required");
        this.kick();while(this.worker)await this.worker;
        if(!this.errorCode&&this.hadText&&this.options.presenter.complete){
          let receipt:LearningPresentationObservation|void=undefined,completed=false;
          try{receipt=await this.options.presenter.complete({presentationId:this.plan!.presentationId,signal:this.options.signal});completed=true;}
          catch{this.stop("learning-reply-presentation-failed");await this.confirm({state:"unknown",presentationId:this.plan!.presentationId});}
          if(completed)await this.confirm(this.observation(receipt));
        }
        if(this.errorCode)throw new LearningReplyGateError(this.errorCode,this.status());
        return this.status();
      }catch(error){if(error instanceof LearningReplyGateError)throw error;throw new LearningReplyGateError(this.errorCode??"learning-reply-unavailable",this.status());}
      finally{this.finished=true;this.options.signal.removeEventListener("abort",this.onAbort);this.queue=[];this.buffered=0;}
    })();
    return this.completion;
  }
}
