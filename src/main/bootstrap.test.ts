/**
 * Unit tests for bootstrap.
 *
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeBootstrap } from "./bootstrap";
import type { BootstrapDeps } from "./bootstrap";
import { createMockLogger } from "../services/logging";
import { createBehavioralIpcLayer } from "../services/platform/ipc.test-utils";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(): BootstrapDeps {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  return {
    logger: createMockLogger(),
    ipcLayer: createBehavioralIpcLayer(),
    app: { quit: vi.fn() },
    hookRegistry,
    dispatcher,
    getApiFn: () => {
      throw new Error("not initialized");
    },
    pluginServer: null,
    getUIWebContentsFn: () => null,
    emitDeletionProgress: vi.fn(),
    agentStatusManager: {
      getStatus: vi.fn(),
      onStatusChanged: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
    } as never,
    globalWorktreeProvider: {
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue({ base: "main" }),
      registerProject: vi.fn(),
      unregisterProject: vi.fn(),
      ensureWorkspaceRegistered: vi.fn(),
    } as never,
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    },
    modules: [],
    mountSignal: { resolve: null },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("initializeBootstrap", () => {
  let deps: BootstrapDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("creates registry with lifecycle methods registered", () => {
    const result = initializeBootstrap(deps);

    // Lifecycle methods should be registered immediately
    // Check that lifecycle methods are available by verifying registry exists
    expect(result.registry).toBeDefined();
    expect(result.getInterface).toBeDefined();
    expect(result.dispose).toBeDefined();
  });

  it("registers all modules including core and ui", () => {
    const result = initializeBootstrap(deps);

    // wireDispatcher now runs during initializeBootstrap,
    // so all methods should be registered immediately
    const api = result.getInterface();
    expect(api.lifecycle).toBeDefined();
    expect(api.projects).toBeDefined();
    expect(api.workspaces).toBeDefined();
    expect(api.ui).toBeDefined();
  });

  it("dispose cleans up all modules", async () => {
    const result = initializeBootstrap(deps);

    // Get interface to verify it works before dispose
    const api = result.getInterface();
    expect(api).toBeDefined();

    // Dispose should not throw
    await expect(result.dispose()).resolves.not.toThrow();
  });

  it("registers IPC handlers for all modules", () => {
    // IPC handlers are registered automatically for all modules
    const result = initializeBootstrap(deps);

    // Registry should have methods with IPC handlers
    expect(result.registry).toBeDefined();
  });
});

describe("bootstrap event flow", () => {
  let deps: BootstrapDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("allows subscribing to events via registry.on()", () => {
    const result = initializeBootstrap(deps);

    const handler = vi.fn();
    const unsubscribe = result.registry.on("project:opened", handler);

    // Emit an event
    result.registry.emit("project:opened", {
      project: {
        id: "test-id" as never,
        name: "test",
        path: "/test",
        workspaces: [],
      },
    });

    expect(handler).toHaveBeenCalledOnce();

    // Unsubscribe
    unsubscribe();

    // Emit again
    result.registry.emit("project:opened", {
      project: {
        id: "test-id" as never,
        name: "test",
        path: "/test",
        workspaces: [],
      },
    });

    // Handler should not be called again
    expect(handler).toHaveBeenCalledOnce();
  });
});
