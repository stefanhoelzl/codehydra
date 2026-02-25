/**
 * Typed configuration values for the application.
 *
 * Unifies file-persisted config (agent, versions, telemetry) and
 * environment-variable config (logging, electron flags) into a single
 * flat key-value interface. The config module owns parsing, validation,
 * and merging of these two layers.
 */

import type { LogLevel } from "../logging/types";

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 */
export type ConfigAgentType = "claude" | "opencode" | null;

/**
 * All configuration values in a flat key-value format.
 *
 * File-layer keys (persisted to config.json):
 *   agent, versions.*, telemetry.*
 *
 * Env-layer keys (read from process.env, runtime-only):
 *   log.*, electron.*
 */
export interface ConfigValues {
  /** Selected AI agent (null = not yet selected, triggers selection dialog) */
  readonly agent: ConfigAgentType;
  /** Claude agent version (null = prefer system, download latest if needed) */
  readonly "versions.claude": string | null;
  /** OpenCode agent version (null = prefer system, download latest if needed) */
  readonly "versions.opencode": string | null;
  /** code-server version (pinned, always download exact version) */
  readonly "versions.codeServer": string;
  /** Whether telemetry is enabled. Default: true */
  readonly "telemetry.enabled": boolean;
  /** Anonymous user ID for PostHog. undefined = not yet generated. */
  readonly "telemetry.distinctId": string | undefined;
  /** Log level (from CODEHYDRA_LOGLEVEL) */
  readonly "log.level": LogLevel;
  /** Whether to print logs to console (from CODEHYDRA_PRINT_LOGS) */
  readonly "log.console": boolean;
  /** Comma-separated logger name filter (from CODEHYDRA_LOGGER) */
  readonly "log.filter": string | undefined;
  /** Electron command-line flags (from CODEHYDRA_ELECTRON_FLAGS) */
  readonly "electron.flags": string | undefined;
}

/**
 * Keys that are persisted to config.json (file layer).
 */
export const FILE_LAYER_KEYS: ReadonlySet<keyof ConfigValues> = new Set([
  "agent",
  "versions.claude",
  "versions.opencode",
  "versions.codeServer",
  "telemetry.enabled",
  "telemetry.distinctId",
]);

/**
 * Keys that come from environment variables (env layer).
 */
export const ENV_LAYER_KEYS: ReadonlySet<keyof ConfigValues> = new Set([
  "log.level",
  "log.console",
  "log.filter",
  "electron.flags",
]);

/**
 * Default configuration values for first-run.
 * Agent is null to trigger the selection dialog.
 * Log level defaults are applied by the config module based on isDevelopment.
 */
export const DEFAULT_CONFIG_VALUES: Readonly<ConfigValues> = {
  agent: null,
  "versions.claude": null,
  "versions.opencode": null,
  "versions.codeServer": "4.107.0",
  "telemetry.enabled": true,
  "telemetry.distinctId": undefined,
  "log.level": "warn",
  "log.console": false,
  "log.filter": undefined,
  "electron.flags": undefined,
};
