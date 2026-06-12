/**
 * Test utilities for renderer tests.
 * Provides mock API, UiState fixtures, and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";
import type { UiProjectRow, UiState, UiWorkspaceRow } from "@shared/ui-state";
import { MOCK_WORKSPACE_API_DEFAULTS } from "@shared/test-fixtures";

// ============ UiState fixtures ============

/** Build a workspace row with sensible defaults (ready, awake, no agent).
 *  `key` and `path` default to name-derived values when not overridden. */
export function makeUiWorkspaceRow(
  name: string,
  overrides?: Partial<UiWorkspaceRow>
): UiWorkspaceRow {
  const path = overrides?.path ?? `/test/project/.worktrees/${name}`;
  return {
    key: `test-project-12345678/${name}`,
    name,
    status: "ready",
    hibernated: false,
    agent: { type: "none" },
    tags: [],
    active: false,
    ...overrides,
    path,
  };
}

/** Build a project row with sensible defaults (local project).
 *  `title` defaults to the (possibly overridden) path. */
export function makeUiProjectRow(
  workspaces: readonly UiWorkspaceRow[],
  overrides?: Partial<UiProjectRow>
): UiProjectRow {
  const path = overrides?.path ?? "/test/project";
  return {
    id: "test-project-12345678",
    name: "test-project",
    remote: false,
    ...overrides,
    path,
    title: overrides?.title ?? (overrides?.remote ? "https://example.com/repo.git" : path),
    workspaces,
  };
}

/** Build a full UiState snapshot. Default main view: creation (ground state). */
export function makeUiState(
  projects: readonly UiProjectRow[],
  overrides?: Partial<UiState>
): UiState {
  return {
    sidebar: { projects },
    frames: {},
    main: { kind: "creation" },
    theme: "dark",
    ...overrides,
  };
}

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
    onState: vi.fn(() => vi.fn()),
    onModeChange: vi.fn(() => vi.fn()),
    onShortcut: vi.fn(() => vi.fn()),
    onTheme: vi.fn(() => vi.fn()),
    sendDialogEvent: vi.fn(),
    sendNotificationEvent: vi.fn(),
  };
}
