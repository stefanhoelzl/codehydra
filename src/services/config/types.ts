/**
 * Configuration types for the application.
 *
 * The config.json file stores user preferences and version configuration.
 * This is loaded at startup to determine which agent to use.
 */

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 */
export type ConfigAgentType = "claude" | "opencode" | null;

/**
 * Version configuration for binaries.
 * null means use system binary or download latest.
 * A version string means use that exact version.
 */
export interface VersionConfig {
  /** Claude agent version (null = prefer system, download latest if needed) */
  readonly claude: string | null;
  /** OpenCode agent version (null = prefer system, download latest if needed) */
  readonly opencode: string | null;
  /** code-server version (pinned, always download exact version) */
  readonly codeServer: string;
}

/**
 * Telemetry configuration.
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled. Default: true */
  readonly enabled: boolean;
  /** Anonymous user ID for PostHog. Generated on first launch. */
  readonly distinctId?: string;
}

/**
 * Application configuration stored in config.json.
 */
export interface AppConfig {
  /** Selected AI agent (null = not yet selected, triggers selection dialog) */
  readonly agent: ConfigAgentType;
  /** Binary version configuration */
  readonly versions: VersionConfig;
  /** Telemetry configuration. Optional for backwards compatibility. */
  readonly telemetry?: TelemetryConfig;
}

/**
 * Default application configuration for first-run.
 * Agent is null to trigger the selection dialog.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  agent: null,
  versions: {
    claude: null,
    opencode: null,
    codeServer: "4.107.0",
  },
  telemetry: {
    enabled: true,
  },
};
