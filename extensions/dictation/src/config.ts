import * as vscode from "vscode";

/**
 * Dictation configuration
 */
export interface DictationConfig {
  provider: "auto" | "assemblyai";
  assemblyaiApiKey: string;
  maxDuration: number;
}

/**
 * Get the current dictation configuration
 */
export function getConfig(): DictationConfig {
  const config = vscode.workspace.getConfiguration("codehydra.dictation");

  return {
    provider: config.get<"auto" | "assemblyai">("provider", "auto"),
    assemblyaiApiKey: config.get<string>("assemblyai.apiKey", ""),
    maxDuration: config.get<number>("maxDuration", 60),
  };
}

/**
 * Check if dictation is configured (has an API key)
 */
export function isConfigured(): boolean {
  const config = getConfig();
  return Boolean(config.assemblyaiApiKey);
}
