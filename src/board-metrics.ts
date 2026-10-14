/** Bounded local timings only: no stroke samples, screenshots or model content. */
export class BoardRenderMetrics {
  private readonly samples:{ms:number;cold:boolean}[]=[];
  record(ms:number,cold:boolean):void{if(!Number.isFinite(ms)||ms<0)return;this.samples.push({ms,cold});if(this.samples.length>240)this.samples.shift();}
  clear():void{this.samples.length=0;}
  snapshot(){const summary=(cold:boolean)=>{const values=this.samples.filter(s=>s.cold===cold).map(s=>s.ms).sort((a,b)=>a-b);return {count:values.length,p95:values[Math.max(0,Math.ceil(values.length*.95)-1)]??null,max:values.at(-1)??null};};return {cold:summary(true),warm:summary(false),unit:'ms',scope:'application-render-time'};}
}
