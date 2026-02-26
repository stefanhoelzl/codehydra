// @vitest-environment node
/**
 * Integration tests for ConfigModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers all three hook points:
 * - app:start / "before-ready" -- dispatches full merged config (defaults + computed + env + CLI)
 * - app:start / "init" -- reads config.json, dispatches only delta
 * - config-set-values / "set" -- merges values into effective, optionally persists to disk
 *
 * Also covers:
 * - parseEnvVars / parseCliArgs standalone
 * - Precedence (CLI > env > file > computed > defaults)
 * - Config file migration (old keys → new keys)
 */

import { describe, it, expect } from "vitest";
import { Path } from "../../services/platform/path";
import { SILENT_LOGGER } from "../../services/logging";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, ConfigureResult, InitHookContext } from "../operations/app-start";
import {
  ConfigSetValuesOperation,
  INTENT_CONFIG_SET_VALUES,
  EVENT_CONFIG_UPDATED,
} from "../operations/config-set-values";
import type { ConfigSetValuesIntent, ConfigUpdatedEvent } from "../operations/config-set-values";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../services/platform/filesystem.state-mock";
import { createConfigModule, parseEnvVars, parseCliArgs } from "./config-module";

// =============================================================================
// Minimal Test Operations
// =============================================================================

/**
 * Runs "before-ready" hook point only.
 * The before-ready hook dispatches config:set-values internally,
 * so the dispatcher must have ConfigSetValuesOperation registered.
 */
class MinimalBeforeReadyOperation implements Operation<Intent, ConfigureResult> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<ConfigureResult> {
    const { results, errors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
      intent: ctx.intent,
    });
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
 * Runs "init" hook point only.
 * The init hook dispatches config:set-values internally.
 */
class MinimalInitOperation implements Operation<Intent, { configuredAgent?: string | null }> {
  readonly id = APP_START_OPERATION_ID;
  async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
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
  });

  dispatcher.registerModule(module);

  return { fileSystem, hookRegistry, dispatcher, module };
}

// =============================================================================
// Tests
// =============================================================================

describe("ConfigModule Integration", () => {
  // ---------------------------------------------------------------------------
  // parseEnvVars standalone
  // ---------------------------------------------------------------------------
  describe("parseEnvVars", () => {
    it("maps CH_LOG__LEVEL to log.level", () => {
      const result = parseEnvVars({ CH_LOG__LEVEL: "debug" });
      expect(result["log.level"]).toBe("debug");
    });

    it("maps CH_LOG__OUTPUT to log.output", () => {
      const result = parseEnvVars({ CH_LOG__OUTPUT: "console" });
      expect(result["log.output"]).toBe("console");
    });

    it("parses combined CH_LOG__LEVEL with filter", () => {
      const result = parseEnvVars({ CH_LOG__LEVEL: "debug:git,process" });
      expect(result["log.level"]).toBe("debug:git,process");
    });

    it("maps CH_ELECTRON__FLAGS to electron.flags", () => {
      const result = parseEnvVars({ CH_ELECTRON__FLAGS: "--disable-gpu" });
      expect(result["electron.flags"]).toBe("--disable-gpu");
    });

    it("maps CH_VERSION__CODE_SERVER to version.code-server", () => {
      const result = parseEnvVars({ CH_VERSION__CODE_SERVER: "5.0.0" });
      expect(result["version.code-server"]).toBe("5.0.0");
    });

    it("maps CH_TELEMETRY__DISTINCT_ID to telemetry.distinct-id", () => {
      const result = parseEnvVars({ CH_TELEMETRY__DISTINCT_ID: "user-abc" });
      expect(result["telemetry.distinct-id"]).toBe("user-abc");
    });

    it("ignores _CH_ prefixed vars (internal)", () => {
      const result = parseEnvVars({ _CH_INTERNAL: "value" });
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("ignores non-CH_ vars", () => {
      const result = parseEnvVars({ HOME: "/home/user", PATH: "/usr/bin" });
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("throws on unknown CH_ env var", () => {
      expect(() => parseEnvVars({ CH_UNKNOWN_VAR: "value" })).toThrow(/Unknown config env var/);
    });

    it("skips invalid values without throwing", () => {
      const result = parseEnvVars({ CH_LOG__LEVEL: "not-a-level" });
      expect(result["log.level"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // parseCliArgs standalone
  // ---------------------------------------------------------------------------
  describe("parseCliArgs", () => {
    it("parses --key=value format", () => {
      const result = parseCliArgs(["--log.level=debug"]);
      expect(result["log.level"]).toBe("debug");
    });

    it("parses --key value format", () => {
      const result = parseCliArgs(["--log.level", "debug"]);
      expect(result["log.level"]).toBe("debug");
    });

    it("parses --log.output flag", () => {
      const result = parseCliArgs(["--log.output=console"]);
      expect(result["log.output"]).toBe("console");
    });

    it("ignores unknown flags silently", () => {
      const result = parseCliArgs(["--unknown-flag=value"]);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("parses multiple flags", () => {
      const result = parseCliArgs(["--log.level=debug", "--log.output=console", "--agent=claude"]);
      expect(result["log.level"]).toBe("debug");
      expect(result["log.output"]).toBe("console");
      expect(result.agent).toBe("claude");
    });
  });

  // ---------------------------------------------------------------------------
  // app-start / "before-ready"
  // ---------------------------------------------------------------------------
  describe('app-start / "before-ready"', () => {
    it("dispatches full merged config including computed defaults (isDevelopment)", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(result).toEqual({});
      // Computed defaults differ from static defaults → config:updated emitted
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("debug");
      expect(events[0]!.payload.values["telemetry.enabled"]).toBe(false);
    });

    it("parses CH_LOG__LEVEL env var", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: false,
        env: { CH_LOG__LEVEL: "silly" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("silly");
    });

    it("CH_LOG__LEVEL overrides isDevelopment default", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        env: { CH_LOG__LEVEL: "error" },
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("error");
    });

    it("sets log.output from CH_LOG__OUTPUT env var", async () => {
      const { dispatcher } = createTestSetup({ env: { CH_LOG__OUTPUT: "console" } });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.output"]).toBe("console");
    });

    it("sets combined log.level with filter from CH_LOG__LEVEL env var", async () => {
      const { dispatcher } = createTestSetup({ env: { CH_LOG__LEVEL: "debug:git,process" } });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("debug:git,process");
    });

    it("sets electron.flags from CH_ELECTRON__FLAGS env var", async () => {
      const { dispatcher } = createTestSetup({ env: { CH_ELECTRON__FLAGS: "--disable-gpu" } });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["electron.flags"]).toBe("--disable-gpu");
    });

    it("CLI flags override env vars", async () => {
      const { dispatcher } = createTestSetup({
        env: { CH_LOG__LEVEL: "silly" },
        argv: ["--log.level=error"],
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("error");
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

    it("no config:updated when merged config matches defaults (production)", async () => {
      // isPackaged=true + isDevelopment=false → no computed defaults differ from static defaults
      const { dispatcher } = createTestSetup({ isDevelopment: false, isPackaged: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Dispatch happens but no values changed → no config:updated event
      expect(events).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // app-start / "init"
  // ---------------------------------------------------------------------------
  describe('app-start / "init"', () => {
    it("reads config.json from disk and dispatches config:set-values with file values", async () => {
      const configContent = JSON.stringify({
        agent: "claude",
        "version.code-server": "4.200.0",
        "telemetry.enabled": true,
      });

      // Use isPackaged=true so telemetry.enabled defaults to true (static default)
      const { dispatcher } = createTestSetup({
        configFileContent: configContent,
        isPackaged: true,
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBe("claude");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values.agent).toBe("claude");
      expect(events[0]!.payload.values["version.code-server"]).toBe("4.200.0");
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

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBeNull();
      expect(events).toHaveLength(0);
    });

    it("uses defaults when config.json is corrupt JSON", async () => {
      // Use isPackaged=true so computed defaults don't interfere
      const { dispatcher } = createTestSetup({
        configFileContent: "not valid json {{{",
        isPackaged: true,
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBeNull();
      expect(events).toHaveLength(0);
    });

    it("handles legacy nested format (backwards compat)", async () => {
      const legacyConfig = JSON.stringify({
        agent: "claude",
        versions: {
          claude: "1.0.0",
          opencode: null,
          codeServer: "4.150.0",
        },
        telemetry: {
          enabled: false,
          distinctId: "user-123",
        },
      });

      const { dispatcher } = createTestSetup({ configFileContent: legacyConfig });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      expect(result.configuredAgent).toBe("claude");
      expect(events).toHaveLength(1);

      const values = events[0]!.payload.values;
      expect(values.agent).toBe("claude");
      expect(values["version.claude"]).toBe("1.0.0");
      expect(values["version.code-server"]).toBe("4.150.0");
      expect(values["telemetry.distinct-id"]).toBe("user-123");
      // version.opencode is null (same as default), so not in changed values
      expect(values["version.opencode"]).toBeUndefined();
    });

    it("migrates old flat key names to new names", async () => {
      const oldFlatConfig = JSON.stringify({
        agent: "claude",
        "versions.codeServer": "4.200.0",
        "versions.claude": "1.5.0",
        "versions.opencode": null,
        "telemetry.enabled": true,
        "telemetry.distinctId": "user-456",
      });

      const { dispatcher, fileSystem } = createTestSetup({ configFileContent: oldFlatConfig });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      const values = events[0]!.payload.values;
      expect(values["version.code-server"]).toBe("4.200.0");
      expect(values["version.claude"]).toBe("1.5.0");
      expect(values["telemetry.distinct-id"]).toBe("user-456");

      // Migration should have persisted new key names to disk
      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;
      // Use bracket notation — toHaveProperty("a.b") does nested lookup
      expect(parsed["version.code-server"]).toBe("4.200.0");
      expect(parsed["version.claude"]).toBe("1.5.0");
      expect(parsed["telemetry.distinct-id"]).toBe("user-456");
      // Old keys should NOT be present
      expect(parsed["versions.codeServer"]).toBeUndefined();
      expect(parsed["telemetry.distinctId"]).toBeUndefined();
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
          values: { "log.level": "debug", "log.output": "console" },
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
      expect(events[0]!.payload.values["version.code-server"]).toBeUndefined();
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

    it("writes flat format JSON to disk with new key names", async () => {
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
            "version.claude": "2.0.0",
            "telemetry.enabled": false,
          },
        },
      } as ConfigSetValuesIntent);

      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Should be flat format with only the dispatched keys
      expect(parsed["agent"]).toBe("claude");
      expect(parsed["version.claude"]).toBe("2.0.0");
      expect(parsed["telemetry.enabled"]).toBe(false);

      // Should NOT have nested structure or old key names
      expect(parsed["versions"]).toBeUndefined();
      expect(parsed["versions.codeServer"]).toBeUndefined();

      // Should not contain keys that were not in the dispatch
      expect(parsed["log.level"]).toBeUndefined();
      expect(parsed["log.output"]).toBeUndefined();
      expect(parsed["electron.flags"]).toBeUndefined();
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
      // Use a combined operation that runs both before-ready and init.
      const configContent = JSON.stringify({ agent: "claude" });

      const { dispatcher } = createTestSetup({
        configFileContent: configContent,
        argv: ["--agent=opencode"],
      });

      // Combined operation: before-ready then init
      class CombinedStartOperation implements Operation<
        Intent,
        { configuredAgent?: string | null }
      > {
        readonly id = APP_START_OPERATION_ID;
        async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
          // before-ready
          const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
            intent: ctx.intent,
          });
          if (brErrors.length > 0) throw brErrors[0]!;

          // init
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

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      // CLI override should win over file
      expect(result.configuredAgent).toBe("opencode");
    });

    it("env var takes precedence over file defaults", async () => {
      // No config file, env sets log.level to silly (overrides default "warn")
      const { dispatcher } = createTestSetup({
        noConfigFile: true,
        env: { CH_LOG__LEVEL: "silly" },
      });

      // Combined operation
      class CombinedStartOperation implements Operation<
        Intent,
        { configuredAgent?: string | null }
      > {
        readonly id = APP_START_OPERATION_ID;
        async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
          const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
            intent: ctx.intent,
          });
          if (brErrors.length > 0) throw brErrors[0]!;

          const initCtx: InitHookContext = { intent: ctx.intent, requiredScripts: [] };
          const { errors } = await ctx.hooks.collect<{ configuredAgent?: string | null }>(
            "init",
            initCtx
          );
          if (errors.length > 0) throw errors[0]!;
          return {};
        }
      }

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Env var should override the default "warn"
      const logLevelEvent = events.find((e) => e.payload.values["log.level"] !== undefined);
      expect(logLevelEvent).toBeDefined();
      expect(logLevelEvent!.payload.values["log.level"]).toBe("silly");
    });
  });

  // ---------------------------------------------------------------------------
  // Computed defaults
  // ---------------------------------------------------------------------------
  describe("computed defaults", () => {
    it("isDevelopment=true: effective telemetry.enabled=false and log.level=debug", async () => {
      // Computed defaults set telemetry.enabled=false and log.level=debug.
      // Verify via config:updated event from init (which applies computed defaults).
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Init dispatches delta: computed defaults differ from static defaults
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["telemetry.enabled"]).toBe(false);
      expect(events[0]!.payload.values["log.level"]).toBe("debug");
    });

    it("isPackaged=false sets telemetry.enabled=false even when not dev", async () => {
      const { dispatcher } = createTestSetup({
        isDevelopment: false,
        isPackaged: false,
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Init dispatches delta: computed telemetry.enabled=false differs from static default true
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["telemetry.enabled"]).toBe(false);
    });

    it("isPackaged=true and isDevelopment=false leaves telemetry.enabled=true (static default)", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: false, isPackaged: true });

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // No computed defaults override telemetry.enabled, and file defaults match static defaults.
      // No changes should be emitted.
      expect(events).toHaveLength(0);
    });

    it("config file overrides computed defaults", async () => {
      // isDevelopment=true sets computed telemetry.enabled=false + log.level=debug.
      // Config file sets telemetry.enabled=true which overrides computed false.
      const configContent = JSON.stringify({
        "telemetry.enabled": true,
      });

      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        configFileContent: configContent,
      });

      // Combined operation: before-ready sets computed defaults, init loads file
      class CombinedStartOperation implements Operation<
        Intent,
        { configuredAgent?: string | null }
      > {
        readonly id = APP_START_OPERATION_ID;
        async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
          const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
            intent: ctx.intent,
          });
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

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Event 1: before-ready sets computed defaults (log.level=debug, telemetry.enabled=false)
      // Event 2: init delta — file's telemetry.enabled=true overrides computed false
      expect(events).toHaveLength(2);
      // before-ready event has computed defaults
      expect(events[0]!.payload.values["log.level"]).toBe("debug");
      expect(events[0]!.payload.values["telemetry.enabled"]).toBe(false);
      // init event has file override
      expect(events[1]!.payload.values["telemetry.enabled"]).toBe(true);
    });

    it("CLI flag overrides computed defaults", async () => {
      // isDevelopment=true sets computed log.level=debug,
      // CLI --log.level=error should override it.
      const { dispatcher } = createTestSetup({
        isDevelopment: true,
        argv: ["--log.level=error"],
      });

      // Combined operation: before-ready then init
      class CombinedStartOperation implements Operation<
        Intent,
        { configuredAgent?: string | null }
      > {
        readonly id = APP_START_OPERATION_ID;
        async execute(ctx: OperationContext<Intent>): Promise<{ configuredAgent?: string | null }> {
          const { errors: brErrors } = await ctx.hooks.collect<ConfigureResult>("before-ready", {
            intent: ctx.intent,
          });
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

      dispatcher.registerOperation(INTENT_APP_START, new CombinedStartOperation());

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // CLI override should win over computed default
      const logLevelEvent = events.find((e) => e.payload.values["log.level"] !== undefined);
      expect(logLevelEvent).toBeDefined();
      expect(logLevelEvent!.payload.values["log.level"]).toBe("error");
    });
  });
});
