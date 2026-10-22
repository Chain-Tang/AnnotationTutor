import type { AnnotationTutorLiteSettings, ReviewEngine } from "./settings-config.js";

export type BoardConnection = { engine: ReviewEngine; model: string; mode: "inherit" | "custom" };
/** The only model-selection rule for board drawing, recognition and tools. */
export function resolveBoardConnection(settings: AnnotationTutorLiteSettings): BoardConnection {
  const mode = settings.boardConnectionMode === "custom" ? "custom" : "inherit";
  const engine = mode === "inherit" ? settings.chatEngine : settings.boardEngine;
  const model = engine === "api"
    ? (mode === "custom" ? settings.boardApiModel.trim() : "") || settings.apiModel.trim()
    : (mode === "custom" ? settings.boardAgentModel.trim() : "") || settings.agentModel.trim();
  return { engine, model, mode };
}

/** Private comparison key, never logged: credentials must invalidate sessions too. */
export function boardConnectionKey(settings: AnnotationTutorLiteSettings): string {
  const route = resolveBoardConnection(settings);
  return JSON.stringify([route, route.engine === "api"
    ? [settings.apiBaseUrl, settings.apiKey]
    : [settings.agentCommand, settings.agentShellPath, settings.mcpServersJson], settings.agentTimeoutSeconds]);
}
