import { ConversationTransportError, conversationFailureCode } from "./conversation-diagnostics.js";

/** No raw model, transport or provider error is written into annotation files. */
export function annotationReplyFailureCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "annotation-request-cancelled";
  const category = error instanceof ConversationTransportError ? error.category
    : conversationFailureCode({ok:false,text:"",error:error instanceof Error ? error.message : ""});
  return category === "unknown" || category === "none" ? "annotation-reply-failed" : `annotation-reply-${category}`;
}

export function annotationReplyFailureMessage(code?: string): string {
  switch (code) {
    case "annotation-reply-connection": return "连接中断，问题已保存，可重试。";
    case "annotation-reply-timeout": return "回复超时，问题已保存，可重试。";
    case "annotation-reply-protocol": return "回复格式不完整，问题已保存，可重试。";
    case "annotation-reply-incomplete": return "回复传输未完成，问题已保存，可重试。";
    case "annotation-reply-output-limit": return "回复达到长度限制，问题已保存，可重试或缩小问题范围。";
    case "annotation-reply-access": return "模型服务拒绝访问，问题已保存，请检查模型与账号设置后重试。";
    case "annotation-reply-rate-limit": return "模型服务请求过于频繁，问题已保存，请稍后重试。";
    case "annotation-reply-provider": return "模型服务暂时不可用，问题已保存，请稍后重试。";
    case "annotation-reply-configuration": return "模型连接设置不完整，问题已保存，请检查设置后重试。";
    case "annotation-reply-cancelled":
    case "annotation-request-cancelled": return "已取消，问题已保存，可重试。";
    case "annotation-reply-no-output": return "未收到回复内容，问题已保存，可重试。";
    default: return /^annotation-(?:parent|source|branch|context)/.test(code ?? "")
      ? "关联内容已变化或缺失。问题已保存，请更新关联后重新发送。" : "回复未完成，问题已保存，可重试。";
  }
}
