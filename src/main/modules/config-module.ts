/**
 * ConfigModule - Manages application configuration via the intent dispatcher.
 *
 * Single merged config. Precedence is handled by dispatch order:
 * - before-ready: defaults + computed defaults + env vars + CLI args
 * - init: file values merged in (only changed values dispatched)
 * - set: external callers merge values; persist=true does read-modify-write on config.json
 *
 * Hooks:
 * - app:start / "before-ready" — parses env vars + CLI flags, dispatches full merged config
 * - app:start / "init" — reads config.json, dispatches only delta from file values
 * - config-set-values / "set" — merges values into effective, optionally persists to disk
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Path } from "../../services/platform/path";
import type { ConfigValues, ConfigAgentType, ConfigKey } from "../../services/config/config-values";
import type {
  ConfigSetHookInput,
  ConfigSetHookResult,
  ConfigSetValuesIntent,
} from "../operations/config-set-values";
import type { ConfigureResult, InitHookContext } from "../operations/app-start";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG_VALUES,
  envVarToConfigKey,
  parseConfigValue,
  validateConfigValue,
  generateHelpText,
} from "../../services/config/config-values";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import {
  CONFIG_SET_VALUES_OPERATION_ID,
  INTENT_CONFIG_SET_VALUES,
} from "../operations/config-set-values";
import { INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ConfigModuleDeps {
  readonly fileSystem: FileSystemLayer;
  readonly configPath: Path;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): boolean };
}

// =============================================================================
// Env Var + CLI Parsing
// =============================================================================

/**
 * Scan an env object for CH_* keys (not _CH_*), convert to config keys,
 * validate against schema, parse values.
 */
export function parseEnvVars(env: Record<string, string | undefined>): Partial<ConfigValues> {
  const result: Record<string, unknown> = {};

  for (const [envKey, rawValue] of Object.entries(env)) {
    if (!envKey.startsWith("CH_") || envKey.startsWith("_CH_")) continue;
    if (rawValue === undefined) continue;

    const configKey = envVarToConfigKey(envKey);
    if (configKey === undefined) continue;

    if (!CONFIG_KEYS.has(configKey as ConfigKey)) {
      throw new Error(`Unknown config env var: ${envKey} (maps to "${configKey}")`);
    }

    const parsed = parseConfigValue(configKey as ConfigKey, rawValue);
    if (parsed === undefined && rawValue !== "") {
      // Invalid value — skip (don't throw, env vars may come from external sources)
      continue;
    }
    if (parsed !== undefined) {
      result[configKey] = parsed;
    }
  }

  return result as Partial<ConfigValues>;
}

/**
 * Parse CLI args in the form --key=value or --key value.
 * Key is the config key directly (e.g. --log.level=debug).
 */
export function parseCliArgs(argv: readonly string[]): Partial<ConfigValues> {
  const result: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;

    let key: string;
    let value: string | undefined;

    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      // Peek at next arg for value (if it doesn't start with --)
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        // Boolean flag with no value — treat as "true"
        value = "true";
      }
    }

    if (!CONFIG_KEYS.has(key as ConfigKey)) {
      // Unknown flag — skip silently (may be an Electron/Node flag)
      continue;
    }

    const parsed = parseConfigValue(key as ConfigKey, value);
    if (parsed !== undefined) {
      result[key] = parsed;
    }
  }

  return result as Partial<ConfigValues>;
}

// =============================================================================
// Config File Migration
// =============================================================================

/**
 * Key rename map: old flat key → new flat key.
 */
const KEY_RENAMES: ReadonlyMap<string, ConfigKey> = new Map([
  ["versions.codeServer", "version.code-server"],
  ["versions.claude", "version.claude"],
  ["versions.opencode", "version.opencode"],
  ["telemetry.distinctId", "telemetry.distinct-id"],
]);

/**
 * Old stale default for version.code-server. During migration, this value
 * is converted to null (= use built-in CODE_SERVER_VERSION).
 */
const OLD_CODE_SERVER_DEFAULT = "4.107.0";

/**
 * Legacy nested config format (pre-migration).
 */
interface LegacyConfig {
  agent?: ConfigAgentType;
  versions?: {
    claude?: string | null;
    opencode?: string | null;
    codeServer?: string;
  };
  telemetry?: {
    enabled?: boolean;
    distinctId?: string;
  };
}

/**
 * Parse a config.json object (legacy nested, old flat, or new flat format)
 * into file-layer ConfigValues. Unknown keys are ignored.
 *
 * Returns { values, migrated } where migrated is true if old key names
 * were found and renamed.
 */
function parseConfigFile(data: unknown): {
  values: Partial<ConfigValues>;
  migrated: boolean;
} {
  if (typeof data !== "object" || data === null) return { values: {}, migrated: false };

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let migrated = false;

  // Check for legacy nested format (has a "versions" or "telemetry" sub-object)
  const legacy = obj as LegacyConfig;
  const hasNestedVersions = typeof legacy.versions === "object" && legacy.versions !== null;
  const hasNestedTelemetry = typeof legacy.telemetry === "object" && legacy.telemetry !== null;

  if (hasNestedVersions || hasNestedTelemetry) {
    migrated = true;

    if (legacy.agent !== undefined) {
      result.agent = legacy.agent;
    }
    if (legacy.versions) {
      if (legacy.versions.claude !== undefined) result["version.claude"] = legacy.versions.claude;
      if (legacy.versions.opencode !== undefined)
        result["version.opencode"] = legacy.versions.opencode;
      if (legacy.versions.codeServer !== undefined)
        result["version.code-server"] =
          legacy.versions.codeServer === OLD_CODE_SERVER_DEFAULT
            ? null
            : legacy.versions.codeServer;
    }
    if (legacy.telemetry) {
      if (legacy.telemetry.enabled !== undefined)
        result["telemetry.enabled"] = legacy.telemetry.enabled;
      if (legacy.telemetry.distinctId !== undefined)
        result["telemetry.distinct-id"] = legacy.telemetry.distinctId;
    }

    return { values: validateFileValues(result), migrated };
  }

  // Flat format — apply key renames if needed, then copy known file-layer keys
  for (const [key, value] of Object.entries(obj)) {
    const renamedKey = KEY_RENAMES.get(key);
    if (renamedKey !== undefined) {
      result[renamedKey] =
        renamedKey === "version.code-server" && value === OLD_CODE_SERVER_DEFAULT ? null : value;
      migrated = true;
    } else if (CONFIG_KEYS.has(key as ConfigKey)) {
      result[key] = value;
    }
  }

  return { values: validateFileValues(result), migrated };
}

/**
 * Validate file-layer values using the schema's validators. Returns only valid entries.
 */
function validateFileValues(values: Record<string, unknown>): Partial<ConfigValues> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!CONFIG_KEYS.has(key as ConfigKey) || value === undefined) continue;
    const validated = validateConfigValue(key as ConfigKey, value);
    if (validated !== undefined) {
      result[key] = validated;
    }
  }
  return result as Partial<ConfigValues>;
}

// =============================================================================
// Factory
// =============================================================================

export function createConfigModule(deps: ConfigModuleDeps): IntentModule {
  const { fileSystem, configPath, dispatcher, logger } = deps;

  // Computed defaults: build-dependent values
  const _computedDefaults: Record<string, unknown> = {};
  if (deps.isDevelopment) {
    _computedDefaults["log.level"] = "debug";
  }
  if (deps.isDevelopment || !deps.isPackaged) {
    _computedDefaults["telemetry.enabled"] = false;
  }
  const computedDefaults = _computedDefaults as Partial<ConfigValues>;

  // Internal state: single merged config
  let envValues: Partial<ConfigValues> = {};
  let cliValues: Partial<ConfigValues> = {};
  const effective: ConfigValues = { ...DEFAULT_CONFIG_VALUES };

  /**
   * Compute which keys changed between old and new values.
   */
  function computeChanges(
    oldValues: ConfigValues,
    newValues: ConfigValues
  ): Partial<ConfigValues> | null {
    const changes: Record<string, unknown> = {};
    let hasChanges = false;
    for (const key of Object.keys(newValues) as (keyof ConfigValues)[]) {
      if (oldValues[key] !== newValues[key]) {
        changes[key] = newValues[key];
        hasChanges = true;
      }
    }
    return hasChanges ? (changes as Partial<ConfigValues>) : null;
  }

  return {
    name: "config",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            // Parse env vars and CLI args (no I/O — pure computation)
            envValues = parseEnvVars(deps.env);
            cliValues = parseCliArgs(deps.argv);

            // Full merged config: defaults + computed + env + CLI
            const merged = {
              ...DEFAULT_CONFIG_VALUES,
              ...computedDefaults,
              ...envValues,
              ...cliValues,
            } as Partial<ConfigValues>;

            await dispatcher.dispatch({
              type: INTENT_CONFIG_SET_VALUES,
              payload: { values: merged, persist: false },
            } as ConfigSetValuesIntent);

            if (effective.help === true) {
              deps.stdout.write(generateHelpText(deps.configPath.toString(), effective));
              await dispatcher.dispatch({
                type: INTENT_APP_SHUTDOWN,
                payload: {},
              } as AppShutdownIntent);
            }

            return {};
          },
        },

        init: {
          handler: async (_ctx: HookContext): Promise<{ configuredAgent?: ConfigAgentType }> => {
            const initCtx = _ctx as InitHookContext;
            void initCtx; // consume ctx

            // Read config.json from disk
            let fileValues: Partial<ConfigValues> = {};
            let migrated = false;
            try {
              const content = await fileSystem.readFile(configPath);
              const parsed = JSON.parse(content) as unknown;
              ({ values: fileValues, migrated } = parseConfigFile(parsed));
              logger.debug("Config loaded from disk", { path: configPath.toString() });
            } catch (error) {
              if (error instanceof Error && "fsCode" in error && error.fsCode === "ENOENT") {
                logger.debug("Config not found, using defaults", {
                  path: configPath.toString(),
                });
              } else {
                logger.warn("Config load failed, using defaults", {
                  path: configPath.toString(),
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            // Migration: write directly to disk, no dispatch
            if (migrated) {
              const json = JSON.stringify(Object.fromEntries(Object.entries(fileValues)), null, 2);
              await fileSystem.mkdir(configPath.dirname);
              await fileSystem.writeFile(configPath, json);
              logger.debug("Config migrated", { path: configPath.toString() });
            }

            // Rebuild full effective with file values included
            const merged = {
              ...DEFAULT_CONFIG_VALUES,
              ...computedDefaults,
              ...fileValues,
              ...envValues,
              ...cliValues,
            } as ConfigValues;

            // Only dispatch values that actually changed since before-ready
            const delta: Record<string, unknown> = {};
            for (const key of Object.keys(merged) as (keyof ConfigValues)[]) {
              if (merged[key] !== effective[key]) {
                delta[key] = merged[key];
              }
            }

            if (Object.keys(delta).length > 0) {
              await dispatcher.dispatch({
                type: INTENT_CONFIG_SET_VALUES,
                payload: { values: delta as Partial<ConfigValues>, persist: false },
              } as ConfigSetValuesIntent);
            }

            return { configuredAgent: effective.agent };
          },
        },
      },

      [CONFIG_SET_VALUES_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<ConfigSetHookResult> => {
            const { values, persist } = ctx as ConfigSetHookInput;

            // Snapshot before merge
            const oldEffective = { ...effective };

            // Merge into effective
            for (const [key, value] of Object.entries(values)) {
              if (value !== undefined) {
                (effective as Record<string, unknown>)[key] = value;
              }
            }

            if (persist) {
              // Read-modify-write config file
              let fileContent: Record<string, unknown> = {};
              try {
                const raw = await fileSystem.readFile(configPath);
                fileContent = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                /* file doesn't exist yet — start fresh */
              }

              for (const [key, value] of Object.entries(values)) {
                fileContent[key] = value;
              }
              await fileSystem.mkdir(configPath.dirname);
              await fileSystem.writeFile(configPath, JSON.stringify(fileContent, null, 2));
              logger.debug("Config persisted", { path: configPath.toString() });
            }

            const changedValues = computeChanges(oldEffective, effective);
            return { changedValues: changedValues ?? {} };
          },
        },
      },
    },
  };
}
