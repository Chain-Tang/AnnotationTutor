import type { LearningContextQuery, LearningContextSnapshot } from "./learning-context.js";

export type LearningScopeChange = { recordId?: string; sources: readonly string[]; unknownScope: boolean; requestId?: string };
export function learningScopeAffected(query: LearningContextQuery, change: LearningScopeChange): boolean {
  if (!query.source && !query.episodeId && !query.annotationId && !query.concept) return false;
  if (change.unknownScope) return true;
  if (query.allowedSources && !change.sources.some(source => query.allowedSources!.includes(source))) return false;
  if (query.episodeId && change.recordId) return query.episodeId === change.recordId;
  if (query.source) return change.sources.includes(query.source);
  return !!query.episodeId || !!query.annotationId || !!query.concept;
}

function readScopes(query: LearningContextQuery, snapshot?: LearningContextSnapshot): LearningContextQuery[] {
  const copy={...query,...(query.allowedSources?{allowedSources:[...query.allowedSources]}:{})};
  if(query.episodeId){
    const episode=snapshot?.episodes.find(episode=>episode.id===query.episodeId);
    return [{...copy,...(episode?{source:episode.source}:{})}];
  }
  return [copy,...(snapshot?.episodes??[]).map(episode=>({episodeId:episode.id,source:episode.source,allowedSources:copy.allowedSources}))];
}

/** References actually sent to one persistent model session, cleared when that session is replaced. */
export class LearningSessionReferences {
  private scopes:LearningContextQuery[]=[];
  remember(query:LearningContextQuery,snapshot:LearningContextSnapshot):void{
    if(!snapshot.summary)return;
    const known=new Set(this.scopes.map(scope=>JSON.stringify(scope)));
    for(const scope of readScopes(query,snapshot))if(!known.has(JSON.stringify(scope)))this.scopes.push(scope);
  }
  affected(change:LearningScopeChange):boolean{return this.scopes.some(scope=>learningScopeAffected(scope,change));}
  clear():void{this.scopes=[];}
}

/** Cancels only readers whose authorized evidence scope has changed. No prose is retained. */
export class LearningInvalidation {
  private readers = new Map<symbol, { scopes: LearningContextQuery[]; invalidate: () => void; requestId?:string }>();
  track(query: LearningContextQuery, invalidate: () => void, options:{snapshot?:LearningContextSnapshot;requestId?:string}={}): () => void {
    const id = Symbol();
    this.readers.set(id, { scopes:readScopes(query,options.snapshot), invalidate, requestId:options.requestId });
    return () => { this.readers.delete(id); };
  }
  changed(change: LearningScopeChange): void {
    for (const [id, reader] of this.readers) if ((!change.requestId || change.requestId!==reader.requestId) && reader.scopes.some(scope=>learningScopeAffected(scope,change))) {
      this.readers.delete(id);
      reader.invalidate();
    }
  }
  clear(): void { this.readers.clear(); }
}
