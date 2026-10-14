import { z } from "zod";

/** Automatic evidence carries a bounded value or a host-authored choice ID,
 * never the surrounding utterance or an arbitrary model string. */
export const mathAnswerSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("number"),value:z.number().finite().min(-1e12).max(1e12)}).strict(),
  z.object({kind:z.literal("choice"),index:z.number().int().min(0).max(7)}).strict(),
]);
export type MathAnswer = z.infer<typeof mathAnswerSchema>;
export type AnswerQuestion = {kind:"number"|"choice"|"explanation";answer:string;choices?:readonly string[]};

/** Bare mathematical values only. Conversational extraction is a separate,
 * source-span checked step; this codec is also safe for projecting old files. */
export function parseMathValue(text:string):number|undefined {
  if(text.length>64)return;
  const value=text.trim().replaceAll("−","-");
  const fraction=/^([+-]?\d{1,10})\s*\/\s*([+-]?\d{1,10})$/.exec(value);
  let result:number;
  if(fraction){const a=Number(fraction[1]),b=Number(fraction[2]);if(Math.abs(a)>1e9||Math.abs(b)>1e9||!b)return;result=a/b;}
  else {
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d{1,3}))?$/i.test(value))return;
    const exponent=/e([+-]?\d+)$/i.exec(value);if(exponent&&Math.abs(Number(exponent[1]))>100)return;
    result=Number(value);
  }
  if(!Number.isFinite(result)||Math.abs(result)>1e12)return;
  return Object.is(result,-0)?0:result;
}
export function canonicalMathAnswer(question:AnswerQuestion,text:string):MathAnswer|undefined {
  if(question.kind==="number"){const value=parseMathValue(text);return value===undefined?undefined:{kind:"number",value};}
  if(question.kind==="choice"){const index=question.choices?.indexOf(text.trim())??-1;return index<0||index>7?undefined:{kind:"choice",index};}
}
export function gradeCanonicalAnswer(question:AnswerQuestion,answer:MathAnswer):boolean {
  if(question.kind==="number"&&answer.kind==="number"){
    const expected=parseMathValue(question.answer);
    return expected!==undefined&&Math.abs(answer.value-expected)<=1e-8*Math.max(1,Math.abs(expected));
  }
  return question.kind==="choice"&&answer.kind==="choice"&&question.choices?.[answer.index]===question.answer;
}
