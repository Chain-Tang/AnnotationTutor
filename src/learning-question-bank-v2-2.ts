import type { ConceptId } from "./learning-episode.js";
import { questionInstanceSchema, type QuestionInstance } from "./learning-v2.js";
import { mathPlotSchema, type MathPlotSpec } from "./board-math.js";

/** Frozen limits-v2-2 curriculum, also the renderer for limits-v3-1 references.
 * Do not revise these templates, parameters or goals in place. A changed bank
 * needs a new pack and renderer; the full parameter digest fixture pins this one. */
export const LIMITS_V2_2_PACK = "limits-v2-2" as const;
const conceptIds = ["value-limit", "one-sided", "neighborhood", "removable", "jump", "continuity"] as const;
const goals:Readonly<Record<ConceptId,string>>=Object.freeze({
  "value-limit":"区分某一点的值与附近的趋向。",
  "one-sided":"用两侧趋向判断极限是否存在。",
  neighborhood:"把接近转成可检查的误差范围。",
  removable:"通过补一个函数值使函数连续。",
  jump:"识别改一个点也无法修补的间断。",
  continuity:"同时核对定义、极限与函数值。",
});

type Content=Pick<QuestionInstance,"prompt"|"kind"|"answer"|"explanation"|"hint"> & {choices?:string[];math?:MathPlotSpec};
type Template={id:string;concept:ConceptId;pool:QuestionInstance["pool"];variant:number;make:(a:number,b:number)=>Content};
const n=(prompt:string,answer:number,explanation:string,hint:string,math?:MathPlotSpec):Content=>({prompt,kind:"number",answer:String(Number(answer.toPrecision(10))),explanation,hint,...(math?{math}:{})});
const choice=(prompt:string,answer:string,explanation:string,hint:string,choices:string[]):Content=>({prompt,kind:"choice",answer,explanation,hint,choices});
const linePlot=(expression:string,at:number,value:number,actual?:number):MathPlotSpec=>mathPlotSchema.parse({version:1,xRange:[at-2,at+2],yRange:[Math.min(0,value-12,actual??value),Math.max(1,value+12,actual??value)],curves:[{id:"f",expression,excludedX:actual===undefined?[]:[at],valueAt:actual===undefined?[]:[{x:at,y:actual}]}],limits:[{curveId:"f",at,value}]});
const poolNames=["practice","transfer","delayed"] as const;
/** Nine independently authored problems per concept: practice, a new representation, and an unseen delayed pool. */
const builders:Record<ConceptId,Array<(a:number,b:number)=>Content>>={
  "value-limit":[
    (a,b)=>n(`x≠${a} 时 f(x)=x²，f(${a})=${a*a+b}。求 x→${a} 时的极限。`,a*a,`附近的 x² 趋向 ${a*a}，孤立点的值不改变趋势。`,"分别看附近公式和单独规定的值。",linePlot("x^2",a,a*a,a*a+b)),
    (a,b)=>n(`x≠${a} 时 f(x)=${b}x+1，f(${a})=0。f(${a}) 的函数值是多少？`,0,"函数值按单独定义取 0；本题没有问极限。","注意问的是该点的值，而不是附近趋势。",linePlot(`${b}*x+1`,a,b*a+1,0)),
    (a,b)=>n(`f(x)=x+${b}，但在 x=${a} 处未定义。求 x→${a} 的极限。`,a+b,`附近的线性函数趋向 ${a+b}。`,"极限不要求该点有定义。"),
    (a,b)=>n(`传感器在 t≠${a} 时显示 T(t)=${b}t；t=${a} 的单次读数误写为 0。附近读数趋向多少？`,a*b,`误写的一次读数不改变附近的 ${b}t 趋势。`,"忽略孤立的异常读数，使用附近规律。"),
    (a,b)=>choice(`图上曲线在 (${a},${b}) 有空心圆，同一横坐标的实心点是 (${a},${b+2})，两侧曲线都接近空心圆。极限与函数值相等吗？`,"不相等","空心圆给出附近趋向，实心点给出实际取值，两者不同。","分别读出空心圆和实心点。",["相等","不相等"]),
    (a,b)=>n(`令 u=x−${a}。u≠0 时 h(u)=u²+${b}，h(0)=−1。求 u→0 时 h(u)。`,b,`u² 趋向 0，所以趋向 ${b}。`,"换字母不改变极限的含义。"),
    (a,b)=>n(`不看旧题：x≠${a} 时 p(x)=${b}−x，p(${a})=99。求 x→${a} 的极限。`,b-a,`附近表达式 ${b}−x 趋向 ${b-a}。`,"把孤立点定义和附近公式分开。"),
    (a,b)=>n(`p 在 x=${a} 附近趋向 ${b}，另有 p(${a})=${b+3}。p(${a}) 等于多少？`,b+3,"函数值由明确给出的点定义决定。","先确认这次问函数值还是极限。"),
    (a,b)=>n(`x≠${a} 时 r(x)=(${b}+x)/2，r(${a}) 未定义。求极限。`,(a+b)/2,`线性式趋向 ${(a+b)/2}，缺少该点不影响极限。`,"看附近的表达式。"),
  ],
  "one-sided":[
    (a,b)=>choice(`在 x=${a} 处左极限为 ${b}，右极限为 ${b+1}。有限双侧极限存在吗？`,"不存在","左右极限不同。","双侧极限要求两侧相等。",["存在","不存在"]),
    (a,b)=>n(`x<${a} 时 f(x)=x+${b}，x≥${a} 时 f(x)=${2*a+b}−x。求 x→${a} 的极限。`,a+b,`左右两侧都趋向 ${a+b}。`,"分别把趋近位置代入两侧公式。"),
    (a,b)=>n(`x<0 时 f(x)=${a}x+${b}，x≥0 时 f(x)=x−${a}。求 x→0⁻ 的极限。`,b,"只用 x<0 的公式，线性项趋向 0。","注意负号指从左侧趋近。"),
    (a,b)=>n(`两个方向靠近某温度分界点，传感器都趋向 ${a+b} 度，但变化速率不同。共同极限是多少？`,a+b,"趋近速率不同不影响两侧具有同一极限。","比较最终趋势，而不是速率。"),
    (a,b)=>choice(`图上从左侧趋向 y=${a}、右侧趋向 y=${b+a}，该点实心标记在 y=0。双侧极限是否存在？`,"不存在","左右趋势不同，实心点的位置不能改变它。","先比较左右，再看函数值。",["存在","不存在"]),
    (a,b)=>n(`令 u=x−${a}。u<0 时 y=${b}−u，u>0 时 y=${b}+u²。u→0 时 y 趋向多少？`,b,`两侧都趋向 ${b}。`,"换变量后分别令 u 靠近 0。"),
    (a,b)=>n(`新题：x<${a} 时 f(x)=${b}，x>${a} 时 f(x)=${b+2}。右极限是多少？`,b+2,"右侧使用 x 大于分界点的那一段。","只选右侧公式。"),
    (_a,b)=>choice(`左极限和右极限都为 ${b}，但该点没有定义。双侧极限存在吗？`,"存在","两侧同趋向一个有限值，不要求该点有定义。","区分极限存在与函数值存在。",["存在","不存在"]),
    (a,b)=>n(`x<0 时 f(x)=${a}x+${b}；x>0 时 f(x)=c−x。要使 0 处双侧极限存在，c 是多少？`,b,"右极限 c 必须等于左极限。","令左右极限相等。"),
  ],
  "neighborhood":[
    (a,b)=>n(`f(x)=${b}x，要让 |f(x)−${a*b}|<${b/10}，|x−${a}|<δ 的最大 δ 是多少？`,.1,"输出误差等于斜率绝对值乘输入误差。","用允许的输出误差除以斜率。"),
    (a,b)=>n(`f(x)=−${b}x，|x−${a}|<0.2。|f(x)−f(${a})| 的最紧上界是多少？`,b*.2,"误差放大倍数为斜率绝对值。","负斜率取绝对值。"),
    (a,b)=>n(`f(x)=${b}x+${a}，要求相对 f(0) 的误差小于 0.5。最大 δ 是多少？`,.5/b,"常数项在相减时抵消。","只保留变化率乘 |x|。"),
    (_a,b)=>n(`一台线性仪器把输入误差放大 ${b} 倍，允许输出误差 <${b/5}。输入误差应小于多少？`,.2,"容许输入误差等于输出容许误差除以倍数。","从输出容许误差倒推。"),
    (a,b)=>n(`图中 y=${b}x，输出带宽半宽为 ${b/4}。以 x=${a} 为中心的输入邻域半宽最多是多少？`,.25,"半宽按相同的线性比例换算。","不要把全宽当作半宽。"),
    (_a,b)=>choice(`f(x)=${b}x，要求输出误差 <${b/10}。选择 δ=0.01 是否足够？`,"足够","0.01 比最大允许输入误差 0.1 更小。","δ 可以小于最大可选值。",["足够","不够"]),
    (a,b)=>n(`新题：g(x)=−${b+1}x+${a}，允许输出误差 <${(b+1)/20}。最大 δ 是多少？`,.05,"用正的误差放大倍数求 δ。","常数抵消，斜率取绝对值。"),
    (a,b)=>n(`|x−${a}|<0.03，g(x)=${b}x−2。输出误差 |g(x)−g(${a})| 的最紧上界是多少？`,b*.03,"线性误差按斜率绝对值缩放。","把输入半宽乘以放大倍数。"),
    (_a,b)=>choice(`如果 δ=${1/b} 可以保证所需输出误差，那么把 δ 减半仍能保证吗？`,"能","更小邻域是原邻域的子集。","想想新的输入范围是否扩大。",["能","不能"]),
  ],
  "removable":[
    (a,_b)=>n(`f(x)=(x²−${a*a})/(x−${a})，x≠${a}。连续延拓应补 f(${a})=多少？`,2*a,"约去公因子后是 x+a，极限为 2a。","先用平方差公式因式分解。"),
    (a,b)=>n(`x≠${a} 时 f(x)=${b}x+2。要补上缺失点使其连续，该点纵坐标是多少？`,a*b+2,"补点的值必须等于附近趋势。","将趋近位置代入线性式。"),
    (_a,b)=>choice(`某点的左右极限均为 ${b}，函数在该点无定义。这是可去间断吗？`,"是","有限极限存在，只缺少正确的点值。","能否只补一个点修复？",["是","不是"]),
    (a,b)=>n(`图上一条直线在 (${a},${b}) 留了空心圆。若两侧都接近该空心圆，填入多少纵坐标才能连续？`,b,"应把空洞按原曲线的趋势填上。","补的是纵坐标。"),
    (a,_b)=>n(`测量模型在 t≠${a} 时 H(t)=(t²−${a*a})/(t−${a})。缺失时间的连续预测值是多少？`,2*a,"约去公因子后附近等于 t+a。","分母为零时不能直接相除，先约简附近公式。"),
    (a,b)=>n(`先令 u=x−${a}，模型 y=sin(${b}u)/u（u≠0）。补 u=0 的连续值是多少？`,b,"sin(bu)/u=b·sin(bu)/(bu)，极限为 b。","用标准极限并保留放大倍数。"),
    (a,_b)=>n(`新题：f(x)=((x−${a})²)/(x−${a})，x≠${a}。应补多少？`,0,"附近等于 x−a，趋向 0。","只在去心邻域约去公因子。"),
    (_a,b)=>n(`x≠0 时 f(x)=(exp(${b}x)−1)/x。应补 f(0)=多少？`,b,"换元 u=bx，标准极限乘以 b。","注意换元后的系数。"),
    (_a,b)=>choice(`左右极限都为 ${b}，但点值是 ${b+1}。只改点值能使函数连续吗？`,"能","把点值改成有限双侧极限即可。","需要修复的是一点，而不是两侧趋势。",["能","不能"]),
  ],
  "jump":[
    (a,b)=>choice(`x<${a} 时 f(x)=0，x≥${a} 时 f(x)=${b}。仅改 f(${a}) 能连续吗？`,"不能","左右趋势不同，仅改一点无效。","比较左右极限。",["能","不能"]),
    (a,b)=>n(`分界点左极限为 ${a}，右极限为 ${a+b}。跳跃量（右减左）是多少？`,b,"跳跃量是两个有限单侧极限的差。","注意减法方向。"),
    (a,b)=>choice(`左极限 ${a}，右极限 ${a+b}，均有限但不同。这是哪类间断？`,"跳跃间断","两个有限单侧极限不相等。","区分有限跳跃与无穷发散。",["可去间断","跳跃间断","连续"]),
    (a,b)=>n(`阶梯收费在重量 ${a} 左边趋向 ${b} 元，右边趋向 ${b+3} 元。价格跳跃量是多少？`,3,"右价格减去左价格。","按左右趋势读数。"),
    (_a,_b)=>choice(`图中同一横坐标有两个不同高度的单侧端点。在中间高度补一个实心点能连接成连续函数吗？`,"不能","补点不能改变已经不同的左右极限。","中间点并不改变邻域行为。",["能","不能"]),
    (a,b)=>n(`温控开关两侧极限分别为 ${a+b} 和 ${a}。右减左的有符号跳跃量是多少？`,-b,"下降跳跃量为负，不能取成绝对值。","严格按右减左。"),
    (a,b)=>n(`新题：x<0 时 f(x)=x+${a}，x>0 时 f(x)=x−${b}。右减左是多少？`,-b-a,"左极限 a，右极限 −b。","分别算出两个单侧值再相减。"),
    (_a,_b)=>choice(`1/x 在 0 左右分别无界。它属于有限跳跃间断吗？`,"不属于","有限跳跃要求两侧极限都是有限数。","无穷发散和有限高度跳跃不同。",["属于","不属于"]),
    (a,b)=>choice(`某点左右极限均为 ${b}，只有点值变成 ${b+a}。这会产生跳跃间断吗？`,"不会","它是可去间断，改变点值不改变两侧趋势。","跳跃必须来自两侧。",["会","不会"]),
  ],
  "continuity":[
    (a,b)=>choice(`在 x=${a}，函数值为 ${b+1}，双侧极限为 ${b}。该点连续吗？`,"不连续","函数值与极限不相等。","连续性要求三项同时满足。",["连续","不连续"]),
    (_a,b)=>n(`x≠0 时 f(x)=sin(${b}x)/x，补 f(0)=c。连续时 c 是多少？`,b,"标准极限经换元后为 b。","保留内层系数。"),
    (a,_b)=>choice(`f(x)=|x−${a}|。它在 x=${a} 连续吗？`,"连续","函数值与两侧极限均为 0；尖角不破坏连续性。","连续不等于可导。",["连续","不连续"]),
    (a,b)=>n(`两段轨道高度为 x+${b}（x<${a}）和 c−x（x≥${a}）。要无高度断层，c 应为多少？`,2*a+b,"令 a+b=c−a。","接口处左右高度应相等。"),
    (_a,_b)=>choice(`温度在某时刻有测量值，且左右趋势一致。这些信息是否已经足够保证连续？`,"不够","还必须验证测量值等于共同极限。","一个条件仍未给出。",["足够","不够"]),
    (a,b)=>n(`图上 x=${a} 处空心点高 ${b}，实心点高 ${b+2}。把实心点移到哪个纵坐标可连续？`,b,"函数值必须等于曲线两侧的共同趋势。","调整的是点值。"),
    (_a,b)=>n(`新题：x≠0 时 g(x)=(exp(${b}x)−1)/x，g(0)=c。连续要求 c=多少？`,b,"标准指数极限换元后为 b。","不要漏掉 b。"),
    (a,_b)=>choice(`函数在 x=${a} 没有定义，但极限存在。这时能说它在该点已经连续吗？`,"不能","定义点值是连续的必要条件。","能够延拓不等于原函数已经连续。",["能","不能"]),
    (a,b)=>n(`x<${a} 时 f(x)=${b}x，x≥${a} 时 f(x)=x+c。连续要求 c 是多少？`,a*(b-1),"令 ba=a+c，得到 c=a(b−1)。","让两侧极限与右侧点值一致。"),
  ],
};
export const questionTemplates:readonly Readonly<Template>[]=Object.freeze(conceptIds.flatMap(concept=>poolNames.flatMap((pool,p)=>[0,1,2].map(variant=>Object.freeze({id:`${concept}-${pool}-${variant}`,concept,pool,variant,make:builders[concept][p*3+variant]!})))));
export function instantiateQuestion(concept:ConceptId,pool:QuestionInstance["pool"],seed=0):QuestionInstance {
  if(!Number.isSafeInteger(seed)||seed<0||seed>1e6)throw new Error("question-seed-out-of-range");
  const template=questionTemplates.find(t=>t.concept===concept&&t.pool===pool&&t.variant===seed%3)!;
  const a=3+Math.floor(seed/3)%5,b=2+Math.floor(seed/15)%5;
  return questionInstanceSchema.parse({id:crypto.randomUUID(),templateId:template.id,packVersion:LIMITS_V2_2_PACK,concept,pool,seed,parameters:{a,b},...template.make(a,b),
    rubric:[goals[concept],"指出所用的定义或关系，并检查适用条件。"],hintCount:0,answerShown:false});
}
/** Select a never-presented template/parameter combination; no randomized model code. */
export function nextQuestion(concept:ConceptId,pool:QuestionInstance["pool"],seen:readonly QuestionInstance[],start=0):QuestionInstance {
  for(let seed=start;seed<start+225;seed++){const q=instantiateQuestion(concept,pool,seed);if(!seen.some(x=>x.prompt===q.prompt || x.templateId===q.templateId&&JSON.stringify(x.parameters)===JSON.stringify(q.parameters)))return q;}
  throw new Error("question-pool-exhausted");
}
