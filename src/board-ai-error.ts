export type BoardAiError = {
  kind: "quota" | "auth" | "rate-limit" | "network" | "service" | "unknown";
  title: string;
  message: string;
  requestId?: string;
};

/** Convert provider failures into safe, actionable copy for the creation panel. */
export function describeBoardAiError(error: unknown): BoardAiError {
  const raw = error instanceof Error ? error.message : String(error);
  const status = /(?:http[-\s:]?|status[-\s:]?)(401|402|403|429|5\d\d)\b/i.exec(raw)?.[1];
  const requestId = /request[_ -]?id\s*[:=]\s*([a-z\d-]{8,64})/i.exec(raw)?.[1];
  const diagnostic = requestId ? { requestId } : {};
  if (status === "402" || /insufficient[\s_-]*balance|余额不足|额度不足|quota exhausted/i.test(raw))
    return { kind: "quota", title: "模型服务额度不足", message: "画板和原作品没有改变。请检查当前模型服务的余额或额度，也可以在设置中改用其他已配置的模型。", ...diagnostic };
  if (status === "401" || status === "403" || /invalid[\s_-]*(?:api[\s_-]*)?key|unauthorized/i.test(raw))
    return { kind: "auth", title: "模型连接未获授权", message: "画板和原作品没有改变。请检查 API Key、模型权限和服务地址。", ...diagnostic };
  if (status === "429" || /rate[\s_-]*limit|too many requests/i.test(raw))
    return { kind: "rate-limit", title: "请求过于频繁", message: "画板和原作品没有改变。请稍后重试，或检查模型服务的速率限制。", ...diagnostic };
  if (status && status.startsWith("5"))
    return { kind: "service", title: "模型服务暂时不可用", message: "画板和原作品没有改变。请稍后重试，或切换已配置的模型。", ...diagnostic };
  if (/timeout|timed out|network|fetch failed|econn|enotfound|api-(?:secure-)?connection-failed|api-transport-failed|连接失败|超时/i.test(raw))
    return { kind: "network", title: "无法连接模型服务", message: "画板和原作品没有改变。请检查网络和服务地址后重试。", ...diagnostic };
  return { kind: "unknown", title: "这次共画未完成", message: "画板和原作品没有改变。可重试一次；如果仍失败，请检查模型设置。", ...diagnostic };
}
