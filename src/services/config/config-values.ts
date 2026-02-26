/**
 * Schema-driven configuration values.
 *
 * Every config key is defined once in the CONFIG object with its default
 * value and string parser. The TypeScript type, defaults, and key set
 * are all derived mechanically — no hand-written interface to maintain.
 *
 * Naming conventions:
 *   Config key / CLI flag:  dot-separated, kebab-case  (e.g. "version.code-server")
 *   Env var:                CH_ prefix, . → __, - → _, UPPER  (e.g. CH_VERSION__CODE_SERVER)
 */

import type { LogLevel } from "../logging/types";
import { parseLogLevel } from "../logging/electron-log-service";

// =============================================================================
// Schema Helpers
// =============================================================================

interface ConfigKeyDef<T> {
  readonly default: T;
  readonly parse: (raw: string) => T | undefined; // undefined = invalid
}

function key<T>(def: ConfigKeyDef<T>): ConfigKeyDef<T> {
  return def;
}

// =============================================================================
// Config Schema
// =============================================================================

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 */
export type ConfigAgentType = "claude" | "opencode" | null;

/**
 * The single source of truth for all configuration keys.
 *
 * File-layer keys (persisted to config.json):
 *   agent, version.*, telemetry.*
 *
 * Override-layer keys (env vars / CLI flags, runtime-only):
 *   log.*, electron.*
 */
export const CONFIG = {
  agent: key<ConfigAgentType>({
    default: null,
    parse: (s) => (s === "claude" || s === "opencode" ? s : s === "" ? null : undefined),
  }),
  "version.claude": key<string | null>({
    default: null,
    parse: (s) => (s === "" ? null : s),
  }),
  "version.opencode": key<string | null>({
    default: null,
    parse: (s) => (s === "" ? null : s),
  }),
  "version.code-server": key<string>({
    default: "4.107.0",
    parse: (s) => (s.length > 0 ? s : undefined),
  }),
  "telemetry.enabled": key<boolean>({
    default: true,
    parse: (s) =>
      s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : undefined,
  }),
  "telemetry.distinct-id": key<string | undefined>({
    default: undefined,
    parse: (s) => (s === "" ? undefined : s),
  }),
  "log.level": key<LogLevel>({
    default: "warn",
    parse: parseLogLevel,
  }),
  "log.console": key<boolean>({
    default: false,
    parse: (s) =>
      s === "true" || s === "1" ? true : s === "false" || s === "0" ? false : undefined,
  }),
  "log.filter": key<string | undefined>({
    default: undefined,
    parse: (s) => (s === "" ? undefined : s),
  }),
  "electron.flags": key<string | undefined>({
    default: undefined,
    parse: (s) => (s === "" ? undefined : s),
  }),
} as const satisfies Record<string, ConfigKeyDef<unknown>>;

// =============================================================================
// Derived Types
// =============================================================================

export type ConfigKey = keyof typeof CONFIG;

export type ConfigValues = {
  readonly [K in ConfigKey]: (typeof CONFIG)[K] extends ConfigKeyDef<infer T> ? T : never;
};

/**
 * Set of all valid config keys, derived from the schema.
 */
export const CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set(Object.keys(CONFIG) as ConfigKey[]);

/**
 * Keys that are persisted to config.json (file layer).
 */
export const FILE_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "agent",
  "version.claude",
  "version.opencode",
  "version.code-server",
  "telemetry.enabled",
  "telemetry.distinct-id",
]);

/**
 * Default configuration values, derived from the schema.
 */
export const DEFAULT_CONFIG_VALUES: Readonly<ConfigValues> = Object.fromEntries(
  (Object.keys(CONFIG) as ConfigKey[]).map((k) => [k, CONFIG[k].default])
) as ConfigValues;

// =============================================================================
// Name Derivation
// =============================================================================

/**
 * Convert a config key to its env var name.
 * Rules: CH_ prefix, . → __, - → _, UPPERCASE.
 */
export function configKeyToEnvVar(key: ConfigKey): string {
  return "CH_" + key.replace(/\./g, "__").replace(/-/g, "_").toUpperCase();
}

/**
 * Convert an env var name to a config key (or undefined if not a CH_ var).
 * Rules: strip CH_, lowercase, __ → ., _ → -.
 */
export function envVarToConfigKey(envVar: string): string | undefined {
  if (!envVar.startsWith("CH_")) return undefined;
  return envVar.slice(3).toLowerCase().replace(/__/g, ".").replace(/_/g, "-");
}

/**
 * Parse a raw string value for a given config key using the schema's parser.
 * Returns undefined if the key is unknown or the value is invalid.
 */
export function parseConfigValue(key: ConfigKey, raw: string): ConfigValues[ConfigKey] | undefined {
  const def = CONFIG[key];
  if (!def) return undefined;
  return def.parse(raw) as ConfigValues[ConfigKey] | undefined;
}
