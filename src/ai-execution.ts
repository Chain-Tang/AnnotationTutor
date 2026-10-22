import type { ReviewEngine } from "./settings-config.js";

export type AIExecutionFailure = {
  stage: "connection" | "generation" | "validation";
  engine: ReviewEngine;
  model: string;
  category: "access" | "rate-limit" | "provider" | "no-output" | "connection" | "output-limit" | "validation" | "cancelled";
  code: string;
  status?: number;
  retryable: boolean;
  recovery: "connection" | "retry" | "revise" | "none";
};
export class AIExecutionError extends Error {
  constructor(message: string, public readonly failure: AIExecutionFailure) { super(message); }
}
export function executionFailure(engine: ReviewEngine, model: string, error: string, code = "request-failed", status?: number): AIExecutionFailure {
  const raw = `${code} ${error}`;
  status ??= Number(raw.match(/(?:provider-access|provider-rate-limit|http)-(\d{3})/)?.[1]) || undefined;
  const category: AIExecutionFailure["category"] = /cancelled|disposed/.test(code) ? "cancelled"
    : code === "invalid-response" ? "validation"
    : status === 401 || status === 403 || /provider-access|free tier can only|free-tier-restricted|unauthorized|forbidden|authentication|invalid.api.key/i.test(raw) ? "access"
    : status === 429 || /rate.limit|quota|insufficient.*credit/i.test(raw) ? "rate-limit"
    : /provider-no-output|empty-drawing-response/.test(raw) ? "no-output"
    : /incomplete-response: (?:length|max_tokens)/.test(raw) ? "output-limit"
    : /provider-error/.test(raw) || (status !== undefined && status >= 500) ? "provider"
    : /invalid-response|incomplete-drawing-json|unfinished-drawing-path/.test(raw) ? "validation"
    : "connection";
  return {engine,model,category,code,status,stage:category === "validation" ? "validation" : category === "access" || category === "connection" ? "connection" : "generation",
    retryable:!["access","cancelled"].includes(category),
    recovery:category === "access" || category === "no-output" ? "connection" : category === "cancelled" ? "none" : category === "validation" || category === "output-limit" ? "revise" : "retry"};
}

export type DrawingDiagnostic = {
  requestId: string; engine: ReviewEngine; model: string; elapsedMs: number;
  outputChars: number; finishReason?: string; status?: number; operationCount: number;
  ok: boolean; code?: string; category?: AIExecutionFailure["category"];
};
const attempts: DrawingDiagnostic[] = [];
export function recordDrawingDiagnostic(value: DrawingDiagnostic): void {
  attempts.push({...value}); if (attempts.length > 50) attempts.shift();
}
/** No prompt, note path, screenshot, response content, headers or credentials. */
export function drawingDiagnostics(): readonly DrawingDiagnostic[] { return attempts.map(value=>({...value})); }

/** One child process, one active prompt. Only classified error codes survive. */
export class AcpTurnDiagnostics {
  private pending = "";
  private sessionId: string | null = null;
  private failure: string | undefined;
  private startedAt = 0;
  begin(sessionId: string): void { this.startedAt=Date.now();this.pending="";this.failure=undefined;this.sessionId=sessionId; }
  end(): void { this.sessionId=null;this.pending="";this.failure=undefined; }
  push(chunk: string): void {
    if (!this.sessionId) return;
    this.pending=(this.pending+chunk).slice(-8192);
    const lines=this.pending.split(/\r?\n/);this.pending=lines.pop()??"";
    for (const line of lines) {
      const timestamp = line.match(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/)?.[0];
      if (timestamp && Date.parse(timestamp) < this.startedAt - 1000) continue;
      if (!/level=ERROR|"level"\s*:\s*"error"/i.test(line)) continue;
      const session=line.match(/session(?:\.id|ID|Id)[=:]\s*"?([\w-]+)/)?.[1];
      if (session !== this.sessionId) continue;
      if (/free tier can only|unauthorized|forbidden|authentication|status(?:Code)?[=: ]+["']?(?:401|403)/i.test(line)) this.failure=/403|free tier can only/i.test(line)?"provider-access-403":/401/.test(line)?"provider-access-401":"provider-access";
      else if (/quota|rate.limit|status(?:Code)?[=: ]+["']?429/i.test(line)) this.failure="provider-rate-limit-429";
      else if (/stream error|AI_APICallError|provider/i.test(line)) this.failure="provider-error";
    }
  }
  current(): string | undefined { return this.failure; }
}
