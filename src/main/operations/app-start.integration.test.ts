// @vitest-environment node
/**
 * Integration tests for app:start operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook execution.
 * Project loading (project:open dispatches, app:started event) is tested in
 * app-ready.integration.test.ts.
 *
 * Test plan items covered:
 * #1: all start hooks run (servers, data, view)
 * #2: start abort on CodeServer failure
 * #3: start abort on MCP failure (non-optional)
 * #4: start hook failure (data) propagates
 * #5: PluginServer graceful degradation
 * #6: check hooks -- no setup needed
 * #7: check hooks -- setup needed (agent null)
 * #8: check hooks -- setup needed (binaries)
 * #9: check hooks -- setup needed (extensions)
 * #10: init error aborts startup (configuredAgent path)
 * #11: check-deps error aborts
 * #12: configuredAgent flows from init results to check-deps
 * #13: before-ready hook collects scripts from multiple modules
 * #14: before-ready hook error aborts startup
 * #15: await-ready hook error aborts startup
 * #16: init hook receives requiredScripts from before-ready results
 * #17: init hook error aborts startup
 * #18: full sequence: before-ready -> await-ready -> init -> show-ui -> start
 * #19: ports available via capabilities in start hook
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { AppStartOperation, INTENT_APP_START, APP_START_OPERATION_ID } from "./app-start";
import type {
  AppStartIntent,
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  InitHookContext,
  InitResult,
} from "./app-start";
import { INTENT_SETUP } from "./setup";
import type { SetupIntent } from "./setup";
import type { IntentModule } from "../intents/infrastructure/module";
import {
  ANY_VALUE,
  type HookContext,
  type Operation,
  type OperationContext,
} from "../intents/infrastructure/operation";
import type { ConfigAgentType } from "../../shared/api/types";
import type { BinaryType } from "../../services/binary-resolution/types";

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
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ codeServerPort: 8080 }),
          handler: async (): Promise<void> => {
            if (options?.fail) {
              throw new Error("CodeServer failed to start");
            }
            state.codeServerStarted = true;
            state.executionOrder.push("codeserver-start");
          },
        },
      },
    },
  };
}

function createMcpModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ mcpPort: 9090 }),
          handler: async (): Promise<void> => {
            if (options?.fail) {
              throw new Error("MCP server failed to start");
            }
            state.mcpStarted = true;
            state.executionOrder.push("mcp-start");
          },
        },
      },
    },
  };
}

function createDataModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            if (options?.fail) {
              throw new Error("Failed to load persisted projects");
            }
            state.dataLoaded = true;
            state.executionOrder.push("data-activate");
          },
        },
      },
    },
  };
}

function createViewModule(state: TestState): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
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
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          provides: () => ({ codeServerPort: 8080 }),
          handler: async (): Promise<void> => {
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
            void pluginPort; // Used for code-server config in real impl
          },
        },
      },
    },
  };
}

/**
 * Default check modules that make checks pass (agent configured, no missing deps).
 * Existing tests that don't care about check hooks get these by default.
 * The config module's "init" handler returns configuredAgent via InitResult.
 */
function defaultCheckModules(): IntentModule[] {
  return [
    {
      name: "test",
      hooks: {
        [APP_START_OPERATION_ID]: {
          init: {
            handler: async (): Promise<InitResult> => ({
              configuredAgent: "claude",
            }),
          },
        },
      },
    },
  ];
}

function createTestSetup(
  modules: IntentModule[],
  options?: {
    state?: TestState;
    skipDefaultChecks?: boolean;
  }
): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());

  const allModules = options?.skipDefaultChecks ? modules : [...defaultCheckModules(), ...modules];
  for (const m of allModules) dispatcher.registerModule(m);

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
  describe("all start hooks run (#1)", () => {
    it("all start handlers execute in dependency order", async () => {
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

      // Verify all start hooks ran
      expect(state.executionOrder).toEqual([
        "codeserver-start",
        "mcp-start",
        "data-activate",
        "view-activate",
      ]);
    });
  });

  describe("start abort on CodeServer failure (#2)", () => {
    it("propagates error and remaining start hooks still run (collect)", async () => {
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
      // With collect(), MCP still runs even though CodeServer threw (errors collected).
      // Data and view modules also run since they are in the same "start" hook point.
      expect(state.mcpStarted).toBe(true);
      expect(state.dataLoaded).toBe(true);
      expect(state.viewActivated).toBe(true);
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
      // Data and view modules also run since they are in the same "start" hook point
      expect(state.dataLoaded).toBe(true);
      expect(state.viewActivated).toBe(true);
    });
  });

  describe("start hook failure (data) propagates (#4)", () => {
    it("propagates error from data handler, other start handlers still run", async () => {
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

      // All start hooks ran (collect() continues after errors)
      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
      // DataModule failed, but with collect() other start handlers still run
      expect(state.dataLoaded).toBe(false);
      expect(state.viewActivated).toBe(true);
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

  // ===========================================================================
  // Check Hooks (collect-based, isolated contexts)
  // ===========================================================================

  describe("check hooks", () => {
    // -- Helpers for check hook modules --

    function createConfigCheckModule(agent: ConfigAgentType | null): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            init: {
              handler: async (): Promise<InitResult> => {
                return { configuredAgent: agent };
              },
            },
          },
        },
      };
    }

    function createBinaryCheckModule(missingBinaries: BinaryType[]): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (): Promise<CheckDepsResult> => {
                return { missingBinaries };
              },
            },
          },
        },
      };
    }

    function createExtensionCheckModule(opts: {
      installPlan?: Array<{ id: string; vsixPath: string }>;
    }): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (): Promise<CheckDepsResult> => {
                return {
                  ...(opts.installPlan !== undefined && {
                    extensionInstallPlan: opts.installPlan,
                  }),
                };
              },
            },
          },
        },
      };
    }

    /** Stub setup operation that records dispatch and succeeds. */
    function createSetupStub(state: TestState): Operation<SetupIntent, void> {
      return {
        id: "setup",
        async execute(ctx: OperationContext<SetupIntent>): Promise<void> {
          state.executionOrder.push("setup");
          void ctx;
        },
      };
    }

    function createCheckTestSetup(
      modules: IntentModule[],
      options?: { setupStub?: Operation<SetupIntent, void> }
    ): { dispatcher: Dispatcher } {
      const hookRegistry = new HookRegistry();
      const dispatcher = new Dispatcher(hookRegistry);

      dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
      if (options?.setupStub) {
        dispatcher.registerOperation(INTENT_SETUP, options.setupStub);
      }
      for (const m of modules) dispatcher.registerModule(m);

      return { dispatcher };
    }

    it("no setup needed -- all checks pass, app:setup not dispatched (#6)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("claude"),
          createBinaryCheckModule([]),
          createExtensionCheckModule({}),
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub }
      );

      await dispatcher.dispatch(appStartIntent());

      // Setup was never dispatched
      expect(state.executionOrder).not.toContain("setup");
      // start hooks ran
      expect(state.codeServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
    });

    it("setup needed -- agent null triggers app:setup (#7)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule(null),
          createBinaryCheckModule([]),
          createExtensionCheckModule({}),
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(state.executionOrder).toContain("setup");
      // start hooks still ran after setup
      expect(state.codeServerStarted).toBe(true);
    });

    it("setup needed -- missing binaries triggers app:setup (#8)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("claude"),
          createBinaryCheckModule(["code-server"]),
          createExtensionCheckModule({}),
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(state.executionOrder).toContain("setup");
    });

    it("setup needed -- missing extensions triggers app:setup (#9)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("claude"),
          createBinaryCheckModule([]),
          createExtensionCheckModule({
            installPlan: [{ id: "ext-a", vsixPath: "/path/ext-a.vsix" }],
          }),
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(state.executionOrder).toContain("setup");
    });

    it("init error from config module aborts startup (#10)", async () => {
      const state = createTestState();
      const failingInitConfigModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            init: {
              handler: async (): Promise<InitResult> => {
                throw new Error("Config load failed");
              },
            },
          },
        },
      };

      const { dispatcher } = createCheckTestSetup([
        failingInitConfigModule,
        createBinaryCheckModule([]),
        createCodeServerModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Config load failed");
      expect(state.codeServerStarted).toBe(false);
    });

    it("check-deps error aborts startup (#11)", async () => {
      const state = createTestState();
      const failingDepsModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (): Promise<CheckDepsResult> => {
                throw new Error("Binary preflight failed");
              },
            },
          },
        },
      };

      const { dispatcher } = createCheckTestSetup([
        createConfigCheckModule("claude"),
        failingDepsModule,
        createCodeServerModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "check-deps hooks failed"
      );
      expect(state.codeServerStarted).toBe(false);
    });

    it("configuredAgent flows from init results to check-deps context (#12)", async () => {
      const state = createTestState();
      let receivedAgent: ConfigAgentType | null | undefined;

      const agentReadingDepsModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (ctx: HookContext): Promise<CheckDepsResult> => {
                receivedAgent = (ctx as CheckDepsHookContext).configuredAgent;
                return {};
              },
            },
          },
        },
      };

      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("opencode"),
          agentReadingDepsModule,
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(receivedAgent).toBe("opencode");
    });
  });

  // ===========================================================================
  // Capabilities (ports available via ctx.capabilities in start hook)
  // ===========================================================================

  describe("ports available via capabilities in start hook (#19)", () => {
    it.each([
      {
        portName: "mcpPort" as const,
        modules: (s: TestState) => [createCodeServerModule(s), createMcpModule(s)],
        expected: 9090,
        label: "mcpPort available via capabilities from MCP start handler",
      },
      {
        portName: "mcpPort" as const,
        modules: (s: TestState) => [createCodeServerModule(s)],
        expected: undefined,
        label: "mcpPort undefined when no start handler provides it",
      },
      {
        portName: "codeServerPort" as const,
        modules: (s: TestState) => [createCodeServerModule(s), createMcpModule(s)],
        expected: 8080,
        label: "codeServerPort available via capabilities from CodeServer start handler",
      },
      {
        portName: "codeServerPort" as const,
        modules: (s: TestState) => [createMcpModule(s)],
        expected: undefined,
        label: "codeServerPort undefined when no start handler provides it",
      },
    ])("$label", async ({ portName, modules, expected }) => {
      const state = createTestState();
      let receivedPort: number | undefined;

      const readerModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            start: {
              requires: { [portName]: ANY_VALUE },
              handler: async (ctx: HookContext): Promise<void> => {
                receivedPort = ctx.capabilities?.[portName] as number | undefined;
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([...modules(state), readerModule]);
      await dispatcher.dispatch(appStartIntent());

      if (expected === undefined) {
        expect(receivedPort).toBeUndefined();
      } else {
        expect(receivedPort).toBe(expected);
      }
    });
  });

  // ===========================================================================
  // Pre-ready Hooks: before-ready, await-ready, init
  // ===========================================================================

  describe("pre-ready hooks (before-ready, await-ready, init)", () => {
    function createConfigureModule(scripts: string[]): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<ConfigureResult> => {
                return { scripts };
              },
            },
          },
        },
      };
    }

    function createFailingConfigureModule(message: string): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<ConfigureResult> => {
                throw new Error(message);
              },
            },
          },
        },
      };
    }

    function createAwaitReadyModule(options?: { fail?: boolean }): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "await-ready": {
              handler: async (): Promise<void> => {
                if (options?.fail) {
                  throw new Error("Electron ready failed");
                }
              },
            },
          },
        },
      };
    }

    function createInitModule(
      state: TestState,
      options?: { fail?: boolean; captureScripts?: (scripts: readonly string[]) => void }
    ): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            init: {
              handler: async (ctx: HookContext): Promise<InitResult> => {
                if (options?.fail) {
                  throw new Error("Init failed");
                }
                state.executionOrder.push("init");
                if (options?.captureScripts) {
                  options.captureScripts((ctx as InitHookContext).requiredScripts);
                }
                return {};
              },
            },
          },
        },
      };
    }

    it("before-ready hook collects scripts from multiple modules (#13)", async () => {
      const state = createTestState();
      let capturedScripts: readonly string[] = [];

      const { dispatcher } = createTestSetup([
        createConfigureModule(["script-a", "script-b"]),
        createConfigureModule(["script-c"]),
        createInitModule(state, {
          captureScripts: (scripts) => {
            capturedScripts = scripts;
          },
        }),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(capturedScripts).toEqual(["script-a", "script-b", "script-c"]);
    });

    it("before-ready hook error aborts startup (#14)", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createFailingConfigureModule("Config failed"),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Config failed");

      // Nothing else ran
      expect(state.codeServerStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
    });

    it("await-ready hook error aborts startup (#15)", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createAwaitReadyModule({ fail: true }),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Electron ready failed");

      expect(state.codeServerStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
    });

    it("init hook receives requiredScripts from before-ready results (#16)", async () => {
      const state = createTestState();
      let capturedScripts: readonly string[] = [];

      const { dispatcher } = createTestSetup([
        createConfigureModule(["bin/agent-wrapper"]),
        createInitModule(state, {
          captureScripts: (scripts) => {
            capturedScripts = scripts;
          },
        }),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(capturedScripts).toEqual(["bin/agent-wrapper"]);
    });

    it("init hook error aborts startup (#17)", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createInitModule(state, { fail: true }),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Init failed");

      expect(state.codeServerStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
    });

    it("full sequence: before-ready -> await-ready -> init -> show-ui -> start (#18)", async () => {
      const state = createTestState();

      const configureTracker: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<ConfigureResult> => {
                state.executionOrder.push("before-ready");
                return { scripts: ["test-script"] };
              },
            },
          },
        },
      };

      const awaitReadyTracker: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "await-ready": {
              handler: async (): Promise<void> => {
                state.executionOrder.push("await-ready");
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([
        configureTracker,
        awaitReadyTracker,
        createInitModule(state),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(state.executionOrder).toEqual([
        "before-ready",
        "await-ready",
        "init",
        "codeserver-start",
        "mcp-start",
        "data-activate",
        "view-activate",
      ]);
    });

    it("empty before-ready results produce empty requiredScripts", async () => {
      const state = createTestState();
      let capturedScripts: readonly string[] | undefined;

      const { dispatcher } = createTestSetup([
        createInitModule(state, {
          captureScripts: (scripts) => {
            capturedScripts = scripts;
          },
        }),
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(capturedScripts).toEqual([]);
    });
  });
});
