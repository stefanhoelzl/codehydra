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

/** Build a project row with sensible defaults (local project). */
export function makeUiProjectRow(
  workspaces: readonly UiWorkspaceRow[],
  overrides?: Partial<UiProjectRow>
): UiProjectRow {
  return {
    id: "test-project-12345678",
    name: "test-project",
    remote: false,
    ...overrides,
    title:
      overrides?.title ?? (overrides?.remote ? "https://example.com/repo.git" : "/test/project"),
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
    mode: "workspace",
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
    // Domain APIs (remove/close are ui:events now, not invokes)
    projects: {
      open: vi.fn().mockResolvedValue({
        id: "test-12345678",
        name: "test",
        path: "/test",
        workspaces: [],
      }),
    },
    workspaces: {
      hibernate: vi.fn().mockResolvedValue({ started: true }),
      wake: vi.fn().mockResolvedValue(MOCK_WORKSPACE_API_DEFAULTS.workspace),
    },
    ui: {
      switchWorkspace: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      quit: vi.fn().mockResolvedValue(undefined),
    },
    emitEvent: vi.fn(),
    on: vi.fn(() => vi.fn()),
    onState: vi.fn(() => vi.fn()),
    onTheme: vi.fn(() => vi.fn()),
    sendDialogEvent: vi.fn(),
    sendNotificationEvent: vi.fn(),
  };
}
