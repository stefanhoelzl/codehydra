/**
 * Test utilities for renderer tests.
 * Provides mock API and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";
import { MOCK_WORKSPACE_API_DEFAULTS } from "@shared/test-fixtures";

/**
 * Creates a mock API object with all functions mocked.
 *
 * Setup operations use lifecycle API:
 * - lifecycle.getState() returns { state: "setup" | "loading" | "agent-selection", agent: ConfigAgentType | null }
 * - lifecycle.setup() runs setup and returns success/failure (does NOT start services)
 * - lifecycle.startServices() starts services and returns success/failure
 * - lifecycle.setAgent() saves agent selection to config
 * - lifecycle.quit() quits the app
 */
export function createMockApi(): Api {
  return {
    // Domain APIs
    projects: {
      open: vi.fn().mockResolvedValue({
        id: "test-12345678",
        name: "test",
        path: "/test",
        workspaces: [],
      }),
      close: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    },
    workspaces: {
      create: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.workspace),
      remove: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.removeResult),
      forceRemove: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.status),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.metadata),
      getOpencodePort: vi.fn().mockResolvedValue(null),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue({ state: "loading", agent: "opencode" }),
      setup: vi.fn().mockResolvedValue({ success: true }),
      startServices: vi.fn().mockResolvedValue({ success: true }),
      setAgent: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(() => vi.fn()),
    onModeChange: vi.fn(() => vi.fn()),
    onShortcut: vi.fn(() => vi.fn()),
  };
}
