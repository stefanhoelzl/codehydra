// @vitest-environment node
/**
 * Integration tests for app:shutdown operation through the Dispatcher.
 *
 * Tests verify the full dispatch pipeline: intent -> operation -> hook execution.
 *
 * Test plan items covered:
 * #6: shutdown disposes all services
 * #7: shutdown continues when ServerManager.dispose fails
 * #8: shutdown continues when multiple modules fail
 * #9: shutdown idempotency: second dispatch is no-op
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  APP_SHUTDOWN_OPERATION_ID,
} from "./app-shutdown";
import type { AppShutdownIntent } from "./app-shutdown";
import type { IntentModule } from "../intents/infrastructure/module";
import { createIdempotencyModule } from "../intents/infrastructure/idempotency-module";

// =============================================================================
// Test Setup
// =============================================================================

interface DisposalState {
  serverManagerDisposed: boolean;
  mcpDisposed: boolean;
  pluginServerClosed: boolean;
  telemetryFlushed: boolean;
  viewsDestroyed: boolean;
  badgeDisposed: boolean;
  autoUpdaterDisposed: boolean;
}

function createDisposalState(): DisposalState {
  return {
    serverManagerDisposed: false,
    mcpDisposed: false,
    pluginServerClosed: false,
    telemetryFlushed: false,
    viewsDestroyed: false,
    badgeDisposed: false,
    autoUpdaterDisposed: false,
  };
}

function createServerManagerModule(
  state: DisposalState,
  options?: { fail?: boolean }
): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (options?.fail) {
                throw new Error("ServerManager.dispose failed");
              }
              state.serverManagerDisposed = true;
            } catch {
              // Best-effort: log and continue
              state.serverManagerDisposed = false;
            }
          },
        },
      },
    },
  };
}

function createMcpShutdownModule(state: DisposalState): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              state.mcpDisposed = true;
            } catch {
              // Best-effort
            }
          },
        },
      },
    },
  };
}

function createPluginServerModule(
  state: DisposalState,
  options?: { fail?: boolean }
): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (options?.fail) {
                throw new Error("PluginServer.close failed");
              }
              state.pluginServerClosed = true;
            } catch {
              // Best-effort
              state.pluginServerClosed = false;
            }
          },
        },
      },
    },
  };
}

function createTelemetryModule(state: DisposalState): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              state.telemetryFlushed = true;
            } catch {
              // Best-effort
            }
          },
        },
      },
    },
  };
}

function createViewShutdownModule(state: DisposalState): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              state.viewsDestroyed = true;
            } catch {
              // Best-effort
            }
          },
        },
      },
    },
  };
}

function createBadgeShutdownModule(state: DisposalState): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              state.badgeDisposed = true;
            } catch {
              // Best-effort
            }
          },
        },
      },
    },
  };
}

function createAutoUpdaterShutdownModule(state: DisposalState): IntentModule {
  return {
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              state.autoUpdaterDisposed = true;
            } catch {
              // Best-effort
            }
          },
        },
      },
    },
  };
}

function createTestSetup(
  modules: IntentModule[],
  options?: { withIdempotency?: boolean }
): { dispatcher: Dispatcher } {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

  if (options?.withIdempotency) {
    const idempotencyModule = createIdempotencyModule([{ intentType: INTENT_APP_SHUTDOWN }]);
    dispatcher.registerModule(idempotencyModule);
  }
  for (const m of modules) dispatcher.registerModule(m);

  return { dispatcher };
}

function appShutdownIntent(): AppShutdownIntent {
  return {
    type: INTENT_APP_SHUTDOWN,
    payload: {} as AppShutdownIntent["payload"],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("AppShutdown Operation", () => {
  describe("shutdown disposes all services (#6)", () => {
    it("each service is disposed after stop hook runs", async () => {
      const state = createDisposalState();
      const { dispatcher } = createTestSetup([
        createServerManagerModule(state),
        createMcpShutdownModule(state),
        createPluginServerModule(state),
        createTelemetryModule(state),
        createViewShutdownModule(state),
        createBadgeShutdownModule(state),
        createAutoUpdaterShutdownModule(state),
      ]);

      await dispatcher.dispatch(appShutdownIntent());

      expect(state.serverManagerDisposed).toBe(true);
      expect(state.mcpDisposed).toBe(true);
      expect(state.pluginServerClosed).toBe(true);
      expect(state.telemetryFlushed).toBe(true);
      expect(state.viewsDestroyed).toBe(true);
      expect(state.badgeDisposed).toBe(true);
      expect(state.autoUpdaterDisposed).toBe(true);
    });
  });

  describe("shutdown continues when ServerManager.dispose fails (#7)", () => {
    it("other services still dispose despite ServerManager failure", async () => {
      const state = createDisposalState();
      const { dispatcher } = createTestSetup([
        createServerManagerModule(state, { fail: true }),
        createMcpShutdownModule(state),
        createPluginServerModule(state),
        createTelemetryModule(state),
        createViewShutdownModule(state),
      ]);

      // Should not throw
      await dispatcher.dispatch(appShutdownIntent());

      expect(state.serverManagerDisposed).toBe(false);
      expect(state.mcpDisposed).toBe(true);
      expect(state.pluginServerClosed).toBe(true);
      expect(state.telemetryFlushed).toBe(true);
      expect(state.viewsDestroyed).toBe(true);
    });
  });

  describe("shutdown continues when multiple modules fail (#8)", () => {
    it("all other modules still dispose", async () => {
      const state = createDisposalState();
      const { dispatcher } = createTestSetup([
        createServerManagerModule(state, { fail: true }),
        createPluginServerModule(state, { fail: true }),
        createMcpShutdownModule(state),
        createTelemetryModule(state),
        createViewShutdownModule(state),
        createBadgeShutdownModule(state),
        createAutoUpdaterShutdownModule(state),
      ]);

      // Should not throw despite multiple failures
      await dispatcher.dispatch(appShutdownIntent());

      expect(state.serverManagerDisposed).toBe(false);
      expect(state.pluginServerClosed).toBe(false);
      expect(state.mcpDisposed).toBe(true);
      expect(state.telemetryFlushed).toBe(true);
      expect(state.viewsDestroyed).toBe(true);
      expect(state.badgeDisposed).toBe(true);
      expect(state.autoUpdaterDisposed).toBe(true);
    });
  });

  describe("quit hook runs after stop hooks", () => {
    it("quit hook fires after all stop hooks complete", async () => {
      const order: string[] = [];
      const stopModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            stop: {
              handler: async () => {
                order.push("stop");
              },
            },
          },
        },
      };
      const quitModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            quit: {
              handler: async () => {
                order.push("quit");
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([stopModule, quitModule]);

      await dispatcher.dispatch(appShutdownIntent());

      expect(order).toEqual(["stop", "quit"]);
    });
  });

  describe("shutdown idempotency (#9)", () => {
    it("second dispatch is no-op, services disposed only once", async () => {
      let disposeCount = 0;
      const countingModule: IntentModule = {
        hooks: {
          [APP_SHUTDOWN_OPERATION_ID]: {
            stop: {
              handler: async () => {
                disposeCount++;
              },
            },
          },
        },
      };

      const { dispatcher } = createTestSetup([countingModule], { withIdempotency: true });

      // First dispatch
      await dispatcher.dispatch(appShutdownIntent());
      expect(disposeCount).toBe(1);

      // Second dispatch is cancelled by interceptor
      const handle = dispatcher.dispatch(appShutdownIntent());
      expect(await handle.accepted).toBe(false);
      expect(disposeCount).toBe(1);
    });
  });
});
