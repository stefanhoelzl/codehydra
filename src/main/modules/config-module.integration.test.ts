// @vitest-environment node
/**
 * Integration tests for ConfigModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 * Covers all three hook points:
 * - app:start / "before-ready" -- reads env vars, dispatches config:set-values
 * - app:start / "init" -- reads config.json, dispatches config:set-values
 * - config-set-values / "set" -- merges values, persists if dirty, returns changes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { DEFAULT_CONFIG_VALUES, FILE_LAYER_KEYS } from "../../services/config/config-values";
import type { ConfigValues } from "../../services/config/config-values";
import {
  createFileSystemMock,
  file,
  directory,
} from "../../services/platform/filesystem.state-mock";
import { createConfigModule } from "./config-module";

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
  configFileContent?: string;
  noConfigFile?: boolean;
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
  });

  dispatcher.registerModule(module);

  return { fileSystem, hookRegistry, dispatcher, module };
}

// =============================================================================
// Tests
// =============================================================================

describe("ConfigModule Integration", () => {
  // ---------------------------------------------------------------------------
  // Environment variable cleanup
  // ---------------------------------------------------------------------------
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      CODEHYDRA_LOGLEVEL: process.env.CODEHYDRA_LOGLEVEL,
      CODEHYDRA_PRINT_LOGS: process.env.CODEHYDRA_PRINT_LOGS,
      CODEHYDRA_LOGGER: process.env.CODEHYDRA_LOGGER,
      CODEHYDRA_ELECTRON_FLAGS: process.env.CODEHYDRA_ELECTRON_FLAGS,
    };
    // Clear all env vars to avoid pollution
    delete process.env.CODEHYDRA_LOGLEVEL;
    delete process.env.CODEHYDRA_PRINT_LOGS;
    delete process.env.CODEHYDRA_LOGGER;
    delete process.env.CODEHYDRA_ELECTRON_FLAGS;
  });

  afterEach(() => {
    // Restore original values
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // app-start / "before-ready"
  // ---------------------------------------------------------------------------
  describe('app-start / "before-ready"', () => {
    it("sets log.level to debug when isDevelopment is true and no CODEHYDRA_LOGLEVEL set", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      const result = await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(result).toEqual({});
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.level"]).toBe("debug");
    });

    it("parses CODEHYDRA_LOGLEVEL env var", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "silly";

      const { dispatcher } = createTestSetup({ isDevelopment: false });

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

    it("CODEHYDRA_LOGLEVEL overrides isDevelopment default", async () => {
      process.env.CODEHYDRA_LOGLEVEL = "error";

      const { dispatcher } = createTestSetup({ isDevelopment: true });

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

    it("sets log.console when CODEHYDRA_PRINT_LOGS is set", async () => {
      process.env.CODEHYDRA_PRINT_LOGS = "1";

      const { dispatcher } = createTestSetup();

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.console"]).toBe(true);
    });

    it("sets log.filter when CODEHYDRA_LOGGER is set", async () => {
      process.env.CODEHYDRA_LOGGER = "git,process";

      const { dispatcher } = createTestSetup();

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.values["log.filter"]).toBe("git,process");
    });

    it("sets electron.flags when CODEHYDRA_ELECTRON_FLAGS is set", async () => {
      process.env.CODEHYDRA_ELECTRON_FLAGS = "--disable-gpu";

      const { dispatcher } = createTestSetup();

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

    it("does not dispatch config:set-values when no env vars are set and not development", async () => {
      const { dispatcher } = createTestSetup({ isDevelopment: false });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalBeforeReadyOperation());

      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // No env vars set, no isDevelopment -- nothing to dispatch
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
        "versions.codeServer": "4.200.0",
        "telemetry.enabled": false,
      });

      const { dispatcher } = createTestSetup({ configFileContent: configContent });

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
      expect(events[0]!.payload.values["telemetry.enabled"]).toBe(false);
      expect(events[0]!.payload.values["versions.codeServer"]).toBe("4.200.0");
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
      const { dispatcher } = createTestSetup({ noConfigFile: true });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      // configuredAgent should be null (default)
      expect(result.configuredAgent).toBeNull();

      // Defaults match the initial effective config, so no config:updated event
      // is emitted (computeChanges finds no differences).
      // The important assertion is that no error propagates and configuredAgent is null.
      expect(events).toHaveLength(0);
    });

    it("uses defaults when config.json is corrupt JSON", async () => {
      const { dispatcher } = createTestSetup({
        configFileContent: "not valid json {{{",
      });

      const events: ConfigUpdatedEvent[] = [];
      dispatcher.subscribe(EVENT_CONFIG_UPDATED, (e) => events.push(e as ConfigUpdatedEvent));

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      const result = (await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent)) as unknown as { configuredAgent?: string | null };

      // Falls back to defaults -- configuredAgent is null
      expect(result.configuredAgent).toBeNull();

      // Defaults match the initial effective config, so no config:updated event
      // is emitted (no changes detected). The key assertion is that corrupt JSON
      // does not propagate as an error.
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

      // Only values that differ from defaults appear in the changed set.
      // versions.opencode is null in both legacy config and defaults, so it is excluded.
      const values = events[0]!.payload.values;
      expect(values.agent).toBe("claude");
      expect(values["versions.claude"]).toBe("1.0.0");
      expect(values["versions.codeServer"]).toBe("4.150.0");
      expect(values["telemetry.enabled"]).toBe(false);
      expect(values["telemetry.distinctId"]).toBe("user-123");
      // versions.opencode is null (same as default), so not in changed values
      expect(values["versions.opencode"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // config-set-values / "set"
  // ---------------------------------------------------------------------------
  describe('config-set-values / "set"', () => {
    it("merges file-layer values and persists if changed", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // First init to set defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Now set file-layer values
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

    it("merges env-layer values without persisting", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init to set defaults and establish lastPersistedJson
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Take snapshot of filesystem state
      const snapshotBefore = fileSystem.$.snapshot();

      // Now set env-layer values (should NOT persist)
      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: { "log.level": "debug" as const, "log.console": true } },
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
      // Only agent changed (from null to "claude")
      expect(events[0]!.payload.values.agent).toBe("claude");
      // Other file-layer values should not be in the changed set
      // since they match the defaults established by init
      expect(events[0]!.payload.values["versions.codeServer"]).toBeUndefined();
    });

    it("dirty check: does not write to disk when values have not changed", async () => {
      const { dispatcher, fileSystem } = createTestSetup();

      dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation());

      // Init sets defaults
      await dispatcher.dispatch({
        type: INTENT_APP_START,
        payload: {},
      } as AppStartIntent);

      // Take snapshot after init
      const snapshotAfterInit = fileSystem.$.snapshot();

      // Dispatch same defaults again -- should not write to disk
      const defaultFileValues: Partial<ConfigValues> = {};
      for (const key of FILE_LAYER_KEYS) {
        (defaultFileValues as Record<string, unknown>)[key] = DEFAULT_CONFIG_VALUES[key];
      }

      await dispatcher.dispatch({
        type: INTENT_CONFIG_SET_VALUES,
        payload: { values: defaultFileValues },
      } as ConfigSetValuesIntent);

      // Snapshot should be unchanged (no new write to disk)
      const snapshotAfterRedispatch = fileSystem.$.snapshot();
      expect(snapshotAfterRedispatch).toEqual(snapshotAfterInit);
    });

    it("writes flat format JSON to disk", async () => {
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
            "versions.claude": "2.0.0",
            "telemetry.enabled": false,
          },
        },
      } as ConfigSetValuesIntent);

      const content = await fileSystem.readFile(CONFIG_PATH);
      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Should be flat format (dot-separated keys), NOT nested
      expect(parsed).toHaveProperty("agent", "claude");
      expect(parsed).toHaveProperty("versions.claude", "2.0.0");
      expect(parsed).toHaveProperty("telemetry.enabled", false);
      expect(parsed).toHaveProperty("versions.codeServer");

      // Should NOT have nested structure
      expect(parsed).not.toHaveProperty("versions");
      expect(parsed).not.toHaveProperty("telemetry");

      // Should not contain env-layer keys
      expect(parsed).not.toHaveProperty("log.level");
      expect(parsed).not.toHaveProperty("log.console");
      expect(parsed).not.toHaveProperty("electron.flags");
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

      // No event should have been emitted since agent was already null
      expect(events).toHaveLength(0);
    });
  });
});
