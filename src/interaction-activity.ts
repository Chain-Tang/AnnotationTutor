/** Counts active local work without recording content, timing histories or user behavior. */
const active = new Set<symbol>();
export function beginTutorActivity():()=>void{const token=Symbol();active.add(token);return()=>active.delete(token);}
export function tutorActivityBusy():boolean{return active.size>0;}
