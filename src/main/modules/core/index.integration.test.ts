/**
 * Integration tests for CoreModule.
 *
 * Note: Workspace deletion tests are in
 * src/main/operations/delete-workspace.integration.test.ts
 * Project open/close/clone tests are in
 * src/main/operations/open-project.integration.test.ts and
 * src/main/operations/close-project.integration.test.ts
 *
 * This file tests CoreModule-specific behavior
 * (e.g., workspace execute command, ui.selectFolder).
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

  it("registers all expected methods", () => {
    new CoreModule(registry, deps);

    const registeredPaths = registry.getRegisteredPaths();
    expect(registeredPaths).toContain("workspaces.executeCommand");
    expect(registeredPaths).toContain("ui.selectFolder");

    // Verify ui.switchWorkspace NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("ui.switchWorkspace");

    // Verify workspace create/remove NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("workspaces.create");
    expect(registeredPaths).not.toContain("workspaces.remove");

    // Verify projects.fetchBases NOT registered (handled by intent dispatcher in bootstrap.ts)
    expect(registeredPaths).not.toContain("projects.fetchBases");

    // Verify project open/close/clone NOT registered (handled by intent dispatcher)
    expect(registeredPaths).not.toContain("projects.open");
    expect(registeredPaths).not.toContain("projects.close");
    expect(registeredPaths).not.toContain("projects.clone");
  });
});
