// @vitest-environment node
/**
 * Integration tests for ConfigModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers all hook points:
 * - app:start / "register-config" -- modules return config key definitions
 * - app:start / "before-ready" -- collects definitions, dispatches full merged config
 * - app:start / "init" -- reads config.json, dispatches only delta
 * - config-set-values / "set" -- merges values into effective, optionally persists to disk
 *
 * Also covers:
 * - parseEnvVars / parseCliArgs standalone
 * - Precedence (CLI > env > file > computed > defaults)
 * - Config file migration (old keys → new keys)
 *
 * Most tests use test-specific config definitions (test.string, test.level, etc.)
 * to verify config-module mechanics independently of real module definitions.
 * Migration tests use additional real-key definitions because parseConfigFile
 * is tied to production key names.
 */

import { describe, it, expect, vi } from "vitest";
import { Path } from "../../services/platform/path";
import { createMockLogger, SILENT_LOGGER } from "../../services/logging";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import type { IntentModule } from "../intents/infrastructure/module";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type {
  AppStartIntent,
  ConfigureResult,
  InitHookContext,
  RegisterConfigResult,
  BeforeReadyHookContext,
} from "../operations/app-start";
import {
  ConfigSetValuesOperation,
  INTENT_CONFIG_SET_VALUES,
  EVENT_CONFIG_UPDATED,
} from "../operations/config-set-values";
import type { ConfigSetValuesIntent, ConfigUpdatedEvent } from "../operations/config-set-values";
import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../services/platform/filesystem.state-mock";
import { createConfigModule, parseEnvVars, parseCliArgs } from "./config-module";
import { generateHelpText } from "../../services/config/config-values";
import { parseBool, ConfigValidationError } from "../../services/config/config-definition";
import type { ConfigKeyDefinition } from "../../services/config/config-definition";

// =============================================================================
// Test Config Definitions
// =============================================================================

/**
 * Test-specific config key definitions for config mechanics testing.
 * These verify config-module behavior without duplicating real module definitions.
 *
 * Env var mapping (via envVarToConfigKey):
 *   test.string       → CH_TEST__STRING
 *   test.dev-flag     → CH_TEST__DEV_FLAG
 *   test.nullable     → CH_TEST__NULLABLE
 *   test.enum         → CH_TEST__ENUM
 *   test.level        → CH_TEST__LEVEL
 *   test.optional     → CH_TEST__OPTIONAL
 */
function testDefinitions(): ConfigKeyDefinition<unknown>[] {
  return [
    {
      name: "test.string",
      default: "default-val",
      parse: (s: string) => (s === "" ? undefined : s),
      validate: (v: unknown) => (typeof v === "string" ? v : undefined),
    },
    {
      name: "test.dev-flag",
      default: true,
      parse: parseBool,
      validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
      computedDefault: (ctx) => (ctx.isDevelopment || !ctx.isPackaged ? false : undefined),
    },
    {
      name: "test.nullable",
      default: null,
      parse: (s: string) => (s === "" ? null : s),
      validate: (v: unknown) => (v === null || typeof v === "string" ? v : undefined),
    },
    {
      name: "test.enum",
      default: "always",
      parse: (s: string) => (s === "always" || s === "never" ? s : undefined),
      validate: (v: unknown) => (v === "always" || v === "never" ? v : undefined),
    },
    {
      name: "test.level",
      default: "warn",
      parse: (s: string) => {
        const valid = ["silly", "debug", "info", "warn", "error"];
        return valid.includes(s) ? s : undefined;
      },
      validate: (v: unknown) => {
        if (typeof v !== "string") return undefined;
        const valid = ["silly", "debug", "info", "warn", "error"];
        return valid.includes(v) ? v : undefined;
      },
      computedDefault: (ctx) => (ctx.isDevelopment ? "debug" : undefined),
    },
    {
      name: "test.optional",
      default: null,
      parse: (s: string) => (s === "" ? null : s),
      validate: (v: unknown) => (v === null ? null : typeof v === "string" ? v : undefined),
    },
  ];
}

/**
 * Module that registers test config definitions via the register-config hook.
 */
function createTestDefinitionsModule(defs: ConfigKeyDefinition<unknown>[]): IntentModule {
  return {
    name: "test-definitions",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: defs,
          }),
        },
      },
    },
  };
}

/**
 * Build a definitions map from config-module's own definitions + test definitions.
 * Used for standalone parseEnvVars/parseCliArgs tests.
 */
function buildTestDefinitionsMap(): Map<string, ConfigKeyDefinition<unknown>> {
  const configModuleDefs: ConfigKeyDefinition<unknown>[] = [
    {
      name: "agent",
      default: null,
      parse: (s: string) => (s === "claude" || s === "opencode" ? s : s === "" ? null : undefined),
      validate: (v: unknown) => (v === null || v === "claude" || v === "opencode" ? v : undefined),
    },
    {
      name: "help",
      default: false,
      parse: parseBool,
      validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
    },
  ];
  const allDefs = [...configModuleDefs, ...testDefinitions()];
  return new Map(allDefs.map((d) => [d.name, d]));
}

/**
 * All test config key names (config-module's own + test definitions).
 */
const ALL_TEST_KEYS = [
  "agent",
  "help",
  "test.string",
  "test.dev-flag",
  "test.nullable",
  "test.enum",
  "test.level",
  "test.optional",
];

// =============================================================================
// Minimal Test Operations
// =============================================================================

/**
 * Runs "register-config" then "before-ready" hook points.
 * The before-ready hook dispatches config:set-values internally,
 * so the dispatcher must have ConfigSetValuesOperation registered.
 */
class MinimalBeforeReadyOperation implements Operation<Intent, ConfigureResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ConfigureResult> {
    // Run register-config first
    const { results: regResults, errors: regErrors } =
      await ctx.hooks.collect<RegisterConfigResult>("register-config", { intent: ctx.intent });
    if (regErrors.length > 0) throw regErrors[0]!;
    const configDefinitions = regResults.flatMap((r) => r.definitions ?? []);

    // Run before-ready with definitions
    const beforeReadyCtx: BeforeReadyHookContext = {
      intent: ctx.intent,
      configDefinitions,
    };
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>(
      "before-ready",
      beforeReadyCtx
    );
    if (errors.length > 0) throw errors[0]!;
    const merged: ConfigureResult = {};
    for (const r of results) {
      if (r.scripts) {
        (merged as Record<string, unknown>).scripts = [
          ...((merged.scripts as string[]) ?? []),
          ...r.scripts,
        ];
      }
    }
    return merged;
  }
}

/**
 * Runs "register-config", "before-ready", then "init" hook points.
 * init depends on before-ready having run to populate definitions.
 */
class MinimalInitOperation implements Operation<Intent, { configuredAgent?: string | null }> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
    const { results: regResults, errors: regErrors } =
      await ctx.hooks.collect<RegisterConfigResult>("register-config", { intent: ctx.intent });
    if (regErrors.length > 0) throw regErrors[0]!;
    const configDefinitions = regResults.flatMap((r) => r.definitions ?? []);

    const beforeReadyCtx: BeforeReadyHookContext = {
      intent: ctx.intent,
      configDefinitions,
    };
    const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>(
      "before-ready",
      beforeReadyCtx
    );
    if (brErrors.length > 0) throw brErrors[0]!;

    const initCtx: InitHookContext = {
      intent: ctx.intent,
      requiredScripts: [],
    };
    const { results, errors } = await ctx.hooks.collect<{ configuredAgent?: string | null }>(
      "init",
      initCtx
    );
    if (errors.length > 0) throw errors[0]!;
    let configuredAgent: string | null = null;
    for (const result of results) {
      if (result.configuredAgent !== undefined) configuredAgent = result.configuredAgent;
    }
    return { configuredAgent };
  }
}

/**
 * Runs all three hook points: register-config → before-ready → init.
 * Used by tests that need the full pipeline (precedence, computed defaults).
 */
class CombinedStartOperation implements Operation<Intent, { configuredAgent?: string | null }> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
    const { results: regResults, errors: regErrors } =
      await ctx.hooks.collect<RegisterConfigResult>("register-config", { intent: ctx.intent });
    if (regErrors.length > 0) throw regErrors[0]!;
    const configDefinitions = regResults.flatMap((r) => r.definitions ?? []);

    const beforeReadyCtx: BeforeReadyHookContext = {
      intent: ctx.intent,
      configDefinitions,
    };
    const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>(
      "before-ready",
      beforeReadyCtx
    );
    if (brErrors.length > 0) throw brErrors[0]!;

    const initCtx: InitHookContext = { intent: ctx.intent, requiredScripts: [] };
    const { results, errors } = await ctx.hooks.collect<{
      configuredAgent?: string | null;
    }>("init", initCtx);
    if (errors.length > 0) throw errors[0]!;

    let configuredAgent: string | null = null;
    for (const result of results) {
      if (result.configuredAgent !== undefined) configuredAgent = result.configuredAgent;
    }
    return { configuredAgent };
  }
}

// =============================================================================
// Helpers
// =============================================================================

const CONFIG_PATH = new Path("/app/config/config.json");

function createTestSetup(options?: {
  isDevelopment?: boolean;
  isPackaged?: boolean;
  configFileContent?: string;
  noConfigFile?: boolean;
  env?: Record<string, string | undefined>;
  argv?: string[];
  extraDefinitions?: ConfigKeyDefinition<unknown>[];
}) {
  const fileSystem = createFileSystemMock({
    entries: {
      "/app/config": directory(),
      ...(options?.noConfigFile
        ? {}
        : options?.configFileContent !== undefined
          ? { "/app/config/config.json": file(options.configFileContent) }
          : {}),
    },
  });

  const stdout = { write: vi.fn().mockReturnValue(true) };

  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Always register config:set-values operation (needed by before-ready and init hooks)
  dispatcher.registerOperation(INTENT_CONFIG_SET_VALUES, new ConfigSetValuesOperation());

  const module = createConfigModule({
    fileSystem,
    configPath: CONFIG_PATH,
    dispatcher,
    logger: SILENT_LOGGER,
    isDevelopment: options?.isDevelopment ?? false,
    isPackaged: options?.isPackaged ?? false,
    env: options?.env ?? {},
    argv: options?.argv ?? [],
    stdout,
  });

  dispatcher.registerModule(module);

  // Register test definitions module
  const defs = [...testDefinitions(), ...(options?.extraDefinitions ?? [])];
  dispatcher.registerModule(createTestDefinitionsModule(defs));

  return { fileSystem, hookRegistry, dispatcher, module, stdout };
}

// =============================================================================
// Tests
// =============================================================================

describe("ConfigModule Integration", () => {
  // ---------------------------------------------------------------------------
  // parseEnvVars standalone
  // ---------------------------------------------------------------------------
  describe("parseEnvVars", () => {
    const definitions = buildTestDefinitionsMap();

    it("maps CH_TEST__STRING to test.string", () => {
      const result = parseEnvVars({ CH_TEST__STRING: "custom" }, definitions);
      expect(result["test.string"]).toBe("custom");
    });

    it("maps CH_TEST__LEVEL to test.level", () => {
      const result = parseEnvVars({ CH_TEST__LEVEL: "debug" }, definitions);
      expect(result["test.level"]).toBe("debug");
    });

    it("maps CH_TEST__ENUM to test.enum", () => {
      const result = parseEnvVars({ CH_TEST__ENUM: "never" }, definitions);
      expect(result["test.enum"]).toBe("never");
    });

    it("maps CH_TEST__OPTIONAL to test.optional", () => {
      const result = parseEnvVars({ CH_TEST__OPTIONAL: "some-value" }, definitions);
      expect(result["test.optional"]).toBe("some-value");
    });

    it("maps CH_TEST__NULLABLE to test.nullable", () => {
      const result = parseEnvVars({ CH_TEST__NULLABLE: "override-val" }, definitions);
      expect(result["test.nullable"]).toBe("override-val");
    });

    it("maps CH_TEST__DEV_FLAG to test.dev-flag", () => {
      const result = parseEnvVars({ CH_TEST__DEV_FLAG: "false" }, definitions);
      expect(result["test.dev-flag"]).toBe(false);
    });

    it("ignores _CH_ prefixed vars (internal)", () => {
      const result = parseEnvVars({ _CH_INTERNAL: "value" }, definitions);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("ignores non-CH_ vars", () => {
      const result = parseEnvVars({ HOME: "/home/user", PATH: "/usr/bin" }, definitions);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("throws on unknown CH_ env var", () => {
      expect(() => parseEnvVars({ CH_UNKNOWN_VAR: "value" }, definitions)).toThrow(
        ConfigValidationError
      );
    });

    it("throws on invalid env var value", () => {
      expect(() => parseEnvVars({ CH_TEST__LEVEL: "not-a-level" }, definitions)).toThrow(
        ConfigValidationError
      );
    });
  });

  // ---------------------------------------------------------------------------
  // parseCliArgs standalone
  // ---------------------------------------------------------------------------
  describe("parseCliArgs", () => {
    const definitions = buildTestDefinitionsMap();

    it("parses --key=value format", () => {
      const result = parseCliArgs(["--test.level=debug"], definitions, SILENT_LOGGER);
      expect(result["test.level"]).toBe("debug");
    });

    it("parses --key value format", () => {
      const result = parseCliArgs(["--test.level", "debug"], definitions, SILENT_LOGGER);
      expect(result["test.level"]).toBe("debug");
    });

    it("parses --test.enum flag", () => {
      const result = parseCliArgs(["--test.enum=never"], definitions, SILENT_LOGGER);
      expect(result["test.enum"]).toBe("never");
    });

    it("warns and skips unknown CLI flags", () => {
      const logger = createMockLogger();
      const result = parseCliArgs(
        ["--unknown-flag=value", "--test.level=debug"],
        definitions,
        logger
      );
      expect(result["test.level"]).toBe("debug");
      expect(result).not.toHaveProperty("unknown-flag");
      expect(logger.warn).toHaveBeenCalledWith("Unknown CLI flag (ignored)", {
        flag: "unknown-flag",
      });
    });

    it("parses multiple flags", () => {
      const result = parseCliArgs(
        ["--test.level=debug", "--test.enum=never", "--agent=claude"],
        definitions,
        SILENT_LOGGER
      );
      expect(result["test.level"]).toBe("debug");
      expect(result["test.enum"]).toBe("never");
      expect(result.agent).toBe("claude");
    });

    it("parses boolean flag without value as true", () => {
      const result = parseCliArgs(["--help"], definitions, SILENT_LOGGER);
      expect(result.help).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // app-start / "before-ready"
  // ---------------------------------------------------------------------------
  describe('app-start / "before-ready"', () => {
    it("dispatches computed defaults when isDevelopment=true", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.level"]).toBe("debug");
      expect(events[0]!.payload.values["test.dev-flag"]).toBe(false);
    });

    it("parses env var and applies to config", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: false,
        isPackaged: true,
        env: { CH_TEST__LEVEL: "silly" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.level"]).toBe("silly");
    });

    it("env var overrides computed default", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        env: { CH_TEST__LEVEL: "error" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.level"]).toBe("error");
    });

    it("sets enum value from env var", async () => {
      const { dispatcher } = createTestSetup({
        isPackaged: true,
        env: { CH_TEST__ENUM: "never" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.enum"]).toBe("never");
    });

    it("sets optional value from env var", async () => {
      const { dispatcher } = createTestSetup({
        isPackaged: true,
        env: { CH_TEST__OPTIONAL: "some-flags" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.optional"]).toBe("some-flags");
    });

    it("CLI flags override env vars", async () => {
      const { dispatcher } = createTestSetup({
        isPackaged: true,
        env: { CH_TEST__LEVEL: "silly" },
        argv: ["--test.level=error"],
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["test.level"]).toBe("error");
    });

    it("returns empty ConfigureResult (no scripts)", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(result).toEqual({});
      expect(result).not.toHaveProperty("scripts");
    });

    it("emits all keys including static defaults on first dispatch (production)", async () => {
      // isPackaged=true + isDevelopment=false → all values emitted (no seed to suppress them)
      const { dispatcher } = createTestSetup({ isDevelopment: false, isPackaged: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // All keys are emitted on first dispatch — subscribers need full initial config
      expect(events).toHaveLength(1);
      const values = events[0]!.payload.values;
      expect(values).toHaveProperty("test.string");
      expect(values).toHaveProperty("test.level");
    });
  });

  // ---------------------------------------------------------------------------
  // app-start / "init"
  // ---------------------------------------------------------------------------
  describe('app-start / "init"', () => {
    it("reads config.json from disk and dispatches delta", async () => {
      const configContent = JSON.stringify({
        agent: "claude",
        "test.nullable": "custom-val",
        "test.enum": "never",
      });

      // Use isPackaged=true so computed defaults don't interfere
      const { dispatcher } = createTestSetup({
        configFileContent: configContent,
        isPackaged: true,
      });

      // Subscribe after setup — before-ready events are internal to MinimalInitOperation
      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBe("claude");
      // First event: before-ready emits all defaults; second: init emits file delta
      expect(events).toHaveLength(2);
      // Init delta contains file values that differ from defaults
      const initEvent = events[1]!;
      expect(initEvent.payload.values.agent).toBe("claude");
      expect(initEvent.payload.values["test.nullable"]).toBe("custom-val");
      expect(initEvent.payload.values["test.enum"]).toBe("never");
    });

    it("enum value from config.json round-trips through init", async () => {
      const configContent = JSON.stringify({ "test.enum": "never" });

      const { dispatcher } = createTestSetup({
        configFileContent: configContent,
        isPackaged: true,
      });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // before-ready emits default "always", init emits file override "never"
      expect(events).toHaveLength(2);
      expect(events[0]!.payload.values["test.enum"]).toBe("always");
      expect(events[1]!.payload.values["test.enum"]).toBe("never");
    });

    it("returns configuredAgent from effective config", async () => {
      const configContent = JSON.stringify({ agent: "opencode" });

      const { dispatcher } = createTestSetup({ configFileContent: configContent });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBe("opencode");
    });

    it("uses defaults when config.json does not exist (ENOENT)", async () => {
      // Use isPackaged=true so computed defaults don't interfere
      const { dispatcher } = createTestSetup({ noConfigFile: true, isPackaged: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBeNull();
      // before-ready emits all defaults; init has no delta (no file)
      expect(events).toHaveLength(1);
    });

    it("uses defaults when config.json is corrupt JSON", async () => {
      // Use isPackaged=true so computed defaults don't interfere
      const { dispatcher } = createTestSetup({
        configFileContent: "not valid json {{{",
        isPackaged: true,
      });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBeNull();
      // before-ready emits all defaults; init has no delta (corrupt file ignored)
      expect(events).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // config-set-values / "set"
  // ---------------------------------------------------------------------------
  describe('config-set-values / "set"', () => {
    it("merges values and persists to disk when persist=true (default)", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // First init to set defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Now set file-layer values (default persist=true)
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "opencode" } },
      } as ConfigSetValuesIntent);

      // Should have persisted to disk
      expect(fileSystem).toHaveFile(CONFIG_PATH);
      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed.agent).toBe("opencode");
    });

    it("persist=false does not write values to disk", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init to set defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Take snapshot of filesystem state
      const snapshotBefore = fileSystem.$.snapshot();

      // Dispatch with persist=false — should NOT touch disk
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: {
          values: { "test.level": "debug", "test.enum": "never" },
          persist: false,
        },
      } as ConfigSetValuesIntent);

      // Filesystem should not have changed
      const snapshotAfter = fileSystem.$.snapshot();
      expect(snapshotAfter).toEqual(snapshotBefore);
    });

    it("returns changed values only via config:updated event", async () => {
      const { dispatcher } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init to set defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Collect events for the subsequent dispatch
      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      // Set only agent
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "claude" } },
      } as ConfigSetValuesIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values.agent).toBe("claude");
      expect(events[0]!.payload.values["test.nullable"]).toBeUndefined();
    });

    it("persist=true always writes to disk (read-modify-write)", async () => {
      const { dispatcher, fileSystem } = createTestSetup({ isPackaged: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init sets defaults (no config file → no file write)
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Dispatch with persist=true — should write config.json
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: "claude" } },
      } as ConfigSetValuesIntent);

      expect(fileSystem).toHaveFile(CONFIG_PATH);
      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed.agent).toBe("claude");
    });

    it("writes only dispatched keys to disk (flat format)", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init to set baseline
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Set a file-layer value
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: {
          values: {
            agent: "claude",
            "test.string": "custom-val",
            "test.dev-flag": false,
          },
        },
      } as ConfigSetValuesIntent);

      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Should be flat format with only the dispatched keys
      expect(parsed["agent"]).toBe("claude");
      expect(parsed["test.string"]).toBe("custom-val");
      expect(parsed["test.dev-flag"]).toBe(false);

      // Should not contain keys that were not in the dispatch
      expect(parsed["test.level"]).toBeUndefined();
      expect(parsed["test.enum"]).toBeUndefined();
      expect(parsed["test.optional"]).toBeUndefined();
    });

    it("does not emit config:updated when no values actually changed", async () => {
      const { dispatcher } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init to set defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Subscribe after init to only capture subsequent events
      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      // Set same default values -- no actual change
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { agent: null } },
      } as ConfigSetValuesIntent);

      expect(events).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Precedence
  // ---------------------------------------------------------------------------
  describe("precedence", () => {
    it("CLI override takes precedence over file layer", async () => {
      // Config file sets agent to claude, CLI overrides to opencode.
      const configContent = JSON.stringify({ agent: "claude" });

      const { dispatcher } = createTestSetup({
        configFileContent: configContent,
        argv: ["--agent=opencode"],
      });

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      // CLI override should win over file
      expect(result.configuredAgent).toBe("opencode");
    });

    it("env var takes precedence over file defaults", async () => {
      // No config file, env sets test.level to silly (overrides default "warn")
      const { dispatcher } = createTestSetup({
        noConfigFile: true,
        isPackaged: true,
        env: { CH_TEST__LEVEL: "silly" },
      });

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Env var should override the default "warn"
      const levelEvent = events.find((e) => e.payload.values["test.level"] !== undefined);
      expect(levelEvent).toBeDefined();
      expect(levelEvent!.payload.values["test.level"]).toBe("silly");
    });
  });

  // ---------------------------------------------------------------------------
  // Computed defaults
  // ---------------------------------------------------------------------------
  describe("computed defaults", () => {
    it("isDevelopment=true sets computed defaults", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // before-ready dispatches computed defaults as delta
      const devFlagEvent = events.find((e) => e.payload.values["test.dev-flag"] !== undefined);
      expect(devFlagEvent).toBeDefined();
      expect(devFlagEvent!.payload.values["test.dev-flag"]).toBe(false);

      const levelEvent = events.find((e) => e.payload.values["test.level"] !== undefined);
      expect(levelEvent).toBeDefined();
      expect(levelEvent!.payload.values["test.level"]).toBe("debug");
    });

    it("isPackaged=false sets test.dev-flag=false even when not dev", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: false,
        isPackaged: false,
      });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const devFlagEvent = events.find((e) => e.payload.values["test.dev-flag"] !== undefined);
      expect(devFlagEvent).toBeDefined();
      expect(devFlagEvent!.payload.values["test.dev-flag"]).toBe(false);
    });

    it("isPackaged=true and isDevelopment=false emits all defaults then no init delta", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: false, isPackaged: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // before-ready emits all keys (including static defaults); init has no delta
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values).toHaveProperty("test.string");
    });

    it("config file overrides computed defaults", async () => {
      const configContent = JSON.stringify({
        "test.dev-flag": true,
      });

      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        configFileContent: configContent,
      });

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Event 1: before-ready sets computed defaults (test.level=debug, test.dev-flag=false)
      // Event 2: init delta — file's test.dev-flag=true overrides computed false
      expect(events).toHaveLength(2);
      // before-ready event has computed defaults
      expect(events[0]!.payload.values["test.level"]).toBe("debug");
      expect(events[0]!.payload.values["test.dev-flag"]).toBe(false);
      // init event has file override
      expect(events[1]!.payload.values["test.dev-flag"]).toBe(true);
    });

    it("CLI flag overrides computed defaults", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        argv: ["--test.level=error"],
      });

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // CLI override should win over computed default
      const levelEvent = events.find((e) => e.payload.values["test.level"] !== undefined);
      expect(levelEvent).toBeDefined();
      expect(levelEvent!.payload.values["test.level"]).toBe("error");
    });
  });

  // ---------------------------------------------------------------------------
  // --help flag
  // ---------------------------------------------------------------------------
  describe("--help flag", () => {
    it("prints help text to stdout and dispatches app:shutdown", async () => {
      const { dispatcher, stdout } = createTestSetup({ argv: ["--help"] });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(stdout.write).toHaveBeenCalledOnce();
      const output = stdout.write.mock.calls[0]![0] as string;
      expect(output).toContain("CodeHydra Configuration");
      expect(output).toContain(CONFIG_PATH.toString());
    });

    it("shows computed defaults in help output (isDevelopment)", async () => {
      const { dispatcher, stdout } = createTestSetup({
        isDevelopment: true,
        argv: ["--help"],
      });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      const output = stdout.write.mock.calls[0]![0] as string;
      // isDevelopment=true computes test.level=debug (not static default "warn")
      expect(output).toContain("test.level");
      expect(output).toMatch(/test\.level\s+default:\s+debug/);
    });

    it("CH_HELP=1 env var prints help and dispatches shutdown", async () => {
      const { dispatcher, stdout } = createTestSetup({ env: { CH_HELP: "1" } });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(stdout.write).toHaveBeenCalledOnce();
      const output = stdout.write.mock.calls[0]![0] as string;
      expect(output).toContain("CodeHydra Configuration");
    });

    it("does not print help or dispatch shutdown when --help is not set", async () => {
      const { dispatcher, stdout } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());
      dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(stdout.write).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // generateHelpText
  // ---------------------------------------------------------------------------
  describe("generateHelpText", () => {
    const definitions = buildTestDefinitionsMap();
    const defaultValues: Record<string, unknown> = {};
    for (const [key, def] of definitions) {
      defaultValues[key] = def.default;
    }

    it("contains every config key", () => {
      const text = generateHelpText("/some/config.json", definitions, defaultValues);
      for (const key of ALL_TEST_KEYS) {
        expect(text).toContain(key);
      }
    });

    it("contains the config file path", () => {
      const text = generateHelpText("/custom/path/config.json", definitions, defaultValues);
      expect(text).toContain("/custom/path/config.json");
    });

    it("shows static defaults", () => {
      const text = generateHelpText("/some/config.json", definitions, defaultValues);
      expect(text).toContain("default: warn");
      expect(text).toContain("default: false");
      // test.dev-flag has default true (static)
      expect(text).toContain("default: true");
    });

    it("shows computed effective values when provided", () => {
      const computedDefaults = {
        ...defaultValues,
        "test.level": "debug",
        "test.dev-flag": false,
      };
      const text = generateHelpText("/some/config.json", definitions, computedDefaults);
      expect(text).toMatch(/test\.level\s+default:\s+debug/);
      expect(text).toMatch(/test\.dev-flag\s+default:\s+false/);
    });
  });
});
