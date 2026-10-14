import { t } from "./i18n.js";

/** A provider refusal is not a transient transport failure. Keep its code for
 * diagnostics without automatically retrying or rewriting the user's prompt. */
export class ImageContentRefusal extends Error {
  readonly retryable = false;
  constructor(readonly reason: "ip" | "content", readonly providerCode: string) {
    super(t(reason === "ip" ? "board.imageIpRefused" : "board.imageContentRefused"));
    this.name = "ImageContentRefusal";
  }
}

export function imageProviderError(status: number, error?: { code?: string; message?: string }): Error {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (/ipinfringement/i.test(code) || /\bIP infringement\b/i.test(message))
    return new ImageContentRefusal("ip", code);
  if (/DataInspectionFailed|DataInappropriate|content_policy_violation|safety_violations|CustomRoleBlocked/i.test(code))
    return new ImageContentRefusal("content", code);
  return new Error(message || code || `image-provider-http-${status}`);
}
