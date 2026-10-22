/** Bounded incremental decoder for the host's ordered {control, reply} protocol.
 * Only the top-level reply string reaches onReply. This decoder never applies a
 * learning command; the host must validate finish() before committing commands. */
export type LearningStreamLimits={maxEnvelopeChars:number;maxControlChars:number;maxReplyChars:number;maxDepth:number};
export const LEARNING_STREAM_LIMITS:Readonly<LearningStreamLimits>=Object.freeze({maxEnvelopeChars:65_536,maxControlChars:8_192,maxReplyChars:48_000,maxDepth:32});
export type TeachingEnvelopeV3<C>={control:C;reply:string};
export type TeachingStreamV3Options<C>={
  validateControl(value:unknown):C;
  onControl(control:C):void;
  onReply(delta:string):void;
  /** Connect to gate.abort(); a malformed suffix cannot undo already provided help. */
  onError?(error:Error):void;
  controlKey?:"control"|"action";
  limits?:Partial<LearningStreamLimits>;
};
/** Only the pure schema adapter may mark structure or captured invitation availability as repairable.
 * Consumer/permission failures remain non-retryable even if their text matches. */
export const TEACHING_CONTROL_SCHEMA_ISSUES = ["shape", "action", "question-id", "invitation-id", "evidence-id", "reply-relation", "invitation-unavailable"] as const;
export class TeachingControlSchemaError extends Error {
  constructor(issue:typeof TEACHING_CONTROL_SCHEMA_ISSUES[number]) {
    super("teaching-control-schema-"+(TEACHING_CONTROL_SCHEMA_ISSUES.includes(issue)?issue:"shape"));
    this.name="TeachingControlSchemaError";
  }
}
type State="start"|"control-key"|"control-colon"|"control"|"comma"|"reply-key"|"reply-colon"|"reply-open"|"reply"|"close"|"done";
const whitespace=(c:string)=>c===" "||c==="\n"||c==="\r"||c==="\t";

/** JSON.parse accepts duplicate keys. Reject them before a host sees a candidate. */
function rejectDuplicateKeys(raw:string):void {
  let i=0;
  const ws=()=>{while(whitespace(raw[i]??""))i++;};
  const string=():string=>{const start=i++;let escaped=false;for(;i<raw.length;i++){const c=raw[i]!;if(escaped){escaped=false;continue;}if(c==="\\"){escaped=true;continue;}if(c==='"'){i++;return JSON.parse(raw.slice(start,i)) as string;}}throw new Error();};
  const value=():void=>{
    ws();const c=raw[i];
    if(c==='"'){string();return;}
    if(c==="{"){i++;ws();const keys=new Set<string>();if(raw[i]==="}"){i++;return;}
      for(;;){ws();const key=string();if(keys.has(key))throw new Error();keys.add(key);ws();i++;value();ws();if(raw[i++]==="}")return;}}
    if(c==="["){i++;ws();if(raw[i]==="]"){i++;return;}for(;;){value();ws();if(raw[i++]==="]")return;}}
    while(i<raw.length&&!/[,\]}\s]/.test(raw[i]!))i++;
  };
  value();
}

export class TeachingStreamV3<C> {
  private readonly limits:LearningStreamLimits;
  private state:State="start";
  private keyOffset=0;
  private controlRaw="";
  private closers:string[]=[];
  private inControlString=false;
  private controlEscape=false;
  private replyEscape:"none"|"escape"|"unicode"="none";
  private unicode="";
  private highSurrogate="";
  private rawChars=0;
  private decodedChars=0;
  private controlValue?:C;
  private failed?:Error;
  private finished=false;
  text="";
  received=false;
  constructor(private readonly options:TeachingStreamV3Options<C>){
    this.limits={...LEARNING_STREAM_LIMITS,...options.limits};
    for(const key of Object.keys(LEARNING_STREAM_LIMITS) as (keyof LearningStreamLimits)[]){const value=this.limits[key];if(!Number.isInteger(value)||value<1||value>LEARNING_STREAM_LIMITS[key])throw new Error("teaching-stream-limit-invalid");}
  }
  private fail(code:string):never {
    this.failed??=new Error(code);this.controlRaw="";this.closers=[];
    try{this.options.onError?.(this.failed);}catch{/* Consumers cannot turn malformed protocol into a valid command. */}
    throw this.failed;
  }
  push(delta:string):void {
    if(this.failed)throw this.failed;
    if(this.finished)this.fail("teaching-stream-already-finished");
    if(typeof delta!=="string")this.fail("teaching-stream-delta-invalid");
    this.received ||= delta.length>0;
    if(this.rawChars+delta.length>this.limits.maxEnvelopeChars)this.fail("teaching-envelope-too-large");
    this.rawChars+=delta.length;
    let addition="";
    const append=(unit:string)=>{
      const code=unit.charCodeAt(0);
      if(this.highSurrogate){if(code<0xdc00||code>0xdfff)this.fail("teaching-reply-unicode-invalid");unit=this.highSurrogate+unit;this.highSurrogate="";}
      else if(code>=0xd800&&code<=0xdbff){this.highSurrogate=unit;return;}
      else if(code>=0xdc00&&code<=0xdfff)this.fail("teaching-reply-unicode-invalid");
      if(this.decodedChars+unit.length>this.limits.maxReplyChars)this.fail("teaching-reply-too-large");
      this.decodedChars+=unit.length;addition+=unit;
    };
    for(const c of delta.split("")){
      if(this.state==="control"){
        if(!this.controlRaw.trim()&&!whitespace(c)&&c!=="{")this.fail("teaching-control-object-required");
        if(this.controlRaw.length>=this.limits.maxControlChars)this.fail("teaching-control-too-large");
        this.controlRaw+=c;
        if(this.inControlString){if(this.controlEscape)this.controlEscape=false;else if(c==="\\")this.controlEscape=true;else if(c==='"')this.inControlString=false;continue;}
        if(c==='"'){this.inControlString=true;continue;}
        if(c==="{"||c==="["){this.closers.push(c==="{"?"}":"]");if(this.closers.length>this.limits.maxDepth)this.fail("teaching-control-too-deep");continue;}
        if(c==="}"||c==="]"){
          if(this.closers.pop()!==c)this.fail("teaching-control-invalid");
          if(!this.closers.length){
            let candidate:unknown;try{candidate=JSON.parse(this.controlRaw);rejectDuplicateKeys(this.controlRaw);}catch{this.fail("teaching-control-invalid");}
            try{this.controlValue=this.options.validateControl(candidate);}
            catch(error){this.fail(error instanceof TeachingControlSchemaError?error.message:"teaching-control-rejected");}
            try{this.options.onControl(this.controlValue);}catch{this.fail("teaching-control-rejected");}
            this.controlRaw="";this.state="comma";
          }
        }
        continue;
      }
      if(this.state==="reply"){
        if(this.replyEscape==="unicode"){
          if(!/^[0-9a-f]$/i.test(c))this.fail("teaching-reply-escape-invalid");this.unicode+=c;
          if(this.unicode.length===4){append(String.fromCharCode(parseInt(this.unicode,16)));this.unicode="";this.replyEscape="none";}continue;
        }
        if(this.replyEscape==="escape"){
          if(c==="u"){this.replyEscape="unicode";continue;}
          const escapes:Record<string,string>={'"':'"',"\\":"\\","/":"/",b:"\b",f:"\f",n:"\n",r:"\r",t:"\t"};
          if(!(c in escapes))this.fail("teaching-reply-escape-invalid");append(escapes[c]!);this.replyEscape="none";continue;
        }
        if(c==='"'){if(this.highSurrogate)this.fail("teaching-reply-unicode-invalid");this.state="close";continue;}
        if(c==="\\"){this.replyEscape="escape";continue;}
        if(c.charCodeAt(0)<0x20)this.fail("teaching-reply-control-character");append(c);continue;
      }
      if(this.state==="control-key"||this.state==="reply-key"){
        if(this.keyOffset===0&&whitespace(c))continue;
        const key=this.state==="control-key"?JSON.stringify(this.options.controlKey??"control"):'"reply"';
        if(c!==key[this.keyOffset++])this.fail("teaching-envelope-key-invalid");
        if(this.keyOffset===key.length){this.keyOffset=0;this.state=this.state==="control-key"?"control-colon":"reply-colon";}continue;
      }
      if(whitespace(c))continue;
      switch(this.state){
        case "start":if(c!=="{")this.fail("teaching-envelope-invalid");this.state="control-key";break;
        case "control-colon":if(c!==":")this.fail("teaching-envelope-invalid");this.state="control";this.controlRaw="";break;
        case "comma":if(c!==",")this.fail("teaching-envelope-invalid");this.state="reply-key";break;
        case "reply-colon":if(c!==":")this.fail("teaching-envelope-invalid");this.state="reply-open";break;
        case "reply-open":if(c!=='"')this.fail("teaching-reply-string-required");this.state="reply";break;
        case "close":if(c!=="}")this.fail("teaching-envelope-extra-field");this.state="done";break;
        case "done":this.fail("teaching-envelope-trailing-content");
      }
    }
    if(addition){this.text+=addition;try{this.options.onReply(addition);}catch{this.fail("teaching-reply-consumer-unavailable");}}
  }
  finish():TeachingEnvelopeV3<C>{
    if(this.failed)throw this.failed;
    if(this.state!=="done")this.fail("teaching-envelope-incomplete");
    this.finished=true;return {control:this.controlValue as C,reply:this.text};
  }
}
