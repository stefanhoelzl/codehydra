/**
 * Test utilities for API Registry.
 * Provides mock registry factories for module testing.
 */

import { vi, type Mock } from "vitest";
import type {
  IApiRegistry,
  MethodPath,
  MethodHandler,
  RegistrationOptions,
  ApiEvents,
  Unsubscribe,
  ICodeHydraApi,
} from "./registry-types";
import { ALL_METHOD_PATHS } from "./registry-types";

// Import and re-export shared test fixtures for backward compatibility
import {
  createMockProject,
  createMockWorkspace,
  DEFAULT_PROJECT_ID,
} from "../../shared/test-fixtures";

export { createMockProject, createMockWorkspace, DEFAULT_PROJECT_ID };

// =============================================================================
// Mock Types
// =============================================================================

/**
 * Mock registry with vitest spy methods.
 * All method calls are recorded for assertion.
 */
export interface MockApiRegistry extends IApiRegistry {
  register: Mock<IApiRegistry["register"]>;
  emit: Mock<IApiRegistry["emit"]>;
  on: Mock<IApiRegistry["on"]>;
  getInterface: Mock<IApiRegistry["getInterface"]>;
  dispose: Mock<IApiRegistry["dispose"]>;

  /**
   * Get all registered method paths.
   */
  getRegisteredPaths(): MethodPath[];

  /**
   * Get the handler for a specific path.
   * Returns undefined if not registered.
   */
  getHandler<P extends MethodPath>(path: P): MethodHandler<P> | undefined;

  /**
   * Get all emitted events with their payloads.
   */
  getEmittedEvents(): Array<{ event: keyof ApiEvents; payload: unknown }>;

  /**
   * Get all event subscriptions.
   */
  getSubscriptions(): Map<keyof ApiEvents, Set<unknown>>;
}

// =============================================================================
// Mock Factories
// =============================================================================

/**
 * Create a mock registry for module testing.
 *
 * The mock matches real registry behavior:
 * - Throws on duplicate registration
 * - Validates completeness in getInterface()
 * - Properly tracks event subscriptions
 *
 * @example
 * ```typescript
 * const mockRegistry = createMockRegistry();
 *
 * // Create module under test
 * const module = new CoreModule(mockRegistry, deps);
 *
 * // Verify registration
 * expect(mockRegistry.getRegisteredPaths()).toContain("lifecycle.quit");
 *
 * // Verify events
 * mockRegistry.emit("workspace:switched", { projectId: "test-12345678", workspaceName: "main", path: "/test" });
 * expect(mockRegistry.getEmittedEvents()).toHaveLength(1);
 * ```
 */
export function createMockRegistry(): MockApiRegistry {
  const registeredMethods = new Map<MethodPath, MethodHandler<MethodPath>>();
  const subscriptions = new Map<keyof ApiEvents, Set<unknown>>();
  const emittedEvents: Array<{ event: keyof ApiEvents; payload: unknown }> = [];
  let disposed = false;

  const mockRegistry: MockApiRegistry = {
    register: vi.fn(
      <P extends MethodPath>(
        path: P,
        handler: MethodHandler<P>,
        options?: RegistrationOptions
      ): void => {
        void options; // Options are captured by mock for verification but not used in implementation
        if (disposed) {
          throw new Error("Cannot register on disposed registry");
        }
        if (registeredMethods.has(path)) {
          throw new Error(`Method already registered: ${path}`);
        }
        registeredMethods.set(path, handler as MethodHandler<MethodPath>);
      }
    ),

    emit: vi.fn(
      <E extends keyof ApiEvents>(event: E, payload: Parameters<ApiEvents[E]>[0]): void => {
        emittedEvents.push({ event, payload });

        // Also call registered handlers
        const handlers = subscriptions.get(event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              (handler as ApiEvents[E])(payload as never);
            } catch {
              // Ignore errors in mock
            }
          }
        }
      }
    ),

    on: vi.fn(<E extends keyof ApiEvents>(event: E, handler: ApiEvents[E]): Unsubscribe => {
      let handlers = subscriptions.get(event);
      if (!handlers) {
        handlers = new Set();
        subscriptions.set(event, handlers);
      }
      handlers.add(handler);

      return () => {
        handlers?.delete(handler);
      };
    }),

    getInterface: vi.fn((): ICodeHydraApi => {
      // Verify completeness like real registry
      const missing = ALL_METHOD_PATHS.filter((p) => !registeredMethods.has(p));
      if (missing.length > 0) {
        throw new Error(`Missing method registrations: ${missing.join(", ")}`);
      }

      // Return a minimal mock interface
      return createMockCodeHydraApi(registeredMethods);
    }),

    dispose: vi.fn(async (): Promise<void> => {
      disposed = true;
      registeredMethods.clear();
      subscriptions.clear();
    }),

    // Test helper methods
    getRegisteredPaths(): MethodPath[] {
      return Array.from(registeredMethods.keys());
    },

    getHandler<P extends MethodPath>(path: P): MethodHandler<P> | undefined {
      return registeredMethods.get(path) as MethodHandler<P> | undefined;
    },

    getEmittedEvents(): Array<{ event: keyof ApiEvents; payload: unknown }> {
      return [...emittedEvents];
    },

    getSubscriptions(): Map<keyof ApiEvents, Set<unknown>> {
      return new Map(subscriptions);
    },
  };

  return mockRegistry;
}

// =============================================================================
// Helper Factories
// =============================================================================

/**
 * Create a mock ICodeHydraApi that delegates to registered handlers.
 */
function createMockCodeHydraApi(
  handlers: Map<MethodPath, MethodHandler<MethodPath>>
): ICodeHydraApi {
  const get = <P extends MethodPath>(path: P): MethodHandler<P> =>
    handlers.get(path) as MethodHandler<P>;

  return {
    projects: {
      open: (path) => get("projects.open")({ path }),
      close: (projectId, options) => get("projects.close")({ projectId, ...options }),
      clone: (url) => get("projects.clone")({ url }),
      list: () => get("projects.list")({}),
      get: (projectId) => get("projects.get")({ projectId }),
      fetchBases: (projectId) => get("projects.fetchBases")({ projectId }),
    },
    workspaces: {
      create: (projectId, name, base, options) =>
        get("workspaces.create")({ projectId, name, base, ...options }),
      remove: (projectId, workspaceName, options) =>
        get("workspaces.remove")({
          projectId,
          workspaceName,
          ...options,
        }),
      get: (projectId, workspaceName) => get("workspaces.get")({ projectId, workspaceName }),
      getStatus: (projectId, workspaceName) =>
        get("workspaces.getStatus")({ projectId, workspaceName }),
      getAgentSession: (projectId, workspaceName) =>
        get("workspaces.getAgentSession")({ projectId, workspaceName }),
      restartAgentServer: (projectId, workspaceName) =>
        get("workspaces.restartAgentServer")({ projectId, workspaceName }),
      setMetadata: (projectId, workspaceName, key, value) =>
        get("workspaces.setMetadata")({ projectId, workspaceName, key, value }),
      getMetadata: (projectId, workspaceName) =>
        get("workspaces.getMetadata")({ projectId, workspaceName }),
      executeCommand: (projectId, workspaceName, command, args) =>
        get("workspaces.executeCommand")({
          projectId,
          workspaceName,
          command,
          ...(args && { args }),
        }),
    },
    ui: {
      selectFolder: () => get("ui.selectFolder")({}),
      getActiveWorkspace: () => get("ui.getActiveWorkspace")({}),
      switchWorkspace: (projectId, workspaceName, focus) =>
        get("ui.switchWorkspace")({
          projectId,
          workspaceName,
          ...(focus !== undefined && { focus }),
        }),
      setMode: (mode) => get("ui.setMode")({ mode }),
    },
    lifecycle: {
      ready: () => get("lifecycle.ready")({}),
      quit: () => get("lifecycle.quit")({}),
    },
    on: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

/**
 * Register all methods with default stub implementations.
 * Useful for module tests that only care about a subset of methods.
 */
export function registerAllMethodsWithStubs(
  registry: IApiRegistry,
  overrides: Partial<{ [P in MethodPath]: MethodHandler<P> }> = {}
): void {
  const defaultHandlers: { [P in MethodPath]: MethodHandler<P> } = {
    "lifecycle.ready": async () => {},
    "lifecycle.quit": async () => {},
    "projects.open": async () => createMockProject(),
    "projects.close": async () => {},
    "projects.clone": async () => createMockProject(),
    "projects.list": async () => [],
    "projects.get": async () => undefined,
    "projects.fetchBases": async () => ({ bases: [] }),
    "workspaces.create": async () => createMockWorkspace(),
    "workspaces.remove": async () => ({ started: true as const }),
    "workspaces.get": async () => undefined,
    "workspaces.getStatus": async () => ({ isDirty: false, agent: { type: "none" as const } }),
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
