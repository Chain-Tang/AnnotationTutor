import { z } from "zod";
import { type ConceptId, type LearningEpisode } from "./learning-episode.js";
import type { EpisodeV2 } from "./learning-v2.js";
import { type EpisodeV3 } from "./learning-v3.js";
import { effectiveLearningV3, projectedEvidenceV3 } from "./learning-effective-v3.js";
import type { ProtectionSnapshot } from "./learning-protection.js";
export type LearningContextRecord=LearningEpisode|EpisodeV2|EpisodeV3;
import { contextVersion } from "./teaching-policy.js";
import { completeRecordReadResult, type RecordReadResult, type RecordIntegrityIssue } from "./learning-record-read.js";
import { safeLegacyEvidence } from "./learning-safe-projection.js";
export type LearningContextQuery = { episodeId?: string; annotationId?: string; source?: string; concept?: ConceptId; allowedSources?: readonly string[] };
export const learningContextSchema = z.object({ version: z.literal(1), revision: z.string(),
  episodes: z.array(z.object({id:z.string(),format:z.number(),revision:z.number(),source:z.string(),concept:z.string(),evidenceIds:z.array(z.string())})).max(3),
  summary: z.string().max(2000), completeness:z.enum(["complete","partial","unavailable"]).optional(),
  integrityIssues:z.array(z.object({issueId:z.string(),category:z.string(),recovered:z.boolean()})).max(100).optional() });
export type LearningContextSnapshot = z.infer<typeof learningContextSchema>;
/** No chat logs, support stores or inferred psychological traits enter this allowlisted projection. */
export function learningContext(input: readonly LearningContextRecord[] | RecordReadResult<LearningContextRecord>, query: LearningContextQuery,
  protectionByEpisode?: ReadonlyMap<string, ProtectionSnapshot>): LearningContextSnapshot {
  const read:RecordReadResult<LearningContextRecord> = "records" in input ? input : completeRecordReadResult(input);
  const records=read.records;
  const permitted = records.filter(e => e.status !== "deleted" && (!query.allowedSources || query.allowedSources.includes(e.source.path)));
  const matches = (e: LearningContextRecord) => query.episodeId ? e.id === query.episodeId : query.annotationId ? e.source.annotationId === query.annotationId : query.source ? e.source.path === query.source && (!query.concept || e.concept === query.concept) : query.concept ? e.concept === query.concept : false;
  // An annotation with no own episode can share the document's single, explicit
  // learning target. Never guess when the document has multiple candidates.
  let matched = permitted.filter(matches);
  if (!matched.length && query.annotationId && !query.episodeId && query.source) {
    const scoped = permitted.filter(e => e.source.path === query.source);
    const continued = new Set(scoped.flatMap(e => e.format !== 1 && e.legacy ? [e.legacy.id] : []));
    const candidates = scoped.filter(e => !continued.has(e.id));
    if (candidates.length === 1) matched = candidates;
  }
  if(!query.episodeId){const continued=new Set(permitted.flatMap(record=>record.format!==1&&record.legacy?[record.legacy.id]:[]));matched=matched.filter(record=>!continued.has(record.id));}
  const selected = matched.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,3);
  const issues=read.integrityIssues.filter(issue=>!issue.recovered&&learningIssueMatches(issue,query));
  const completeness=issues.length?(selected.length?"partial":"unavailable"):"complete";
  const episodes = selected.map(e => ({ id:e.id,format:e.format,revision:e.revision,source:e.source.path,concept:e.concept,
    evidenceIds:(e.format===3?projectedEvidenceV3(e,protectionByEpisode?.get(e.id)):safeLegacyEvidence(e)).slice(-3).map(x=>x.id) }));
  const lines = selected.map((e, i) => {
    const attempts = (e.format===3?safeV3Evidence(e,protectionByEpisode?.get(e.id)):safeLegacyEvidence(e)).slice(-3);
    return JSON.stringify({ ...episodes[i],source: e.source.path.slice(0,120),evidenceIds:undefined, attempts,status:e.status,reviewDue:e.format===3?effectiveLearningV3(e,protectionByEpisode?.get(e.id)).reviewTasks.find(task=>task.state==="scheduled")?.dueAt??null:e.reviewDue??null,
      ...(e.format!==1 && e.legacy ? {legacy:e.legacy.id} : {}) });
  });
  // Build whole valid lines instead of truncating structured evidence midway.
  let summary = "学习证据（不等于完整掌握；未使用插件提示也不等于无其他帮助）。纠正记录须重新验证；旧 SM-2 是自评调度。";
  for (const line of lines) if (summary.length + line.length + 1 <= 2000) summary += "\n" + line;
  if (!selected.length) summary = "";
  if(completeness!=="complete"){
    const warning="相关学习记录暂不完整，不能据此认为学习者从未学过或补编记忆。本次解释可继续，无法可靠关联的进度暂未保存。";
    summary=warning+(summary&&warning.length+summary.length+1<=2000?"\n"+summary:"");
  }
  const integrityIssues=issues.slice(0,100).map(({issueId,category,recovered})=>({issueId,category,recovered}));
  return learningContextSchema.parse({version:1,revision:contextVersion(JSON.stringify({selected,protection:selected.filter(e=>e.format===3).map(e=>[e.id,protectionByEpisode?.get(e.id)?.revision??"unknown"]),issues:issues.map(({issueId,category})=>({issueId,category}))})),episodes,summary,completeness,integrityIssues});
}

/** Scope integrity warnings like evidence. Unknown-source damage is uncertainty, never proof of no history. */
export function learningIssueMatches(issue:RecordIntegrityIssue,query:LearningContextQuery):boolean{
  if(!query.episodeId&&!query.annotationId&&!query.source&&!query.concept)return false;
  if(query.allowedSources&&issue.scope&&!query.allowedSources.includes(issue.scope.source))return false;
  if(query.episodeId)return !issue.recordId||issue.recordId===query.episodeId;
  if(query.source&&issue.scope&&issue.scope.source!==query.source)return false;
  if(query.concept&&issue.scope?.concept&&issue.scope.concept!==query.concept)return false;
  if(query.annotationId&&!query.source&&issue.scope?.annotationId&&issue.scope.annotationId!==query.annotationId)return false;
  return true;
}

/** v3 contains no free prose; question wording is still regenerated from the
 * pinned bank, so imported or tampered prompt strings cannot enter context. */
export function safeV3Evidence(record:EpisodeV3,protection?:ProtectionSnapshot){return projectedEvidenceV3(record,protection);}
