/**
 * Test utilities for renderer tests.
 * Provides mock API, UiState fixtures, and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";
import type { UiProjectRow, UiState, UiWorkspaceRow } from "@shared/ui-state";

// ============ UiState fixtures ============

/** Build a workspace row with sensible defaults (ready, awake, no agent).
 *  `key` defaults to a name-derived value when not overridden. */
export function makeUiWorkspaceRow(
  name: string,
  overrides?: Partial<UiWorkspaceRow>
): UiWorkspaceRow {
  return {
    key: `test-project-12345678/${name}`,
    name,
    status: "ready",
    hibernated: false,
    agent: { type: "none" },
    tags: [],
    active: false,
    ...overrides,
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
    // All renderer→main gestures are ui:events now (emitEvent); the only
    // remaining command invoke is lifecycle.quit.
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
