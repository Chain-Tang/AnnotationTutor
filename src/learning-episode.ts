import { z } from "zod";

export const conceptIds = ["value-limit", "one-sided", "neighborhood", "removable", "jump", "continuity"] as const;
export type ConceptId = typeof conceptIds[number];
export type MathQuestion = { id: string; prompt: string; answer: string; explanation: string; kind: "number" | "choice"; choices?: string[] };
export type MathLesson = { id: ConceptId; title: string; goal: string; explanation: string; hint: string; prerequisite?: ConceptId; question: MathQuestion; transfer: MathQuestion; exploration: string; diagram: string };
/** Authored, versioned Chinese adult curriculum. Answers never come from a model. */
export const LIMITS_PACK_VERSION = "limits-zh-CN-1";
export const limitsLessons: MathLesson[] = [
  { id:"value-limit", title:"函数值与极限", goal:"区分某一点的值与附近的趋向。", explanation:"极限描述 x 靠近某点时 f(x) 的趋势。改变孤立一点的函数值，不一定改变极限。", hint:"先算附近 x² 的趋势，再看单独规定的 f(2)。", question:{id:"value-1",prompt:"当 x≠2 时 f(x)=x²，另规定 f(2)=7。x→2 时 f(x) 的极限是多少？",kind:"number",answer:"4",explanation:"附近的 x² 趋向 4；f(2)=7 不改变极限。"}, transfer:{id:"value-2",prompt:"当 x≠3 时 g(x)=2x+1，g(3)=0。x→3 时极限是多少？",kind:"number",answer:"7",explanation:"附近的 2x+1 趋向 7。"}, exploration:"是否能让函数在一点无定义，同时极限存在？",diagram:"请绘制函数在 x=2 的极限示意：x≠2 时 f(x)=x²，f(2)=7。用数学图协议统一计算，曲线在 (2,4) 空心，(2,7) 实心，显示范围 x:[0,4],y:[0,9]。" },
  { id:"one-sided", title:"左右极限", prerequisite:"value-limit", goal:"用两侧趋向判断极限是否存在。", explanation:"有限的双侧极限存在，要求左右极限存在且相等。", hint:"分别从负数和正数一侧靠近 0。", question:{id:"sides-1",prompt:"f(x)=−1（x<0），f(x)=1（x≥0）。x→0 的双侧极限存在吗？",kind:"choice",choices:["存在，等于 0","存在，等于 1","不存在"],answer:"不存在",explanation:"左极限 −1，右极限 1，不相等。"}, transfer:{id:"sides-2",prompt:"g(x)=x+2（x<0），g(x)=2−x（x≥0）。x→0 时极限是多少？",kind:"number",answer:"2",explanation:"两侧都趋向 2。"}, exploration:"两侧趋近速度不同，极限还能相等吗？",diagram:"使用数学图协议绘制分段函数 f(x)=-1(x<0), f(x)=1(x>=0)，在 0 处显示左右极限，不连接跳跃处，范围 x:[-2,2],y:[-2,2]。" },
  { id:"neighborhood", title:"邻域直观", prerequisite:"value-limit", goal:"把接近转成可检查的误差范围。", explanation:"对于 f(x)=2x，当 |x−1|<δ 时，|f(x)−2|<2δ。选择 δ 可以控制输出误差。", hint:"输出误差是输入误差的两倍。", question:{id:"near-1",prompt:"若 f(x)=2x，为使 |f(x)−2|<0.1，可选的最大 δ（满足 |x−1|<δ）是多少？",kind:"number",answer:"0.05",explanation:"2δ=0.1，所以 δ=0.05。"}, transfer:{id:"near-2",prompt:"若 g(x)=3x，要使 |g(x)−6|<0.3，可选的最大 δ（满足 |x−2|<δ）是多少？",kind:"number",answer:"0.1",explanation:"3δ=0.3。"}, exploration:"对 x² 能直接沿用固定倍数吗？",diagram:"使用数学图协议绘制 y=2x 在 x=1 的邻域图。范围 x:[0.8,1.2],y:[1.6,2.4]；标示 x=0.95,1.05 对应 y=1.9,2.1，所有坐标由统一变换计算。" },
  { id:"removable", title:"可去间断", prerequisite:"one-sided", goal:"通过补一个函数值使函数连续。", explanation:"(x²−1)/(x−1) 在 x≠1 时等于 x+1。虽然原式在 1 无定义，极限仍是 2。", hint:"把 x²−1 分解成 (x−1)(x+1)。", question:{id:"hole-1",prompt:"要让 f(x)=(x²−1)/(x−1) 连续延拓到 x=1，应补 f(1)=多少？",kind:"number",answer:"2",explanation:"补上极限值 2。"}, transfer:{id:"hole-2",prompt:"要把 g(x)=(x²−4)/(x−2) 连续延拓到 x=2，应补多少？",kind:"number",answer:"4",explanation:"附近等于 x+2，趋向 4。"}, exploration:"sin(x)/x 在 0 也可以连续延拓吗？",diagram:"使用数学图协议绘制 (x²-1)/(x-1)，x=1 无定义，标明极限 2 和空心点；范围 x:[-1,3],y:[-1,5]，不要在空点补实心。" },
  { id:"jump", title:"跳跃间断", prerequisite:"one-sided", goal:"识别改一个点也无法修补的间断。", explanation:"如果左右极限不同，修改该点的函数值无法让两侧趋势相等。", hint:"函数值只能改一个点，两边的趋势不会变。", question:{id:"jump-1",prompt:"f(x)=0（x<1），f(x)=2（x≥1）。只改 f(1) 能使它在 1 连续吗？",kind:"choice",choices:["能","不能"],answer:"不能",explanation:"左右极限分别是 0 和 2。"}, transfer:{id:"jump-2",prompt:"g(x)=x（x<0），g(x)=x+3（x≥0）。左右极限之差（右减左）是多少？",kind:"number",answer:"3",explanation:"右极限 3，左极限 0。"}, exploration:"跳跃与无穷间断（如 1/x）有什么区别？",diagram:"使用数学图协议画分段函数 y=x(x<0),y=x+3(x>=0)，在 0 处断开，标明左右极限 0 和 3。" },
  { id:"continuity", title:"连续性", prerequisite:"removable", goal:"同时核对定义、极限与函数值。", explanation:"在 a 连续要求 f(a) 有定义、极限存在，且极限等于 f(a)。", hint:"检查三个条件，特别注意极限是否等于该点的值。", question:{id:"cont-1",prompt:"x≠0 时 f(x)=sin(x)/x，f(0)=0。它在 0 连续吗？",kind:"choice",choices:["连续","不连续"],answer:"不连续",explanation:"极限是 1，却与 f(0)=0 不相等。"}, transfer:{id:"cont-2",prompt:"x≠0 时 g(x)=(exp(x)−1)/x。使它在 0 连续应规定 g(0)=多少？",kind:"number",answer:"1",explanation:"极限为 1，补上该值即可。"}, exploration:"连续是否意味着可导？试想 |x|。",diagram:"使用数学图协议对比 sin(x)/x 在 0 的空心极限点 (0,1) 与 f(0)=0 的实心点，范围 x:[-3,3],y:[-0.3,1.3]。" },
];
export const lessonFor = (id: ConceptId) => limitsLessons.find(l=>l.id===id)!;
export const evidenceSchema = z.object({id:z.string().uuid(),at:z.string().datetime(),questionId:z.string(),packVersion:z.literal(LIMITS_PACK_VERSION),kind:z.enum(["self-report","hinted","independent","delayed","transfer","explanation"]),answer:z.string().max(12000),hintCount:z.number().int().min(0),evaluator:z.enum(["deterministic","tutor","learner"]),outcome:z.enum(["correct","incorrect","unreviewed"]),feedback:z.string().max(16000),corrects:z.string().uuid().optional()});
export type LearningEvidence = z.infer<typeof evidenceSchema>;
export const episodeSchema = z.object({format:z.literal(1),id:z.string().uuid(),revision:z.number().int().nonnegative(),source:z.object({path:z.string(),version:z.string(),annotationId:z.string().optional()}),concept:z.enum(conceptIds),packVersion:z.literal(LIMITS_PACK_VERSION),status:z.enum(["active","paused","completed"]),stage:z.enum(["attempt","transfer","reflect","delayed"]),hintCount:z.number().int().min(0),evidence:z.array(evidenceSchema).max(500),reflection:z.string().max(12000),reviewDue:z.string().datetime().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),links:z.array(z.object({kind:z.enum(["drawing","expert","memory"]),id:z.string(),targetId:z.string().optional()})).max(100)});
export type LearningEpisode = z.infer<typeof episodeSchema>;
export function createEpisode(source:LearningEpisode["source"],concept:ConceptId):LearningEpisode{const now=new Date().toISOString();return {format:1,id:crypto.randomUUID(),revision:0,source,concept,packVersion:LIMITS_PACK_VERSION,status:"active",stage:"attempt",hintCount:0,evidence:[],reflection:"",links:[],createdAt:now,updatedAt:now};}
export function gradeMathAnswer(question:MathQuestion,answer:string):boolean{
  const normalized=answer.trim().replaceAll("−","-");
  if(question.kind==="choice")return normalized===question.answer;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))return false;
  return Number.isFinite(Number(normalized))&&Math.abs(Number(normalized)-Number(question.answer))<=1e-8*Math.max(1,Math.abs(Number(question.answer)));
}
export function recordAttempt(episode:LearningEpisode,answer:string,now=new Date()):LearningEpisode{
  if(episode.status!=="active" || episode.stage==="reflect")throw new Error("episode-not-answering");
  if(episode.stage==="delayed" && (!episode.reviewDue || episode.reviewDue>now.toISOString()))throw new Error("delayed-check-not-due");
  const next=structuredClone(episode),lesson=lessonFor(next.concept),question=next.stage==="attempt"?lesson.question:lesson.transfer;
  const correct=gradeMathAnswer(question,answer);
  const kind=next.hintCount>0?"hinted":next.stage==="delayed"?"delayed":next.stage==="transfer"?"transfer":"independent";
  next.evidence.push({id:crypto.randomUUID(),at:now.toISOString(),questionId:question.id,packVersion:LIMITS_PACK_VERSION,kind,answer,hintCount:next.hintCount,evaluator:"deterministic",outcome:correct?"correct":"incorrect",feedback:question.explanation});
  // Seeing the feedback counts as help on any retry of the same question.
  if(correct){next.stage=next.stage==="attempt"?"transfer":"reflect";next.hintCount=0;}else next.hintCount++;
  return next;
}
export function evidenceSummary(episode:LearningEpisode){
  const corrected=new Set(episode.evidence.map(e=>e.corrects).filter(Boolean));
  const relevant=episode.evidence.filter(e=>!corrected.has(e.id));
  return {independent:relevant.filter(e=>e.evaluator==="deterministic"&&e.outcome==="correct"&&e.hintCount===0&&e.kind==="independent").length,transfer:relevant.filter(e=>e.evaluator==="deterministic"&&e.outcome==="correct"&&e.hintCount===0&&e.kind==="transfer").length,delayed:relevant.filter(e=>e.evaluator==="deterministic"&&e.outcome==="correct"&&e.hintCount===0&&e.kind==="delayed").length,hinted:relevant.filter(e=>e.kind==="hinted").length};
}
export function learningAgenda(episodes:LearningEpisode[],minutes=20,now=new Date()){
  let remaining=Math.max(5,Math.min(180,Math.round(minutes)));
  const due=episodes.filter(e=>e.reviewDue&&e.reviewDue<=now.toISOString());
  const items:Array<{type:"review"|"concept";id:string;minutes:number}>=[],deferred:string[]=[];
  for(const episode of due){if(remaining>=5){items.push({type:"review",id:episode.id,minutes:5});remaining-=5;}else deferred.push(episode.id);}
  const next=limitsLessons.find(l=>!episodes.some(e=>e.concept===l.id&&e.status==="completed"));
  if(next){if(remaining>=10){items.push({type:"concept",id:next.id,minutes:10});remaining-=10;}else deferred.push(next.id);}
  return {items,deferred,remaining,prerequisite:next?.prerequisite,exploration:next?.exploration};
}
