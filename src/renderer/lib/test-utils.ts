/**
 * Test utilities for renderer tests.
 * Provides mock API and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";

/**
 * Creates a mock API object with all functions mocked.
 *
 * The API has two layers:
 * 1. Setup commands/events - available during setup
 * 2. Normal API (projects, workspaces, ui, lifecycle, on) - primary API for normal operation
 */
export function createMockApi(): Api {
  return {
    // Setup commands (needed during setup before normal handlers are registered)
    setupReady: vi.fn().mockResolvedValue({ ready: true }),
    setupRetry: vi.fn().mockResolvedValue(undefined),
    setupQuit: vi.fn().mockResolvedValue(undefined),

    // Setup event subscriptions
    onSetupProgress: vi.fn(() => vi.fn()),
    onSetupComplete: vi.fn(() => vi.fn()),
    onSetupError: vi.fn(() => vi.fn()),

    // Normal API
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
      create: vi.fn().mockResolvedValue({
        projectId: "test-12345678",
        name: "ws",
        branch: "ws",
        path: "/ws",
      }),
      remove: vi.fn().mockResolvedValue({ branchDeleted: false }),
      get: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({ isDirty: false, agent: { type: "none" } }),
    },
    ui: {
      selectFolder: vi.fn().mockResolvedValue(null),
      getActiveWorkspace: vi.fn().mockResolvedValue(null),
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      getState: vi.fn().mockResolvedValue("ready"),
      setup: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue(undefined),
    },
    on: vi.fn(() => vi.fn()),
    onModeChange: vi.fn(() => vi.fn()),
    onShortcut: vi.fn(() => vi.fn()),
  };
}
