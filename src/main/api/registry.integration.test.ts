/**
 * Unit tests for ApiRegistry.
 *
 * Uses behavioral IpcLayer mock instead of vi.mock("electron").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiRegistry } from "./registry";
import type { MethodPath, MethodHandler } from "./registry-types";
import { ALL_METHOD_PATHS } from "./registry-types";
import { createMockLogger } from "../../services/logging";
import {
  createBehavioralIpcLayer,
  type BehavioralIpcLayer,
} from "../../services/platform/ipc.test-utils";
import type { ProjectId, WorkspaceName, Project, Workspace } from "../../shared/api/types";

describe("registry.register", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("registers method and makes it callable via getInterface", async () => {
    // Register all required methods with stubs
    registerAllMethodsWithStubs(registry);

    // Override projects.list with a real implementation
    const mockProjects: readonly Project[] = [];
    // Need to create a new registry since we can't re-register
    const freshRegistry = new ApiRegistry();
    registerAllMethodsWithStubs(freshRegistry, {
      "projects.list": async () => mockProjects,
    });

    const api = freshRegistry.getInterface();
    const result = await api.projects.list();

    expect(result).toBe(mockProjects);
    await freshRegistry.dispose();
  });

  it("throws on duplicate registration", () => {
    const handler: MethodHandler<"lifecycle.getState"> = async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    });
    registry.register("lifecycle.getState", handler);

    expect(() => registry.register("lifecycle.getState", handler)).toThrow(
      "Method already registered: lifecycle.getState"
    );
  });

  it("throws when registering on disposed registry", async () => {
    await registry.dispose();

    expect(() =>
      registry.register("lifecycle.getState", async () => ({
        state: "ready" as const,
        agent: "opencode" as const,
      }))
    ).toThrow("Cannot register on disposed registry");
  });
});

describe("registry.register.ipc", () => {
  let registry: ApiRegistry;
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
    registry = new ApiRegistry({ ipcLayer });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("auto-creates IPC handler when ipc option provided", () => {
    const handler: MethodHandler<"lifecycle.getState"> = async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    });
    registry.register("lifecycle.getState", handler, { ipc: "api:lifecycle:get-state" });

    const state = ipcLayer._getState();
    expect(state.handlers.has("api:lifecycle:get-state")).toBe(true);
  });

  it("does not create IPC handler when ipc option not provided", () => {
    const handler: MethodHandler<"lifecycle.getState"> = async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    });
    registry.register("lifecycle.getState", handler);

    const state = ipcLayer._getState();
    expect(state.handlers.size).toBe(0);
  });

  it("does not create IPC handler when no ipcLayer provided", () => {
    const noIpcRegistry = new ApiRegistry();
    const handler: MethodHandler<"lifecycle.getState"> = async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    });
    noIpcRegistry.register("lifecycle.getState", handler, { ipc: "api:lifecycle:get-state" });

    // Should not throw, just skip IPC registration
    const state = ipcLayer._getState();
    expect(state.handlers.size).toBe(0);
  });
});

describe("registry.ipc.payload", () => {
  let registry: ApiRegistry;
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
    registry = new ApiRegistry({ ipcLayer });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("handler receives {} when payload undefined", async () => {
    const receivedPayload = vi.fn();
    const handler: MethodHandler<"lifecycle.getState"> = async (payload) => {
      receivedPayload(payload);
      return { state: "ready" as const, agent: "opencode" as const };
    };
    registry.register("lifecycle.getState", handler, { ipc: "api:lifecycle:get-state" });

    await ipcLayer._invoke("api:lifecycle:get-state", undefined);

    expect(receivedPayload).toHaveBeenCalledWith({});
  });

  it("handler receives {} when payload null", async () => {
    const receivedPayload = vi.fn();
    const handler: MethodHandler<"lifecycle.getState"> = async (payload) => {
      receivedPayload(payload);
      return { state: "ready" as const, agent: "opencode" as const };
    };
    registry.register("lifecycle.getState", handler, { ipc: "api:lifecycle:get-state" });

    await ipcLayer._invoke("api:lifecycle:get-state", null);

    expect(receivedPayload).toHaveBeenCalledWith({});
  });

  it("handler receives actual payload when provided", async () => {
    const receivedPayload = vi.fn();
    const handler: MethodHandler<"projects.open"> = async (payload) => {
      receivedPayload(payload);
      return createMockProject();
    };
    registry.register("projects.open", handler, { ipc: "api:project:open" });

    const testPayload = { path: "/test/path" };
    await ipcLayer._invoke("api:project:open", testPayload);

    expect(receivedPayload).toHaveBeenCalledWith(testPayload);
  });
});

describe("registry.emit", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("emits to all subscribers", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    registry.on("project:opened", handler1);
    registry.on("project:opened", handler2);

    const project = createMockProject();
    registry.emit("project:opened", { project });

    expect(handler1).toHaveBeenCalledWith({ project });
    expect(handler2).toHaveBeenCalledWith({ project });
  });

  it("does nothing if no subscribers", () => {
    // Should not throw
    expect(() => {
      registry.emit("project:opened", { project: createMockProject() });
    }).not.toThrow();
  });
});

describe("registry.emit.error", () => {
  let registry: ApiRegistry;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    registry = new ApiRegistry({ logger: mockLogger });
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("catches handler errors and continues to next", () => {
    const handler1 = vi.fn(() => {
      throw new Error("Handler 1 error");
    });
    const handler2 = vi.fn();

    registry.on("project:opened", handler1);
    registry.on("project:opened", handler2);

    const project = createMockProject();
    registry.emit("project:opened", { project });

    // Both handlers should be called even though first throws
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("error details are logged", () => {
    const testError = new Error("Test error");
    const handler = vi.fn(() => {
      throw testError;
    });

    registry.on("project:opened", handler);
    registry.emit("project:opened", { project: createMockProject() });

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Event handler error",
      { event: "project:opened" },
      testError
    );
  });
});

describe("registry.on", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("subscribes to events and returns unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = registry.on("project:opened", handler);

    const project = createMockProject();
    registry.emit("project:opened", { project });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    registry.emit("project:opened", { project });
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not 2
  });
});

describe("registry.getInterface", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("returns typed ICodeHydraApi facade", async () => {
    registerAllMethodsWithStubs(registry);

    const api = registry.getInterface();

    // Verify structure
    expect(api.projects).toBeDefined();
    expect(api.workspaces).toBeDefined();
    expect(api.ui).toBeDefined();
    expect(api.lifecycle).toBeDefined();
    expect(api.on).toBeDefined();
    expect(api.dispose).toBeDefined();

    // Verify methods exist
    expect(typeof api.projects.open).toBe("function");
    expect(typeof api.workspaces.create).toBe("function");
    expect(typeof api.ui.selectFolder).toBe("function");
    expect(typeof api.lifecycle.getState).toBe("function");
  });
});

describe("registry.getInterface.partial", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("throws if not all methods registered", () => {
    // Only register one method
    registry.register("lifecycle.getState", async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    }));

    expect(() => registry.getInterface()).toThrow("Missing method registrations:");
  });

  it("error message lists missing methods", () => {
    // Only register one method
    registry.register("lifecycle.getState", async () => ({
      state: "ready" as const,
      agent: "opencode" as const,
    }));

    try {
      registry.getInterface();
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("lifecycle.setup");
      expect((error as Error).message).toContain("projects.open");
    }
  });
});

describe("registry.dispose", () => {
  let registry: ApiRegistry;
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
    registry = new ApiRegistry({ ipcLayer });
  });

  it("cleans up IPC handlers and subscriptions", async () => {
    registry.register(
      "lifecycle.getState",
      async () => ({ state: "ready" as const, agent: "opencode" as const }),
      {
        ipc: "api:lifecycle:get-state",
      }
    );

    const handler = vi.fn();
    registry.on("project:opened", handler);

    // Verify handler is registered
    expect(ipcLayer._getState().handlers.has("api:lifecycle:get-state")).toBe(true);

    await registry.dispose();

    // IPC handler should be removed
    expect(ipcLayer._getState().handlers.has("api:lifecycle:get-state")).toBe(false);

    // Event should not be delivered after dispose
    registry.emit("project:opened", { project: createMockProject() });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("registry.dispose.twice", () => {
  let registry: ApiRegistry;
  let ipcLayer: BehavioralIpcLayer;

  beforeEach(() => {
    ipcLayer = createBehavioralIpcLayer();
    registry = new ApiRegistry({ ipcLayer });
  });

  it("second dispose is no-op (idempotent)", async () => {
    registry.register(
      "lifecycle.getState",
      async () => ({ state: "ready" as const, agent: "opencode" as const }),
      {
        ipc: "api:lifecycle:get-state",
      }
    );

    await registry.dispose();
    expect(ipcLayer._getState().handlers.size).toBe(0);

    // Second dispose should be no-op (no error because handler already removed)
    await expect(registry.dispose()).resolves.toBeUndefined();
  });
});

describe("registry.dispose.during.emit", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  it("handles dispose during event emission", async () => {
    const handler1 = vi.fn(async () => {
      // Dispose during event handling
      await registry.dispose();
    });
    const handler2 = vi.fn();

    registry.on("project:opened", handler1);
    registry.on("project:opened", handler2);

    // Should not throw
    registry.emit("project:opened", { project: createMockProject() });

    // First handler was called, second may or may not be called depending on timing
    expect(handler1).toHaveBeenCalled();
  });
});

describe("registry.emit.many.handlers", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("<10ms for 100 handlers", () => {
    const handlers: Array<() => void> = [];
    for (let i = 0; i < 100; i++) {
      const handler = vi.fn();
      handlers.push(handler);
      registry.on("project:opened", handler);
    }

    const start = performance.now();
    registry.emit("project:opened", { project: createMockProject() });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(10);
    for (const handler of handlers) {
      expect(handler).toHaveBeenCalled();
    }
  });
});

describe("registry.getInterface.perf", () => {
  let registry: ApiRegistry;

  beforeEach(() => {
    registry = new ApiRegistry();
    registerAllMethodsWithStubs(registry);
  });

  afterEach(async () => {
    await registry.dispose();
  });

  it("facade creation <1ms", () => {
    const start = performance.now();
    registry.getInterface();
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(1);
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

function createMockProject(): Project {
  return {
    id: "test-project-12345678" as ProjectId,
    name: "test-project",
    path: "/test/path",
    workspaces: [],
  };
}

function createMockWorkspace(): Workspace {
  return {
    projectId: "test-project-12345678" as ProjectId,
    name: "test-workspace" as WorkspaceName,
    branch: "main",
    metadata: { base: "main" },
    path: "/test/path/test-workspace",
  };
}

/**
 * Register all methods with stub implementations.
 * Allows overriding specific methods via the overrides parameter.
 */
function registerAllMethodsWithStubs(
  registry: ApiRegistry,
  overrides: Partial<{
    [P in MethodPath]: MethodHandler<P>;
  }> = {}
): void {
  const defaultHandlers: { [P in MethodPath]: MethodHandler<P> } = {
    "lifecycle.getState": async () => ({ state: "ready" as const, agent: "opencode" as const }),
    "lifecycle.setAgent": async () => ({ success: true }),
    "lifecycle.setup": async () => ({ success: true }),
    "lifecycle.startServices": async () => ({ success: true }),
    "lifecycle.quit": async () => {},
    "projects.open": async () => createMockProject(),
    "projects.close": async () => {},
    "projects.clone": async () => createMockProject(),
    "projects.list": async () => [],
    "projects.get": async () => undefined,
    "projects.fetchBases": async () => ({ bases: [] }),
    "workspaces.create": async () => createMockWorkspace(),
    "workspaces.remove": async () => ({ started: true }),
    "workspaces.forceRemove": async () => {},
    "workspaces.get": async () => undefined,
    "workspaces.getStatus": async () => ({ isDirty: false, agent: { type: "none" } }),
    "workspaces.getAgentSession": async () => null,
    "workspaces.restartAgentServer": async () => 12345,
    "workspaces.setMetadata": async () => {},
    "workspaces.getMetadata": async () => ({}),
    "workspaces.executeCommand": async () => undefined,
    "ui.selectFolder": async () => null,
    "ui.getActiveWorkspace": async () => null,
    "ui.switchWorkspace": async () => {},
    "ui.setMode": async () => {},
  };

  for (const path of ALL_METHOD_PATHS) {
    const handler = (overrides[path] ?? defaultHandlers[path]) as MethodHandler<typeof path>;
    registry.register(path, handler);
  }
}
