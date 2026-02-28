/**
 * ConfigModule - Manages application configuration via the intent dispatcher.
 *
 * Single merged config. Precedence is handled by dispatch order:
 * - register-config: modules return their config key definitions
 * - before-ready: build definition map, compute defaults + env vars + CLI args
 * - init: file values merged in (only changed values dispatched)
 * - set: external callers merge values; persist=true does read-modify-write on config.json
 *
 * Hooks:
 * - app:start / "register-config" — returns definitions for `agent` and `help`
 * - app:start / "before-ready" — collects definitions, parses env vars + CLI flags,
 *   dispatches full merged config
 * - app:start / "init" — reads config.json, dispatches only delta from file values
 * - config-set-values / "set" — merges values into effective, optionally persists to disk
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { Path } from "../../services/platform/path";
import type {
  ConfigKeyDefinition,
  ComputedDefaultContext,
} from "../../services/config/config-definition";
import { parseBool } from "../../services/config/config-definition";
import type { ConfigAgentType } from "../../services/config/config-values";
import { envVarToConfigKey, generateHelpText } from "../../services/config/config-values";
import type {
  ConfigSetHookInput,
  ConfigSetHookResult,
  ConfigSetValuesIntent,
} from "../operations/config-set-values";
import type {
  ConfigureResult,
  InitHookContext,
  RegisterConfigResult,
  BeforeReadyHookContext,
} from "../operations/app-start";
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
 * validate against definition map, parse values.
 */
export function parseEnvVars(
  env: Record<string, string | undefined>,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [envKey, rawValue] of Object.entries(env)) {
    if (!envKey.startsWith("CH_") || envKey.startsWith("_CH_")) continue;
    if (rawValue === undefined) continue;

    const configKey = envVarToConfigKey(envKey);
    if (configKey === undefined) continue;

    const def = definitions.get(configKey);
    if (!def) {
      throw new Error(`Unknown config env var: ${envKey} (maps to "${configKey}")`);
    }

    const parsed = def.parse(rawValue);
    if (parsed === undefined && rawValue !== "") {
      // Invalid value — skip (don't throw, env vars may come from external sources)
      continue;
    }
    if (parsed !== undefined) {
      result[configKey] = parsed;
    }
  }

  return result;
}

/**
 * Parse CLI args in the form --key=value or --key value.
 * Key is the config key directly (e.g. --log.level=debug).
 */
export function parseCliArgs(
  argv: readonly string[],
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
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

    const def = definitions.get(key);
    if (!def) {
      // Unknown flag — skip silently (may be an Electron/Node flag)
      continue;
    }

    const parsed = def.parse(value);
    if (parsed !== undefined) {
      result[key] = parsed;
    }
  }

  return result;
}

// =============================================================================
// Config File Parsing
// =============================================================================

/**
 * Parse a config.json object (flat kebab-case format) into file-layer config values.
 * Unknown keys are ignored.
 */
function parseConfigFile(
  data: unknown,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
  if (typeof data !== "object" || data === null) return {};

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (definitions.has(key)) {
      result[key] = value;
    }
  }

  return validateFileValues(result, definitions);
}

/**
 * Validate file-layer values using the definition map's validators. Returns only valid entries.
 */
function validateFileValues(
  values: Record<string, unknown>,
  definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const def = definitions.get(key);
    if (!def || value === undefined) continue;
    const validated = def.validate(value);
    if (validated !== undefined) {
      result[key] = validated;
    }
  }
  return result;
}

// =============================================================================
// Factory
// =============================================================================

export function createConfigModule(deps: ConfigModuleDeps): IntentModule {
  const { fileSystem, configPath, dispatcher, logger } = deps;

  // Stored definition map — populated by before-ready from register-config results
  let definitionMap: Map<string, ConfigKeyDefinition<unknown>> = new Map();

  // Internal state: single merged config
  let envValues: Record<string, unknown> = {};
  let cliValues: Record<string, unknown> = {};
  const effective: Record<string, unknown> = {};

  /**
   * Compute which keys changed between old and new values.
   */
  function computeChanges(
    oldValues: Record<string, unknown>,
    newValues: Record<string, unknown>
  ): Record<string, unknown> | null {
    const changes: Record<string, unknown> = {};
    let hasChanges = false;
    for (const key of Object.keys(newValues)) {
      if (oldValues[key] !== newValues[key]) {
        changes[key] = newValues[key];
        hasChanges = true;
      }
    }
    return hasChanges ? changes : null;
  }

  /**
   * Build default values from definitions, applying computedDefault where available.
   */
  function buildDefaults(
    definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>>,
    ctx: ComputedDefaultContext
  ): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const [key, def] of definitions) {
      defaults[key] = def.default;
      if (def.computedDefault) {
        const computed = def.computedDefault(ctx);
        if (computed !== undefined) {
          defaults[key] = computed;
        }
      }
    }
    return defaults;
  }

  return {
    name: "config",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "agent",
                default: null,
                parse: (s: string) =>
                  s === "claude" || s === "opencode" ? s : s === "" ? null : undefined,
                validate: (v: unknown) =>
                  v === null || v === "claude" || v === "opencode"
                    ? (v as ConfigAgentType)
                    : undefined,
              },
              {
                name: "help",
                default: false,
                parse: parseBool,
                validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
              },
            ],
          }),
        },

        "before-ready": {
          handler: async (ctx: HookContext): Promise<ConfigureResult> => {
            const { configDefinitions } = ctx as BeforeReadyHookContext;

            // Build definition map from collected definitions, check for duplicates
            definitionMap = new Map();
            for (const def of configDefinitions) {
              if (definitionMap.has(def.name)) {
                throw new Error(`Duplicate config key definition: "${def.name}"`);
              }
              definitionMap.set(def.name, def);
            }

            // Seed effective with static defaults so first dispatch only reports actual changes
            for (const [key, def] of definitionMap) {
              effective[key] = def.default;
            }

            // Build defaults (static + computed)
            const computedDefaultCtx: ComputedDefaultContext = {
              isDevelopment: deps.isDevelopment,
              isPackaged: deps.isPackaged,
            };
            const defaults = buildDefaults(definitionMap, computedDefaultCtx);

            // Parse env vars and CLI args (no I/O — pure computation)
            envValues = parseEnvVars(deps.env, definitionMap);
            cliValues = parseCliArgs(deps.argv, definitionMap);

            // Full merged config: defaults + env + CLI
            const merged = {
              ...defaults,
              ...envValues,
              ...cliValues,
            };

            await dispatcher.dispatch({
              type: INTENT_CONFIG_SET_VALUES,
              payload: { values: merged, persist: false },
            } as ConfigSetValuesIntent);

            if (effective.help === true) {
              deps.stdout.write(
                generateHelpText(deps.configPath.toString(), definitionMap, effective)
              );
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

            // Build defaults again for merging (same as before-ready)
            const computedDefaultCtx: ComputedDefaultContext = {
              isDevelopment: deps.isDevelopment,
              isPackaged: deps.isPackaged,
            };
            const defaults = buildDefaults(definitionMap, computedDefaultCtx);

            // Read config.json from disk
            let fileValues: Record<string, unknown> = {};
            try {
              const content = await fileSystem.readFile(configPath);
              const parsed = JSON.parse(content) as unknown;
              fileValues = parseConfigFile(parsed, definitionMap);
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

            // Rebuild full effective with file values included
            const merged = {
              ...defaults,
              ...fileValues,
              ...envValues,
              ...cliValues,
            };

            // Only dispatch values that actually changed since before-ready
            const delta: Record<string, unknown> = {};
            for (const key of Object.keys(merged)) {
              if (merged[key] !== effective[key]) {
                delta[key] = merged[key];
              }
            }

            if (Object.keys(delta).length > 0) {
              await dispatcher.dispatch({
                type: INTENT_CONFIG_SET_VALUES,
                payload: { values: delta, persist: false },
              } as ConfigSetValuesIntent);
            }

            return { configuredAgent: effective.agent as ConfigAgentType };
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
                effective[key] = value;
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
