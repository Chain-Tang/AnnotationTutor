export type TextTarget = { content: string; start: number; end: number; original: string };
export function captureTextTarget(content: string, start: number, end: number): TextTarget {
  return {content,start,end,original:content.slice(start,end)};
}
/** Only map ranges outside the entire possible change span; repeated text can
 * make the change location ambiguous even when a longest prefix matches. */
export function resolveTextTarget(target: TextTarget, current: string, allowInsertion = false): { start:number; end:number } | null {
  if (!Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < 0 || target.end < target.start || target.end > target.content.length || target.content.slice(target.start,target.end) !== target.original) return null;
  if (!target.original && !allowInsertion) return null;
  if (current === target.content) return { start:target.start,end:target.end };
  let prefix=0; while(prefix<current.length && prefix<target.content.length && current[prefix]===target.content[prefix]) prefix++;
  let suffix=0; while(suffix<current.length && suffix<target.content.length && current[current.length-1-suffix]===target.content[target.content.length-1-suffix]) suffix++;
  const safePrefix = Math.min(prefix, target.content.length-suffix, current.length-suffix);
  const safeSuffixStart = Math.max(target.content.length-suffix, prefix+Math.max(0,target.content.length-current.length));
  // An insertion at the edge of a concurrent edit has no reliable side without
  // a CodeMirror transaction map. Preserve the proposal instead of guessing.
  const before = target.original ? target.end<=safePrefix : target.start<safePrefix;
  const after = target.original ? target.start>=safeSuffixStart : target.start>safeSuffixStart;
  const start = before ? target.start : after ? target.start+current.length-target.content.length : -1;
  return start>=0 && current.slice(start,start+target.original.length)===target.original ? {start,end:start+target.original.length} : null;
}
export function uniqueTextTarget(content:string,text:string):TextTarget|null {
  if (!text) return null;
  const start=content.indexOf(text);
  return start>=0 && content.indexOf(text,start+1)<0 ? captureTextTarget(content,start,start+text.length) : null;
}
