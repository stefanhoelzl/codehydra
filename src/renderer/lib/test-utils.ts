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
    },
    workspaces: {
      remove: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.removeResult),
      getStatus: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.status),
      hibernate: vi.fn().mockResolvedValue({ started: true }),
      wake: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.workspace),
      getScreenshot: vi.fn().mockResolvedValue({ url: null }),
    },
    ui: {
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      ready: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
    },
    emitEvent: vi.fn(),
    on: vi.fn(() => vi.fn()),
    onModeChange: vi.fn(() => vi.fn()),
    onShortcut: vi.fn(() => vi.fn()),
    onTheme: vi.fn(() => vi.fn()),
    sendDialogEvent: vi.fn(),
    sendNotificationEvent: vi.fn(),
  };
}
