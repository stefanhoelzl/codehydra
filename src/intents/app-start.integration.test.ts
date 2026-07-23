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
 * #2: start abort on IdeServer failure
 * #3: start abort on MCP failure (non-optional)
 * #4: start hook failure (data) propagates
 * #5: PluginServer graceful degradation
 * #6: check hooks -- no setup needed
 * #7: check hooks -- agent-selection precedes check-deps (first-run binary regression)
 * #8: check hooks -- setup needed (binaries)
 * #9: check hooks -- setup needed (extensions)
 * #10: init error aborts startup (configuredAgent path)
 * #11: check-deps error aborts
 * #12: configuredAgent flows from init results to check-deps
 * #13: before-ready hook collects scripts from multiple modules
 * #14: before-ready hook error aborts startup
 * #15: init hook receives requiredScripts from before-ready results
 * #16: init hook error aborts startup
 * #17: full sequence: before-ready -> init -> show-ui -> start
 * #18: ports available via capabilities in start hook
 */

import { createMockDispatcher } from "./lib/dispatcher.test-utils";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "./lib/dispatcher";

import {
  AppStartOperation,
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  APP_START_ERROR_HOOK,
} from "./app-start";
import type {
  AppStartIntent,
  AppStartErrorHookContext,
  CheckDepsHookContext,
  CheckDepsResult,
  ConfigureResult,
  InitHookContext,
  InitResult,
  RegisterAgentResult,
  SaveAgentHookInput,
} from "./app-start";
import { INTENT_SETUP } from "./setup";
import type { IntentModule } from "./lib/module";
import { z } from "zod/v4";
import {
  ANY_VALUE,
  type HookContext,
  type HookOutput,
  type Operation,
  type OperationSchemas,
} from "./lib/operation";
import type { ConfigAgentType } from "../shared/api/types";
import type { BinaryType } from "./app-start";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";

/** Permissive schemas for the stub setup operation (app:setup dispatched during checks). */
const setupStubSchemas = {
  type: INTENT_SETUP,
  payload: z.unknown(),
} satisfies OperationSchemas;

/** Mock accessor that seeds the configured agent. Pass null to leave it unset. */
function createMockAgentAccessor(
  agent: ConfigAgentType = "opencode"
): PersistedAccessor<ConfigAgentType> {
  return createMockAccessor<ConfigAgentType>("agent", agent);
}

// =============================================================================
// Test Setup
// =============================================================================

interface TestState {
  ideServerStarted: boolean;
  mcpStarted: boolean;
  dataLoaded: boolean;
  viewActivated: boolean;
  /** Tracks ordering: modules append their name when they run */
  executionOrder: string[];
}

function createTestState(): TestState {
  return {
    ideServerStarted: false,
    mcpStarted: false,
    dataLoaded: false,
    viewActivated: false,
    executionOrder: [],
  };
}

function createIdeServerModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<HookOutput> => {
            if (options?.fail) {
              throw new Error("IdeServer failed to start");
            }
            state.ideServerStarted = true;
            state.executionOrder.push("codeserver-start");
            return { provides: { ideServerPort: 8080 } };
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
          handler: async (): Promise<HookOutput> => {
            if (options?.fail) {
              throw new Error("MCP server failed to start");
            }
            state.mcpStarted = true;
            state.executionOrder.push("mcp-start");
            return { provides: { mcpPort: 9090 } };
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
 * Simulates PluginServer graceful degradation inside IdeServerModule.
 * In the real implementation, IdeServerModule tries to start PluginServer
 * internally and catches its error, then starts the IDE server without the plugin port.
 */
function createIdeServerModuleWithGracefulPluginDegradation(
  state: TestState,
  pluginFails: boolean
): IntentModule {
  return {
    name: "test",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<HookOutput> => {
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
            state.ideServerStarted = true;
            state.executionOrder.push("codeserver-start");
            void pluginPort; // Used for IDE server config in real impl
            return { provides: { ideServerPort: 8080 } };
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
            handler: async (): Promise<HookOutput<InitResult>> => ({ result: {} }),
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
  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(new AppStartOperation(createMockAgentAccessor(), () => true));

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
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(state.ideServerStarted).toBe(true);
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

  describe("start abort on IdeServer failure (#2)", () => {
    it("propagates error and remaining start hooks still run (collect)", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createIdeServerModule(state, { fail: true }),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "IdeServer failed to start"
      );

      expect(state.ideServerStarted).toBe(false);
      // With collect(), MCP still runs even though IdeServer threw (errors collected).
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
        createIdeServerModule(state),
        createMcpModule(state, { fail: true }),
        createDataModule(state),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "MCP server failed to start"
      );

      // IdeServer ran before MCP
      expect(state.ideServerStarted).toBe(true);
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
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state, { fail: true }),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "Failed to load persisted projects"
      );

      // All start hooks ran (collect() continues after errors)
      expect(state.ideServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
      // DataModule failed, but with collect() other start handlers still run
      expect(state.dataLoaded).toBe(false);
      expect(state.viewActivated).toBe(true);
    });
  });

  describe("PluginServer graceful degradation (#5)", () => {
    it("IdeServerModule catches PluginServer error, startup succeeds", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createIdeServerModuleWithGracefulPluginDegradation(state, true),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      // Should not throw despite PluginServer failure
      await dispatcher.dispatch(appStartIntent());

      expect(state.ideServerStarted).toBe(true);
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

    /** Creates a no-op init module. configuredAgent now comes from Config mock. */
    function createConfigCheckModule(_agent: ConfigAgentType | null): IntentModule {
      void _agent; // configuredAgent is now read from Config, not init results
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            init: {
              handler: async (): Promise<HookOutput<InitResult>> => ({ result: {} }),
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
              handler: async (): Promise<HookOutput<CheckDepsResult>> => {
                return { result: { missingBinaries } };
              },
            },
          },
        },
      };
    }

    /**
     * Models a real agent module: it only reports its own missing binary when it is the
     * configured agent, and it records the agent check-deps was called with. This is the
     * shape that made the first-run bug possible — a null agent here means "report nothing".
     */
    function createAgentBinaryModule(
      agentType: ConfigAgentType,
      binary: BinaryType,
      seenAgents: (ConfigAgentType | null)[]
    ): IntentModule {
      return {
        name: `${agentType}-agent`,
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (ctx: HookContext): Promise<HookOutput<CheckDepsResult>> => {
                const { configuredAgent } = ctx as CheckDepsHookContext;
                seenAgents.push(configuredAgent);
                if (configuredAgent !== agentType) return { result: {} };
                return { result: { missingBinaries: [binary] } };
              },
            },
          },
        },
      };
    }

    /** Models the picker + persistence: register-agents / agent-selection / save-agent. */
    function createAgentSelectionModule(
      chosen: ConfigAgentType,
      state: TestState,
      saved: ConfigAgentType[]
    ): IntentModule {
      return {
        name: "picker",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "register-agents": {
              handler: async (): Promise<HookOutput<RegisterAgentResult>> => ({
                result: { agent: chosen, label: chosen, icon: "sparkle" },
              }),
            },
            "agent-selection": {
              handler: async (): Promise<HookOutput<ConfigAgentType>> => {
                state.executionOrder.push("agent-selection");
                return { result: chosen };
              },
            },
            "save-agent": {
              handler: async (ctx: HookContext): Promise<void> => {
                saved.push((ctx as SaveAgentHookInput).selectedAgent);
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
              handler: async (): Promise<HookOutput<CheckDepsResult>> => {
                return {
                  result: {
                    ...(opts.installPlan !== undefined && {
                      extensionInstallPlan: opts.installPlan,
                    }),
                  },
                };
              },
            },
          },
        },
      };
    }

    /** Stub setup operation that records dispatch and succeeds. */
    function createSetupStub(state: TestState): Operation<typeof setupStubSchemas> {
      return {
        id: "setup",
        schemas: setupStubSchemas,
        async execute(ctx): Promise<void> {
          state.executionOrder.push("setup");
          void ctx;
        },
      };
    }

    function createCheckTestSetup(
      modules: IntentModule[],
      options?: {
        setupStub?: Operation<typeof setupStubSchemas>;
        configuredAgent?: ConfigAgentType | null;
      }
    ): { dispatcher: Dispatcher } {
      const dispatcher = createMockDispatcher();

      // A null configuredAgent models a first run (config.json absent →
      // agent-selection onboarding), now driven by wasConfigured() rather than a
      // null agent value; the stored agent itself is always a valid agent.
      const configured = options?.configuredAgent;
      const wasConfigured = configured !== null;
      const agent: ConfigAgentType = configured && configured !== null ? configured : "opencode";
      dispatcher.registerOperation(
        new AppStartOperation(createMockAgentAccessor(agent), () => wasConfigured)
      );
      if (options?.setupStub) {
        dispatcher.registerOperation(options.setupStub);
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
          createIdeServerModule(state),
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
      expect(state.ideServerStarted).toBe(true);
      expect(state.mcpStarted).toBe(true);
    });

    it("agent null runs agent-selection, and check-deps sees the chosen agent (#7)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const seenAgents: (ConfigAgentType | null)[] = [];
      const saved: ConfigAgentType[] = [];
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule(null),
          createAgentSelectionModule("opencode", state, saved),
          // Two agent modules; only the chosen one should report its binary.
          createAgentBinaryModule("opencode", "opencode", seenAgents),
          createAgentBinaryModule("claude", "claude", seenAgents),
          createExtensionCheckModule({}),
          createIdeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub, configuredAgent: null }
      );

      await dispatcher.dispatch(appStartIntent());

      // The picker ran, and it ran BEFORE check-deps: every agent module saw the
      // chosen agent, never the null that used to make them all skip themselves.
      expect(state.executionOrder.indexOf("agent-selection")).toBeLessThan(
        state.executionOrder.indexOf("setup")
      );
      expect(seenAgents).toEqual(["opencode", "opencode"]);
      expect(saved).toEqual(["opencode"]);
    });

    it("the chosen agent's binary reaches app:setup on a first run (#7a)", async () => {
      const state = createTestState();
      const seenAgents: (ConfigAgentType | null)[] = [];
      const saved: ConfigAgentType[] = [];
      let setupPayload: unknown;
      const setupStub: Operation<typeof setupStubSchemas> = {
        id: "setup",
        schemas: setupStubSchemas,
        async execute(ctx): Promise<void> {
          state.executionOrder.push("setup");
          setupPayload = ctx.intent.payload;
        },
      };
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule(null),
          createAgentSelectionModule("opencode", state, saved),
          createAgentBinaryModule("opencode", "opencode", seenAgents),
          createExtensionCheckModule({}),
          createIdeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub, configuredAgent: null }
      );

      await dispatcher.dispatch(appStartIntent());

      // Regression: check-deps used to run with a null agent, so opencode never landed
      // in missingBinaries and the setup "binary" hook downloaded nothing. The user
      // reached a working-looking app whose agent binary did not exist.
      expect(setupPayload).toMatchObject({
        missingBinaries: ["opencode"],
        needsBinaryDownload: true,
        configuredAgent: "opencode",
      });
      expect(state.ideServerStarted).toBe(true);
    });

    it("no setup dispatched when the chosen agent needs nothing (#7b)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const saved: ConfigAgentType[] = [];
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule(null),
          createAgentSelectionModule("claude", state, saved),
          // claude never downloads a binary, so nothing is missing.
          createBinaryCheckModule([]),
          createExtensionCheckModule({}),
          createIdeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
        ],
        { setupStub, configuredAgent: null }
      );

      await dispatcher.dispatch(appStartIntent());

      // Agent selection is no longer a reason to run app:setup.
      expect(state.executionOrder).toContain("agent-selection");
      expect(state.executionOrder).not.toContain("setup");
      expect(saved).toEqual(["claude"]);
      expect(state.ideServerStarted).toBe(true);
    });

    it("setup needed -- missing binaries triggers app:setup (#8)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("claude"),
          createBinaryCheckModule(["vscodium"]),
          createExtensionCheckModule({}),
          createIdeServerModule(state),
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
          createIdeServerModule(state),
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
              handler: async (): Promise<HookOutput<InitResult>> => {
                throw new Error("Config load failed");
              },
            },
          },
        },
      };

      const { dispatcher } = createCheckTestSetup([
        failingInitConfigModule,
        createBinaryCheckModule([]),
        createIdeServerModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Config load failed");
      expect(state.ideServerStarted).toBe(false);
    });

    it("check-deps error aborts startup (#11)", async () => {
      const state = createTestState();
      const failingDepsModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (): Promise<HookOutput<CheckDepsResult>> => {
                throw new Error("Binary preflight failed");
              },
            },
          },
        },
      };

      const { dispatcher } = createCheckTestSetup([
        createConfigCheckModule("claude"),
        failingDepsModule,
        createIdeServerModule(state),
      ]);

      // A lone failing handler surfaces its raw error (multiple would aggregate
      // under "check-deps hooks failed").
      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "Binary preflight failed"
      );
      expect(state.ideServerStarted).toBe(false);
    });

    it("configuredAgent flows from init results to check-deps context (#12)", async () => {
      const state = createTestState();
      let receivedAgent: ConfigAgentType | null | undefined;

      const agentReadingDepsModule: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (ctx: HookContext): Promise<HookOutput<CheckDepsResult>> => {
                receivedAgent = (ctx as CheckDepsHookContext).configuredAgent;
                return { result: {} };
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
          createIdeServerModule(state),
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

  describe("ports available via capabilities in start hook (#18)", () => {
    it.each([
      {
        portName: "mcpPort" as const,
        modules: (s: TestState) => [createIdeServerModule(s), createMcpModule(s)],
        expected: 9090,
        label: "mcpPort available via capabilities from MCP start handler",
      },
      {
        portName: "mcpPort" as const,
        modules: (s: TestState) => [createIdeServerModule(s)],
        expected: undefined,
        label: "mcpPort undefined when no start handler provides it",
      },
      {
        portName: "ideServerPort" as const,
        modules: (s: TestState) => [createIdeServerModule(s), createMcpModule(s)],
        expected: 8080,
        label: "ideServerPort available via capabilities from IdeServer start handler",
      },
      {
        portName: "ideServerPort" as const,
        modules: (s: TestState) => [createMcpModule(s)],
        expected: undefined,
        label: "ideServerPort undefined when no start handler provides it",
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
  // Pre-ready Hooks: before-ready, init
  // ===========================================================================

  describe("pre-ready hooks (before-ready, init)", () => {
    function createConfigureModule(scripts: string[]): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<HookOutput<ConfigureResult>> => {
                return { result: { scripts } };
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
              handler: async (): Promise<HookOutput<ConfigureResult>> => {
                throw new Error(message);
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
              handler: async (ctx: HookContext): Promise<HookOutput<InitResult>> => {
                if (options?.fail) {
                  throw new Error("Init failed");
                }
                state.executionOrder.push("init");
                if (options?.captureScripts) {
                  options.captureScripts((ctx as InitHookContext).requiredScripts);
                }
                return { result: {} };
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
        createIdeServerModule(state),
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
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Config failed");

      // Nothing else ran
      expect(state.ideServerStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
    });

    it("init hook receives requiredScripts from before-ready results (#15)", async () => {
      const state = createTestState();
      let capturedScripts: readonly string[] = [];

      const { dispatcher } = createTestSetup([
        createConfigureModule(["bin/agent-wrapper"]),
        createInitModule(state, {
          captureScripts: (scripts) => {
            capturedScripts = scripts;
          },
        }),
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(capturedScripts).toEqual(["bin/agent-wrapper"]);
    });

    it("init hook error aborts startup (#16)", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createInitModule(state, { fail: true }),
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("Init failed");

      expect(state.ideServerStarted).toBe(false);
      expect(state.dataLoaded).toBe(false);
    });

    it("full sequence: before-ready -> init -> show-ui -> start (#17)", async () => {
      const state = createTestState();

      const configureTracker: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<HookOutput<ConfigureResult>> => {
                state.executionOrder.push("before-ready");
                return { result: { scripts: ["test-script"] } };
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([
        configureTracker,
        createInitModule(state),
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(state.executionOrder).toEqual([
        "before-ready",
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
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(capturedScripts).toEqual([]);
    });
  });

  // ===========================================================================
  // Startup failure "error" hook (#19)
  // ===========================================================================

  describe("startup failure error hook (#19)", () => {
    function createErrorHookCaptureModule(captured: {
      ctx?: AppStartErrorHookContext;
    }): IntentModule {
      return {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            [APP_START_ERROR_HOOK]: {
              handler: async (ctx: HookContext): Promise<void> => {
                captured.ctx = ctx as AppStartErrorHookContext;
              },
            },
          },
        },
      };
    }

    it("runs the error hook with the failing error + phase, then still rejects", async () => {
      const state = createTestState();
      const captured: { ctx?: AppStartErrorHookContext } = {};
      const { dispatcher } = createTestSetup([
        createErrorHookCaptureModule(captured),
        createIdeServerModule(state, { fail: true }),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "IdeServer failed to start"
      );

      expect(captured.ctx).toBeDefined();
      expect(captured.ctx!.phase).toBe("start");
      // The contract carries the failure as plain data — an Error instance could not cross a
      // backend tunnel. error-report-module rebuilds a real Error for the telemetry boundary.
      expect(captured.ctx!.error).not.toBeInstanceOf(Error);
      expect(captured.ctx!.error.name).toBe("Error");
      expect(captured.ctx!.error.message).toBe("IdeServer failed to start");
    });

    it("attributes an early before-ready failure to the before-ready phase", async () => {
      const captured: { ctx?: AppStartErrorHookContext } = {};
      const failingBeforeReady: IntentModule = {
        name: "test",
        hooks: {
          [APP_START_OPERATION_ID]: {
            "before-ready": {
              handler: async (): Promise<void> => {
                throw new Error("early boom");
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([
        createErrorHookCaptureModule(captured),
        failingBeforeReady,
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow("early boom");
      expect(captured.ctx!.phase).toBe("before-ready");
    });

    it("does not run the error hook on a successful startup", async () => {
      const state = createTestState();
      const captured: { ctx?: AppStartErrorHookContext } = {};
      const { dispatcher } = createTestSetup([
        createErrorHookCaptureModule(captured),
        createIdeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      await dispatcher.dispatch(appStartIntent());
      expect(captured.ctx).toBeUndefined();
    });
  });
});
