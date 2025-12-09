/**
 * Test utilities for renderer tests.
 * Provides mock API and helper functions.
 */

import { vi } from "vitest";
import type { Api } from "@shared/electron-api";

/**
 * Creates a mock API object with all functions mocked.
 * All command mocks return sensible defaults.
 * All event subscription mocks return unsubscribe functions.
 */
export function createMockApi(): Api {
  return {
    // Commands
    selectFolder: vi.fn().mockResolvedValue(null),
    openProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    switchWorkspace: vi.fn().mockResolvedValue(undefined),
    listBases: vi.fn().mockResolvedValue([]),
    updateBases: vi.fn().mockResolvedValue(undefined),
    isWorkspaceDirty: vi.fn().mockResolvedValue(false),
    setDialogMode: vi.fn().mockResolvedValue(undefined),
    focusActiveWorkspace: vi.fn().mockResolvedValue(undefined),

    // Agent status commands
    getAgentStatus: vi.fn().mockResolvedValue({ status: "none", counts: { idle: 0, busy: 0 } }),
    getAllAgentStatuses: vi.fn().mockResolvedValue({}),
    refreshAgentStatus: vi.fn().mockResolvedValue(undefined),

    // Setup commands
    setupReady: vi.fn().mockResolvedValue(undefined),
    setupRetry: vi.fn().mockResolvedValue(undefined),
    setupQuit: vi.fn().mockResolvedValue(undefined),

    // Event subscriptions return unsubscribe functions
    onProjectOpened: vi.fn(() => vi.fn()),
    onProjectClosed: vi.fn(() => vi.fn()),
    onWorkspaceCreated: vi.fn(() => vi.fn()),
    onWorkspaceRemoved: vi.fn(() => vi.fn()),
    onWorkspaceSwitched: vi.fn(() => vi.fn()),
    onShortcutEnable: vi.fn(() => vi.fn()),
    onShortcutDisable: vi.fn(() => vi.fn()),
    onAgentStatusChanged: vi.fn(() => vi.fn()),

    // Setup event subscriptions
    onSetupProgress: vi.fn(() => vi.fn()),
    onSetupComplete: vi.fn(() => vi.fn()),
    onSetupError: vi.fn(() => vi.fn()),
  };
}
