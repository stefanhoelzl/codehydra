/**
 * Configuration value utilities and type aliases.
 *
 * Config key definitions are owned by individual modules and registered
 * via the "register-config" hook in app:start. This file provides shared
 * utilities for config key name derivation and help text generation.
 *
 * Naming conventions:
 *   Config key / CLI flag:  dot-separated, kebab-case  (e.g. "version.code-server")
 *   Env var:                CH_ prefix, . → __, - → _, UPPER  (e.g. CH_VERSION__CODE_SERVER)
 */

import type { ConfigKeyDefinition } from "./config-definition";

// =============================================================================
// Type Aliases
// =============================================================================

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 */
export type ConfigAgentType = "claude" | "opencode" | null;

/**
 * Auto-update behavior preference.
 * "always" = skip choice, show progress, download, restart.
 * "ask" = show choice overlay, user decides (default).
 * "never" = skip auto-update entirely.
 */
export type AutoUpdatePreference = "always" | "ask" | "never";

// =============================================================================
// Name Derivation
// =============================================================================

/**
 * Convert an env var name to a config key (or undefined if not a CH_ var).
 * Rules: strip CH_, lowercase, __ → ., _ → -.
 */
export function envVarToConfigKey(envVar: string): string | undefined {
  if (!envVar.startsWith("CH_")) return undefined;
  return envVar.slice(3).toLowerCase().replace(/__/g, ".").replace(/_/g, "-");
}

// =============================================================================
// Help Text
// =============================================================================

/**
 * Generate a human-readable config usage guide.
 *
 * `definitions` provides the set of registered config keys.
 * `defaults` should be the effective default values (accounting for
 * isDevelopment, isPackaged, etc.) so users see the actual defaults
 * that apply to their environment.
 */
export function generateHelpText(
  configFilePath: string,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
  defaults: Readonly<Record<string, unknown>>
): string {
  const lines: string[] = [
    "CodeHydra Configuration",
    "=======================",
    "",
    "Every key can be set three ways (highest precedence first):",
    "  CLI flag:   --<key>=<value>        e.g. --log.level=debug",
    "  Env var:    CH_ prefix, . → __, - → _, UPPER  e.g. CH_LOG__LEVEL=debug",
    "  Config file: " + configFilePath,
    "",
    "Keys:",
    "",
  ];

  for (const [key, def] of definitions) {
    const value = defaults[key];
    const valueStr = value === null || value === undefined ? "—" : String(value);

    let line = `  ${key.padEnd(38)} default: ${valueStr}`;
    if (def.validValues) {
      line += `  [${def.validValues}]`;
    }
    if (def.description) {
      line += `  — ${def.description}`;
    }
    lines.push(line);
  }

  lines.push("");
  return lines.join("\n");
}
