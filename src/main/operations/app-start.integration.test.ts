// @vitest-environment node
/**
 * Integration tests for app:start operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook execution.
 *
 * Test plan items covered:
 * #1: start hook runs before activate hook
 * #2: start abort on CodeServer failure
 * #3: start abort on MCP failure (non-optional)
 * #4: activate hook failure propagates
 * #5: PluginServer graceful degradation
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import { AppStartOperation, INTENT_APP_START, APP_START_OPERATION_ID } from "./app-start";
import type { AppStartIntent, AppStartHookContext } from "./app-start";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";

// =============================================================================
// Test Setup
// =============================================================================

interface TestState {
  codeServerStarted: boolean;
  mcpStarted: boolean;
  dataLoaded: boolean;
  viewActivated: boolean;
  /** Tracks ordering: modules append their name when they run */
  executionOrder: string[];
}

function createTestState(): TestState {
  return {
    codeServerStarted: false,
    mcpStarted: false,
    dataLoaded: false,
    viewActivated: false,
    executionOrder: [],
  };
}

function createCodeServerModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (ctx: HookContext) => {
            if (options?.fail) {
              throw new Error("CodeServer failed to start");
            }
            state.codeServerStarted = true;
            state.executionOrder.push("codeserver-start");
            (ctx as AppStartHookContext).codeServerPort = 8080;
          },
        },
      },
    },
  };
}

function createMcpModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (ctx: HookContext) => {
            if (options?.fail) {
              throw new Error("MCP server failed to start");
            }
            state.mcpStarted = true;
            state.executionOrder.push("mcp-start");
            (ctx as AppStartHookContext).mcpPort = 9090;
          },
        },
      },
    },
  };
}

function createDataModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (ctx: HookContext) => {
            if (options?.fail) {
              throw new Error("Failed to load persisted projects");
            }
            // Verify start hook set context
            const hookCtx = ctx as AppStartHookContext;
            if (hookCtx.codeServerPort) {
              state.dataLoaded = true;
              state.executionOrder.push("data-activate");
            }
          },
        },
      },
    },
  };
}

function createViewModule(state: TestState): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async () => {
            state.viewActivated = true;
            state.executionOrder.push("view-activate");
          },
        },
      },
    },
  };
}

/**
 * Simulates PluginServer graceful degradation inside CodeServerModule.
 * In the real implementation, CodeServerModule tries to start PluginServer
 * internally and catches its error, then starts code-server without the plugin port.
 */
function createCodeServerModuleWithGracefulPluginDegradation(
  state: TestState,
  pluginFails: boolean
): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (ctx: HookContext) => {
            // Simulate PluginServer start attempt (internal try/catch)
            let pluginPort: number | undefined;
            try {
              if (pluginFails) {
                throw new Error("PluginServer failed to bind");
              }
              pluginPort = 3000;
            } catch {
              // Graceful degradation -- PluginServer is optional
              pluginPort = undefined;
            }

            // Code-server starts regardless
            state.codeServerStarted = true;
            state.executionOrder.push("codeserver-start");
            (ctx as AppStartHookContext).codeServerPort = 8080;
            void pluginPort; // Used for code-server config in real impl
          },
        },
      },
    },
  };
}

function createTestSetup(modules: IntentModule[]): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  wireModules(modules, hookRegistry, dispatcher);

  return { dispatcher };
}

function appStartIntent(): AppStartIntent {
  return {
    type: INTENT_APP_START,
    payload: {} as AppStartIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("AppStart Operation", () => {
  describe("start hook runs before activate hook (#1)", () => {
    it("activate modules observe state set by start modules", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
      expect(state.dataLoaded).toBe(true);
      expect(state.viewActivated).toBe(true);

      // Verify ordering: start hooks before activate hooks
      expect(state.executionOrder).toEqual([
        "codeserver-start",
        "mcp-start",
        "data-activate",
        "view-activate",
      ]);
    });
  });

  describe("start abort on CodeServer failure (#2)", () => {
    it("propagates error and does not run activate hook", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModule(state, { fail: true }),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "CodeServer failed to start"
      );

      expect(state.codeServerStarted).toBe(false);
      // MCP is in the same hook but runs after CodeServer -- skipped due to ctx.error
      expect(state.mcpStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
      expect(state.viewActivated).toBe(false);
    });
  });

  describe("start abort on MCP failure (#3)", () => {
    it("propagates error, remaining start modules skipped", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModule(state),
        createMcpModule(state, { fail: true }),
        createDataModule(state),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "MCP server failed to start"
      );

      // CodeServer ran before MCP
      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(false);
      // Activate hooks never ran
      expect(state.dataLoaded).toBe(false);
      expect(state.viewActivated).toBe(false);
    });
  });

  describe("activate hook failure propagates (#4)", () => {
    it("propagates error, no active workspace set", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state, { fail: true }),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "Failed to load persisted projects"
      );

      // Start hooks succeeded
      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
      // DataModule failed, ViewModule skipped by HookRegistry error propagation
      expect(state.dataLoaded).toBe(false);
      expect(state.viewActivated).toBe(false);
    });
  });

  describe("PluginServer graceful degradation (#5)", () => {
    it("CodeServerModule catches PluginServer error, startup succeeds", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModuleWithGracefulPluginDegradation(state, true),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      // Should not throw despite PluginServer failure
      await dispatcher.dispatch(appStartIntent());

      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
      expect(state.dataLoaded).toBe(true);
      expect(state.viewActivated).toBe(true);
    });
  });
});
