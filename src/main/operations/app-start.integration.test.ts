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
 * #6: project:open dispatched for each saved project path
 * #7: mount blocks until resolved, project:open dispatches run after
 * #8: check hooks -- no setup needed
 * #9: check hooks -- setup needed (agent null)
 * #10: check hooks -- setup needed (binaries)
 * #11: check hooks -- setup needed (extensions)
 * #12: check-config error aborts
 * #13: check-deps error aborts
 * #14: configuredAgent flows to check-deps
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import {
  AppStartOperation,
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  EVENT_APP_STARTED,
} from "./app-start";
import type {
  AppStartIntent,
  StartHookResult,
  ActivateHookContext,
  ActivateHookResult,
  CheckConfigResult,
  CheckDepsHookContext,
  CheckDepsResult,
} from "./app-start";
import { INTENT_SETUP } from "./setup";
import type { SetupIntent } from "./setup";
import { INTENT_OPEN_PROJECT } from "./open-project";
import type { OpenProjectIntent } from "./open-project";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext, Operation, OperationContext } from "../intents/infrastructure/operation";
import type { ConfigAgentType, Project } from "../../shared/api/types";
import type { BinaryType } from "../../services/vscode-setup/types";

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
  /** Tracks project paths dispatched via project:open */
  openedProjectPaths: string[];
  /** Whether mount handler ran and was resolved */
  mountCompleted: boolean;
}

function createTestState(): TestState {
  return {
    codeServerStarted: false,
    mcpStarted: false,
    dataLoaded: false,
    viewActivated: false,
    executionOrder: [],
    openedProjectPaths: [],
    mountCompleted: false,
  };
}

function createCodeServerModule(state: TestState, options?: { fail?: boolean }): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            if (options?.fail) {
              throw new Error("CodeServer failed to start");
            }
            state.codeServerStarted = true;
            state.executionOrder.push("codeserver-start");
            return { codeServerPort: 8080 };
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
          handler: async (): Promise<StartHookResult> => {
            if (options?.fail) {
              throw new Error("MCP server failed to start");
            }
            state.mcpStarted = true;
            state.executionOrder.push("mcp-start");
            return { mcpPort: 9090 };
          },
        },
      },
    },
  };
}

function createDataModule(
  state: TestState,
  options?: { fail?: boolean; projectPaths?: readonly string[] }
): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            if (options?.fail) {
              throw new Error("Failed to load persisted projects");
            }
            state.dataLoaded = true;
            state.executionOrder.push("data-activate");
            // Return project paths (simulates DataLifecycleModule)
            if (options?.projectPaths) {
              return { projectPaths: options.projectPaths };
            }
            return {};
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
          handler: async (): Promise<ActivateHookResult> => {
            state.viewActivated = true;
            state.executionOrder.push("view-activate");
            return {};
          },
        },
      },
    },
  };
}

/**
 * Simulates the mountModule pattern: activate handler that blocks until resolved.
 * In the real implementation, mount sends show-main-view IPC and blocks until
 * lifecycle.ready() resolves the promise. In tests, we auto-resolve immediately.
 */
function createMountModule(state: TestState): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        activate: {
          handler: async (): Promise<ActivateHookResult> => {
            state.mountCompleted = true;
            state.executionOrder.push("mount");
            return {};
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
          handler: async (): Promise<StartHookResult> => {
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
            return { codeServerPort: 8080 };
          },
        },
      },
    },
  };
}

/**
 * Stub operation for project:open that records paths dispatched.
 */
function createProjectOpenStub(
  state: TestState,
  options?: { failForPath?: string }
): Operation<OpenProjectIntent, Project> {
  return {
    id: "open-project",
    async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project> {
      const pathStr = ctx.intent.payload.path?.toString() ?? "";
      if (options?.failForPath === pathStr) {
        throw new Error(`Project not found: ${pathStr}`);
      }
      state.openedProjectPaths.push(pathStr);
      state.executionOrder.push(`project-open:${pathStr}`);
      return {
        id: `id-${pathStr}`,
        path: pathStr,
        name: "test",
        workspaces: [],
      } as unknown as Project;
    },
  };
}

/**
 * Default check modules that make checks pass (agent configured, no missing deps).
 * Existing tests that don't care about check hooks get these by default.
 */
function defaultCheckModules(): IntentModule[] {
  return [
    {
      hooks: {
        [APP_START_OPERATION_ID]: {
          "check-config": {
            handler: async (): Promise<CheckConfigResult> => ({
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
    projectOpenStub?: Operation<OpenProjectIntent, Project>;
    skipDefaultChecks?: boolean;
  }
): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_START, new AppStartOperation());
  if (options?.projectOpenStub) {
    dispatcher.registerOperation(INTENT_OPEN_PROJECT, options.projectOpenStub);
  }

  const allModules = options?.skipDefaultChecks ? modules : [...defaultCheckModules(), ...modules];
  wireModules(allModules, hookRegistry, dispatcher);

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
      // With collect(), MCP still runs even though CodeServer threw (errors collected)
      expect(state.mcpStarted).toBe(true);
      // Activate hooks never ran (operation throws after collecting start errors)
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
      // DataModule failed, but with collect() ViewModule still runs
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

  describe("project:open dispatch for saved projects (#6)", () => {
    it("dispatches project:open for each project path set by activate hook", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state, { projectPaths: ["/project-a", "/project-b"] }),
          createViewModule(state),
          createMountModule(state),
        ],
        { projectOpenStub: stub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(state.openedProjectPaths).toEqual(["/project-a", "/project-b"]);
    });

    it("skips invalid projects without aborting startup", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state, { failForPath: "/invalid" });
      const { dispatcher } = createTestSetup(
        [
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state, { projectPaths: ["/invalid", "/valid"] }),
          createViewModule(state),
          createMountModule(state),
        ],
        { projectOpenStub: stub }
      );

      // Should not throw despite /invalid failing
      await dispatcher.dispatch(appStartIntent());

      // Only /valid was successfully opened
      expect(state.openedProjectPaths).toEqual(["/valid"]);
      // Mount still completed
      expect(state.mountCompleted).toBe(true);
    });

    it("skips dispatch when no project paths set", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state),
          createViewModule(state),
          createMountModule(state),
        ],
        { projectOpenStub: stub }
      );

      await dispatcher.dispatch(appStartIntent());

      expect(state.openedProjectPaths).toEqual([]);
      expect(state.mountCompleted).toBe(true);
    });
  });

  describe("mount blocks in activate, project:open dispatches run after (#7)", () => {
    it("mount runs in activate, project:open dispatches follow", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state, { projectPaths: ["/project-a"] }),
          createViewModule(state),
          createMountModule(state),
        ],
        { projectOpenStub: stub }
      );

      await dispatcher.dispatch(appStartIntent());

      // Verify ordering: start → activate (data + view + mount) → project:open
      expect(state.executionOrder).toEqual([
        "codeserver-start",
        "mcp-start",
        "data-activate",
        "view-activate",
        "mount",
        "project-open:/project-a",
      ]);
    });
  });

  // ===========================================================================
  // Check Hooks (collect-based, isolated contexts)
  // ===========================================================================

  describe("check hooks", () => {
    // -- Helpers for check hook modules --

    function createConfigCheckModule(agent: ConfigAgentType | null): IntentModule {
      return {
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-config": {
              handler: async (): Promise<CheckConfigResult> => {
                return { configuredAgent: agent };
              },
            },
          },
        },
      };
    }

    function createBinaryCheckModule(missingBinaries: BinaryType[]): IntentModule {
      return {
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
      missing?: string[];
      outdated?: string[];
    }): IntentModule {
      return {
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-deps": {
              handler: async (): Promise<CheckDepsResult> => {
                return {
                  ...(opts.missing !== undefined && { missingExtensions: opts.missing }),
                  ...(opts.outdated !== undefined && { outdatedExtensions: opts.outdated }),
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
      wireModules(modules, hookRegistry, dispatcher);

      return { dispatcher };
    }

    it("no setup needed -- all checks pass, app:setup not dispatched (#8)", async () => {
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

    it("setup needed -- agent null triggers app:setup (#9)", async () => {
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

    it("setup needed -- missing binaries triggers app:setup (#10)", async () => {
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

    it("setup needed -- missing extensions triggers app:setup (#11)", async () => {
      const state = createTestState();
      const setupStub = createSetupStub(state);
      const { dispatcher } = createCheckTestSetup(
        [
          createConfigCheckModule("claude"),
          createBinaryCheckModule([]),
          createExtensionCheckModule({ missing: ["ext-a"] }),
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

    it("check-config error aborts startup (#12)", async () => {
      const state = createTestState();
      const failingConfigModule: IntentModule = {
        hooks: {
          [APP_START_OPERATION_ID]: {
            "check-config": {
              handler: async (): Promise<CheckConfigResult> => {
                throw new Error("Config load failed");
              },
            },
          },
        },
      };

      const { dispatcher } = createCheckTestSetup([
        failingConfigModule,
        createBinaryCheckModule([]),
        createCodeServerModule(state),
      ]);

      await expect(dispatcher.dispatch(appStartIntent())).rejects.toThrow(
        "check-config hooks failed"
      );
      expect(state.codeServerStarted).toBe(false);
    });

    it("check-deps error aborts startup (#13)", async () => {
      const state = createTestState();
      const failingDepsModule: IntentModule = {
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

    it("configuredAgent flows from check-config to check-deps context (#14)", async () => {
      const state = createTestState();
      let receivedAgent: ConfigAgentType | null | undefined;

      const agentReadingDepsModule: IntentModule = {
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
  // Activate Hook Context (mcpPort flowing from start to activate)
  // ===========================================================================

  describe("activate hook receives mcpPort from start results (#15)", () => {
    it("passes mcpPort from MCP start handler to activate handlers", async () => {
      const state = createTestState();
      let receivedMcpPort: number | null | undefined;

      const mcpPortReaderModule: IntentModule = {
        hooks: {
          [APP_START_OPERATION_ID]: {
            activate: {
              handler: async (ctx: HookContext): Promise<ActivateHookResult> => {
                receivedMcpPort = (ctx as ActivateHookContext).mcpPort;
                return {};
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([
        createCodeServerModule(state),
        createMcpModule(state),
        mcpPortReaderModule,
      ]);

      await dispatcher.dispatch(appStartIntent());

      expect(receivedMcpPort).toBe(9090);
    });

    it("passes null mcpPort when no start handler returns mcpPort", async () => {
      const state = createTestState();
      let receivedMcpPort: number | null | undefined;

      const mcpPortReaderModule: IntentModule = {
        hooks: {
          [APP_START_OPERATION_ID]: {
            activate: {
              handler: async (ctx: HookContext): Promise<ActivateHookResult> => {
                receivedMcpPort = (ctx as ActivateHookContext).mcpPort;
                return {};
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([createCodeServerModule(state), mcpPortReaderModule]);

      await dispatcher.dispatch(appStartIntent());

      expect(receivedMcpPort).toBeNull();
    });
  });

  // ===========================================================================
  // app:started Domain Event
  // ===========================================================================

  describe("app:started event emitted after project:open dispatches (#16)", () => {
    it("emits app:started after project:open dispatches complete", async () => {
      const state = createTestState();
      const stub = createProjectOpenStub(state);
      const { dispatcher } = createTestSetup(
        [
          createCodeServerModule(state),
          createMcpModule(state),
          createDataModule(state, { projectPaths: ["/project-a", "/project-b"] }),
          createViewModule(state),
          createMountModule(state),
        ],
        { projectOpenStub: stub }
      );

      dispatcher.subscribe(EVENT_APP_STARTED, () => {
        state.executionOrder.push("app:started");
      });

      await dispatcher.dispatch(appStartIntent());

      // app:started fires after all project:open dispatches
      expect(state.executionOrder).toEqual([
        "codeserver-start",
        "mcp-start",
        "data-activate",
        "view-activate",
        "mount",
        "project-open:/project-a",
        "project-open:/project-b",
        "app:started",
      ]);
    });

    it("emits app:started even when no projects to open", async () => {
      const state = createTestState();
      const { dispatcher } = createTestSetup([
        createCodeServerModule(state),
        createMcpModule(state),
        createDataModule(state),
        createViewModule(state),
      ]);

      let eventFired = false;
      dispatcher.subscribe(EVENT_APP_STARTED, () => {
        eventFired = true;
      });

      await dispatcher.dispatch(appStartIntent());

      expect(eventFired).toBe(true);
    });
  });
});
