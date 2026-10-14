import { permitsLearningControl, type LearningTurnIdentity } from "./learning-control-v3.js";
import type { SupportStorageContext } from "./support-response.js";

/** A serialized client/source label cannot prove a local persistence path. */
export function resolveSupportStorageContext(identity:LearningTurnIdentity|undefined,persistChatLog:boolean):SupportStorageContext {
  if(!identity||!permitsLearningControl(identity))return {surface:"unknown"};
  if(identity.entry==="annotation")return {surface:"annotation"};
  return {surface:"chat",chatLog:persistChatLog?"enabled":"disabled"};
}
