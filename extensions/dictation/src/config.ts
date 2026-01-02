import * as vscode from "vscode";

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Dictation configuration
 */
export interface DictationConfig {
  provider: "auto" | "assemblyai";
  assemblyaiApiKey: string;
  assemblyaiConnectionTimeout: number;
  autoStopDelay: number;
  listeningDelay: number;
  autoSubmit: boolean;
}

/**
 * Get the current dictation configuration
 */
export function getConfig(): DictationConfig {
  const config = vscode.workspace.getConfiguration("codehydra.dictation");

  return {
    provider: config.get<"auto" | "assemblyai">("provider", "auto"),
    assemblyaiApiKey: config.get<string>("assemblyai.apiKey", ""),
    assemblyaiConnectionTimeout: clamp(
      config.get<number>("assemblyai.connectionTimeout", 2000),
      1000,
      10000
    ),
    autoStopDelay: clamp(config.get<number>("autoStopDelay", 5), 3, 60),
    listeningDelay: clamp(config.get<number>("listeningDelay", 300), 100, 1000),
    autoSubmit: config.get<boolean>("autoSubmit", true),
  };
}

/**
 * Check if dictation is configured (has an API key)
 */
export function isConfigured(): boolean {
  const config = getConfig();
  return Boolean(config.assemblyaiApiKey);
}
