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
// =============================================================================
// Mock Factories
// =============================================================================

function createMockDeps(overrides: Partial<CoreModuleDeps> = {}): CoreModuleDeps {
  const defaults: CoreModuleDeps = {
    resolveWorkspace: vi.fn().mockReturnValue("/mock/workspace"),
    codeServerPort: 0,
    wrapperPath: "/mock/bin/claude",
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
