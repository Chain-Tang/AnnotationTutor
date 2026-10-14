import type { BoardInk, BoardObject } from "./board-types.js";
/** Full canonical identity comparison, used before showing and before saving recognition. */
export function inkSelectionFingerprint(objects:readonly BoardObject[],ink:BoardInk):string{
  return JSON.stringify([...objects].sort((a,b)=>a.id.localeCompare(b.id)).map(object=>({object,stroke:object.inkId?ink[object.inkId]:null})));
}
export function isCurrentInkSelection(ids:readonly string[],fingerprint:string,objects:readonly BoardObject[],ink:BoardInk):boolean{
  const selected=objects.filter(object=>ids.includes(object.id));return selected.length===ids.length && inkSelectionFingerprint(selected,ink)===fingerprint;
}
