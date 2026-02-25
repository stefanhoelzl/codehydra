/**
 * ConfigModule - Manages application configuration via the intent dispatcher.
 *
 * Unifies file config (config.json) and env vars into a single event-driven system.
 * Consumers subscribe to `config:updated` events instead of depending on ConfigService.
 *
 * Internal state: file layer (persistent) + env layer (runtime).
 * Effective config = merge where env overrides file.
 *
 * Hooks:
 * - app:start / "before-ready" — reads env vars (sync process.env), dispatches config:set-values
 * - app:start / "init" — reads config.json from disk, dispatches config:set-values
 * - config-set-values / "set" — merges values, persists if dirty, returns changed values
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Path } from "../../services/platform/path";
import type { ConfigValues, ConfigAgentType } from "../../services/config/config-values";
import type {
  ConfigSetHookInput,
  ConfigSetHookResult,
  ConfigSetValuesIntent,
} from "../operations/config-set-values";
import type { ConfigureResult, InitHookContext } from "../operations/app-start";
import { DEFAULT_CONFIG_VALUES, FILE_LAYER_KEYS } from "../../services/config/config-values";
import { parseLogLevel } from "../../services/logging/electron-log-service";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import {
  CONFIG_SET_VALUES_OPERATION_ID,
  INTENT_CONFIG_SET_VALUES,
} from "../operations/config-set-values";

// =============================================================================
// Dependency Interface
// =============================================================================

export interface ConfigModuleDeps {
  readonly fileSystem: FileSystemLayer;
  readonly configPath: Path;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly isDevelopment: boolean;
}

// =============================================================================
// Nested → Flat migration
// =============================================================================

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
 * Parse a config.json object (either nested legacy or flat format) into
 * file-layer ConfigValues. Unknown keys are ignored.
 */
function parseConfigFile(data: unknown): Partial<ConfigValues> {
  if (typeof data !== "object" || data === null) return {};

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // Detect flat format: has dot-separated keys
  if ("versions.codeServer" in obj || "telemetry.enabled" in obj) {
    // Flat format — copy known file-layer keys
    for (const key of FILE_LAYER_KEYS) {
      if (key in obj) {
        result[key] = obj[key];
      }
    }
    return validateFileValues(result as Partial<ConfigValues>);
  }

  // Legacy nested format
  const legacy = obj as LegacyConfig;

  if (legacy.agent !== undefined) {
    result.agent = legacy.agent;
  }
  if (legacy.versions) {
    if (legacy.versions.claude !== undefined) result["versions.claude"] = legacy.versions.claude;
    if (legacy.versions.opencode !== undefined)
      result["versions.opencode"] = legacy.versions.opencode;
    if (legacy.versions.codeServer !== undefined)
      result["versions.codeServer"] = legacy.versions.codeServer;
  }
  if (legacy.telemetry) {
    if (legacy.telemetry.enabled !== undefined)
      result["telemetry.enabled"] = legacy.telemetry.enabled;
    if (legacy.telemetry.distinctId !== undefined)
      result["telemetry.distinctId"] = legacy.telemetry.distinctId;
  }

  return validateFileValues(result as Partial<ConfigValues>);
}

/**
 * Validate file-layer values. Returns only valid entries.
 */
function validateFileValues(values: Partial<ConfigValues>): Partial<ConfigValues> {
  const result: Record<string, unknown> = {};

  if (values.agent !== undefined) {
    if (values.agent === null || values.agent === "claude" || values.agent === "opencode") {
      result.agent = values.agent;
    }
  }

  if (values["versions.claude"] !== undefined) {
    if (values["versions.claude"] === null || typeof values["versions.claude"] === "string") {
      result["versions.claude"] = values["versions.claude"];
    }
  }

  if (values["versions.opencode"] !== undefined) {
    if (values["versions.opencode"] === null || typeof values["versions.opencode"] === "string") {
      result["versions.opencode"] = values["versions.opencode"];
    }
  }

  if (values["versions.codeServer"] !== undefined) {
    if (typeof values["versions.codeServer"] === "string") {
      result["versions.codeServer"] = values["versions.codeServer"];
    }
  }

  if (values["telemetry.enabled"] !== undefined) {
    if (typeof values["telemetry.enabled"] === "boolean") {
      result["telemetry.enabled"] = values["telemetry.enabled"];
    }
  }

  if (values["telemetry.distinctId"] !== undefined) {
    if (typeof values["telemetry.distinctId"] === "string") {
      result["telemetry.distinctId"] = values["telemetry.distinctId"];
    }
  }

  return result as Partial<ConfigValues>;
}

/**
 * Serialize file-layer values to flat JSON format for persistence.
 */
function serializeFileLayer(fileLayer: Partial<ConfigValues>): string {
  const obj: Record<string, unknown> = {};
  for (const key of FILE_LAYER_KEYS) {
    const value = fileLayer[key];
    if (value !== undefined) {
      obj[key] = value;
    }
  }
  return JSON.stringify(obj, null, 2);
}

// =============================================================================
// Factory
// =============================================================================

export function createConfigModule(deps: ConfigModuleDeps): IntentModule {
  const { fileSystem, configPath, dispatcher, logger } = deps;

  // Internal state: two layers merged to produce effective config
  const fileLayer: Partial<ConfigValues> = {};
  const envLayer: Partial<ConfigValues> = {};
  let effective: ConfigValues = { ...DEFAULT_CONFIG_VALUES };

  /** Snapshot of file layer at last persist (for dirty check). */
  let lastPersistedJson = "";

  /**
   * Merge env layer on top of file layer on top of defaults to produce effective config.
   */
  function recomputeEffective(): void {
    effective = { ...DEFAULT_CONFIG_VALUES, ...fileLayer, ...envLayer } as ConfigValues;
  }

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

  /**
   * Persist file layer to disk if it has changed since last write.
   */
  async function persistIfDirty(): Promise<void> {
    const json = serializeFileLayer(fileLayer);
    if (json === lastPersistedJson) return;

    await fileSystem.mkdir(configPath.dirname);
    await fileSystem.writeFile(configPath, json);
    lastPersistedJson = json;
    logger.debug("Config persisted", { path: configPath.toString() });
  }

  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "before-ready": {
          handler: async (): Promise<ConfigureResult> => {
            // Read env vars (synchronous — no I/O)
            // Use Record to build mutable partial — ConfigValues is readonly
            const envValues: Record<string, unknown> = {};

            const parsedLevel = parseLogLevel(process.env.CODEHYDRA_LOGLEVEL);
            if (parsedLevel !== undefined) {
              envValues["log.level"] = parsedLevel;
            } else if (deps.isDevelopment) {
              envValues["log.level"] = "debug";
            }

            if (process.env.CODEHYDRA_PRINT_LOGS) {
              envValues["log.console"] = true;
            }

            const filterValue = process.env.CODEHYDRA_LOGGER;
            if (filterValue) {
              envValues["log.filter"] = filterValue;
            }

            const flagsValue = process.env.CODEHYDRA_ELECTRON_FLAGS;
            if (flagsValue) {
              envValues["electron.flags"] = flagsValue;
            }

            // Dispatch config:set-values with env values — this triggers the
            // "set" hook which stores them and emits config:updated
            if (Object.keys(envValues).length > 0) {
              await dispatcher.dispatch({
                type: INTENT_CONFIG_SET_VALUES,
                payload: { values: envValues as Partial<ConfigValues> },
              } as ConfigSetValuesIntent);
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
            try {
              const content = await fileSystem.readFile(configPath);
              const parsed = JSON.parse(content) as unknown;
              fileValues = parseConfigFile(parsed);
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

            // Initialize file layer and lastPersistedJson for dirty check
            // We set lastPersistedJson to represent what was on disk so we don't
            // re-write on the very first dispatch unless values actually change
            const initialFileLayer: Partial<ConfigValues> = {
              ...DEFAULT_CONFIG_VALUES,
            };
            // Remove env-layer keys from the default snapshot — file layer only has file keys
            for (const key of Object.keys(initialFileLayer) as (keyof ConfigValues)[]) {
              if (!FILE_LAYER_KEYS.has(key)) {
                delete (initialFileLayer as Record<string, unknown>)[key];
              }
            }
            // Merge loaded values on top of file defaults
            const mergedFileDefaults = { ...initialFileLayer, ...fileValues };
            lastPersistedJson = serializeFileLayer(mergedFileDefaults);

            // Dispatch config:set-values with file values (includes defaults for missing keys)
            await dispatcher.dispatch({
              type: INTENT_CONFIG_SET_VALUES,
              payload: { values: mergedFileDefaults },
            } as ConfigSetValuesIntent);

            return { configuredAgent: effective.agent };
          },
        },
      },

      [CONFIG_SET_VALUES_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<ConfigSetHookResult> => {
            const { values } = ctx as ConfigSetHookInput;

            // Snapshot before merge
            const oldEffective = { ...effective };

            // Merge into appropriate layers, track if file layer was touched
            let fileLayerTouched = false;
            for (const [key, value] of Object.entries(values)) {
              const configKey = key as keyof ConfigValues;
              if (FILE_LAYER_KEYS.has(configKey)) {
                fileLayerTouched = true;
                if (value === null || value === undefined) {
                  delete (fileLayer as Record<string, unknown>)[configKey];
                } else {
                  (fileLayer as Record<string, unknown>)[configKey] = value;
                }
              } else {
                // Env layer key
                if (value === null || value === undefined) {
                  delete (envLayer as Record<string, unknown>)[configKey];
                } else {
                  (envLayer as Record<string, unknown>)[configKey] = value;
                }
              }
            }

            recomputeEffective();

            // Persist file layer only if file-layer keys were modified
            if (fileLayerTouched) {
              await persistIfDirty();
            }

            // Compute changed values
            const changedValues = computeChanges(oldEffective, effective);
            return { changedValues: changedValues ?? {} };
          },
        },
      },
    },
  };
}
