/**
 * Unit tests for CoreModule.
 *
 * Note: projects.open, projects.close, and projects.clone have been migrated
 * to the intent dispatcher. Tests for those operations are in:
 * - src/main/operations/open-project.integration.test.ts
 * - src/main/operations/close-project.integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoreModule, type CoreModuleDeps } from "./index";
import { createMockRegistry } from "../../api/registry.test-utils";
import type { MockApiRegistry } from "../../api/registry.test-utils";
import type { AppState } from "../../app-state";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    getProject: vi.fn(),
    getAllProjects: vi.fn().mockResolvedValue([]),
    findProjectForWorkspace: vi.fn(),
    registerWorkspace: vi.fn(),
    unregisterWorkspace: vi.fn(),
    getWorkspaceUrl: vi.fn(),
    getDefaultBaseBranch: vi.fn().mockResolvedValue("main"),
    setLastBaseBranch: vi.fn(),
    setDiscoveryService: vi.fn(),
    getDiscoveryService: vi.fn(),
    setAgentStatusManager: vi.fn(),
    getAgentStatusManager: vi.fn().mockReturnValue(null),
    getServerManager: vi.fn().mockReturnValue({
      stopServer: vi.fn().mockResolvedValue({ success: true }),
      getPort: vi.fn().mockReturnValue(null),
    }),
    ...overrides,
  } as unknown as AppState;
}

function createMockDeps(overrides: Partial<CoreModuleDeps> = {}): CoreModuleDeps {
  const defaults: CoreModuleDeps = {
    appState: createMockAppState(),
  };
  return { ...defaults, ...overrides };
}

// =============================================================================
// Tests
// =============================================================================

describe("core.registration", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("registers workspaces.executeCommand and ui.selectFolder", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("workspaces.executeCommand");
    expect(registeredPaths).toContain("ui.selectFolder");
  });

  it("does not register project query methods (handled by intent dispatcher)", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).not.toContain("projects.open");
    expect(registeredPaths).not.toContain("projects.close");
    expect(registeredPaths).not.toContain("projects.clone");
    expect(registeredPaths).not.toContain("projects.fetchBases");
  });

  it("does not register workspace create/remove (handled by intent dispatcher)", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).not.toContain("workspaces.create");
    expect(registeredPaths).not.toContain("workspaces.remove");
  });

  it("registers ui.selectFolder with correct IPC channel", () => {
    new CoreModule(registry, deps);

    expect(registry.register).toHaveBeenCalledWith("ui.selectFolder", expect.any(Function), {
      ipc: "api:ui:select-folder",
    });
  });
});

describe("CoreModule.dispose", () => {
  let registry: MockApiRegistry;
  let deps: CoreModuleDeps;

  beforeEach(() => {
    registry = createMockRegistry();
    deps = createMockDeps();
  });

  it("dispose is a no-op", () => {
    const module = new CoreModule(registry, deps);
    expect(() => module.dispose()).not.toThrow();
  });
});
