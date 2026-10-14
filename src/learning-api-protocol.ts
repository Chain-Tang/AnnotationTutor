import { z } from "zod";
import type { ChatStreamOptions, StructuredReplyTool } from "./api-stream.js";
import { learningControlV3Schema } from "./learning-control-v3.js";
import { supportControlSchema } from "./support-response.js";

/** A return channel, never an executable model tool. The existing learning
 * runner still validates permissions, bindings, completion and presentation. */
const envelope = z.object({ control: learningControlV3Schema, reply: z.string().max(48_000) }).strict();
const tool: StructuredReplyTool = {
  name: "submit_teaching_reply",
  description: "Return one teaching decision and learner-facing reply. Follow the current Host state and learning instructions. Arguments must be the ordered JSON envelope: control first, reply second. This submits a proposal, not a file operation or a claim of saved progress. The host validates and applies permitted actions. Do not emit a separate assistant message.",
  parameters: z.toJSONSchema(envelope, { target: "draft-7" }),
};
const supportTool:StructuredReplyTool={name:"submit_tutor_reply",description:"Return one ephemeral response decision and reply in the ordered envelope control then reply. This channel cannot save records or execute tools. Follow the supplied support decision instructions. Do not emit separate prose.",parameters:z.toJSONSchema(z.object({control:supportControlSchema,reply:z.string().max(48_000)}).strict(),{target:"draft-7"})};

/** Enable named tool choice only on the documented, configured endpoint and
 * models. No beta endpoint, provider switch, capability guess or fallback. */
export function supportsLearningReplyTool(baseUrl: string, model: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port &&
      !url.username && !url.password && !url.search && !url.hash && ["/", "/v1", "/v1/"].includes(url.pathname) &&
      ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model.trim().toLowerCase());
  } catch { return false; }
}

export function learningApiProtocol(baseUrl: string, model: string, enabled: boolean,kind:"learning"|"support"="learning"): {
  format: "text" | "json_object" | "reply_tool";
  options: Pick<ChatStreamOptions, "responseFormat" | "structuredReply">;
} {
  if (!enabled) return { format: "text", options: {} };
  if (supportsLearningReplyTool(baseUrl, model)) return { format: "reply_tool", options: { structuredReply: kind==="support"?supportTool:tool } };
  return { format: "json_object", options: { responseFormat: { type: "json_object" } } };
}
