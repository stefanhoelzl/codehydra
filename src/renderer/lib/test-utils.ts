/**
 * Test utilities for renderer tests.
 * Provides mock API, UiState fixtures, and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";
import type {
  UiProjectRow,
  UiRowHibernation,
  UiState,
  UiWorkspaceRow,
  UiWorkspaceRowFields,
} from "@shared/ui-state";

// ============ UiState fixtures ============

/** When a fixture row hibernated, unless the test says. */
export const DEFAULT_HIBERNATED_AT = "2026-11-01T12:00:00.000Z";

/**
 * What a test may override on a row: any field, with the hibernation ones
 * flat — `hibernatedAt` defaults to `DEFAULT_HIBERNATED_AT` on a hibernated
 * row and is dropped (with `wakeupScript`) from an awake one.
 */
export type UiWorkspaceRowOverrides = Partial<UiWorkspaceRowFields> & {
  readonly hibernated?: boolean;
  readonly hibernatedAt?: string;
  readonly wakeupScript?: string;
};

/** Build a workspace row with sensible defaults (ready, awake, no agent).
 *  `key` defaults to a name-derived value when not overridden. */
export function makeUiWorkspaceRow(
  name: string,
  overrides: UiWorkspaceRowOverrides = {}
): UiWorkspaceRow {
  const { hibernated, hibernatedAt, wakeupScript, ...fields } = overrides;
  const hibernation: UiRowHibernation = hibernated
    ? {
        hibernated: true,
        hibernatedAt: hibernatedAt ?? DEFAULT_HIBERNATED_AT,
        ...(wakeupScript !== undefined && { wakeupScript }),
      }
    : { hibernated: false };
  return {
    key: `test-project-12345678/${name}`,
    name,
    status: "ready",
    agent: { type: "none" },
    fresh: false,
    tags: [],
    active: false,
    ...fields,
    ...hibernation,
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
    colorIndex: 0,
    collapsed: false,
    hibernatedView: "hidden",
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
    sidebar: {
      projects,
      width: 288,
      mode: "overlay",
      find: null,
      processSummary: "off",
      processLevel: "total",
      processTreeHeight: 0.25,
    },
    frames: {},
    main: { kind: "creation" },
    theme: "dark",
    silent: false,
    mode: "workspace",
    capturing: false,
    dialogs: [],
    notifications: [],
    ...overrides,
  };
}

/**
 * Creates a mock API object with all functions mocked.
 *
 * All renderer→main gestures are fire-and-forget ui:events (emitEvent); there
 * are no command invokes. Quit is requested via the `setup-quit` ui:event.
 */
export function createMockApi(): Api {
  return {
    emitEvent: vi.fn(),
    onState: vi.fn(() => vi.fn()),
  };
}
