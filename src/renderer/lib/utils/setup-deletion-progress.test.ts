/**
 * Tests for setupDeletionProgress setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DeletionProgress, ProjectId, WorkspaceName } from "@shared/api/types";
import type { WorkspacePath } from "@shared/ipc";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  on: vi.fn(() => vi.fn()),
}));

import { setupDeletionProgress, type DeletionProgressApi } from "./setup-deletion-progress";
import * as lifecycleStore from "$lib/stores/workspace-lifecycle.svelte.js";

// =============================================================================
// Test Data
// =============================================================================

const TEST_WORKSPACE_PATH = "/test/project/.worktrees/feature" as WorkspacePath;
const TEST_PROJECT_ID = "my-project-a1b2c3d4" as ProjectId;
const TEST_WORKSPACE_NAME = "feature-branch" as WorkspaceName;

const TEST_PROGRESS: DeletionProgress = {
  workspacePath: TEST_WORKSPACE_PATH,
  workspaceName: TEST_WORKSPACE_NAME,
  projectId: TEST_PROJECT_ID,
  keepBranch: false,
  operations: [
    { id: "kill-terminals", label: "Closing terminals", status: "done" },
    { id: "stop-server", label: "Stopping server", status: "in-progress" },
  ],
  completed: false,
  hasErrors: false,
};

// =============================================================================
// Mock API Factory
// =============================================================================

type DeletionProgressHandler = (payload: DeletionProgress) => void;

function createMockApi(): {
  api: DeletionProgressApi;
  emit: (progress: DeletionProgress) => void;
  unsubscribeCalled: () => boolean;
} {
  let handler: DeletionProgressHandler | undefined;
  let unsubscribed = false;

  const api: DeletionProgressApi = {
    on: (_event: "workspace:deletion-progress", h: DeletionProgressHandler) => {
      handler = h;
      return () => {
        handler = undefined;
        unsubscribed = true;
      };
    },
  };

  const emit = (progress: DeletionProgress): void => {
    handler?.(progress);
  };

  return { api, emit, unsubscribeCalled: () => unsubscribed };
}

// =============================================================================
// Tests
// =============================================================================

describe("setupDeletionProgress", () => {
  beforeEach(() => {
    lifecycleStore.reset();
  });

  afterEach(() => {
    lifecycleStore.reset();
  });

  it("updates store when deletion progress event is emitted", () => {
    const { api, emit } = createMockApi();

    setupDeletionProgress(api);

    emit(TEST_PROGRESS);

    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toEqual({
      kind: "deleting",
      progress: TEST_PROGRESS,
    });
    expect(lifecycleStore.getLifecycle(TEST_WORKSPACE_PATH)).toBe("deleting");
  });

  it("auto-clears store on successful completion", () => {
    const { api, emit } = createMockApi();

    setupDeletionProgress(api);

    // First emit a regular progress
    emit(TEST_PROGRESS);
    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toBeDefined();

    // Then emit completed without errors
    const completedProgress: DeletionProgress = {
      ...TEST_PROGRESS,
      completed: true,
      hasErrors: false,
    };
    emit(completedProgress);

    // Should be cleared
    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toBeUndefined();
    expect(lifecycleStore.getLifecycle(TEST_WORKSPACE_PATH)).toBe("none");
  });

  it("does not auto-clear on completion with errors", () => {
    const { api, emit } = createMockApi();

    setupDeletionProgress(api);

    const errorProgress: DeletionProgress = {
      ...TEST_PROGRESS,
      completed: true,
      hasErrors: true,
      operations: [
        ...TEST_PROGRESS.operations,
        {
          id: "cleanup-workspace",
          label: "Removing files",
          status: "error",
          error: "Permission denied",
        },
      ],
    };
    emit(errorProgress);

    // Should remain in store for retry/close anyway
    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toEqual({
      kind: "deleting",
      progress: errorProgress,
    });
    expect(lifecycleStore.getLifecycle(TEST_WORKSPACE_PATH)).toBe("delete-failed");
  });

  it("cleanup stops updates", () => {
    const { api, emit, unsubscribeCalled } = createMockApi();

    const cleanup = setupDeletionProgress(api);

    // Emit before cleanup
    emit(TEST_PROGRESS);
    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toBeDefined();

    // Clear and cleanup
    lifecycleStore.reset();
    cleanup();

    // Verify unsubscribe was called
    expect(unsubscribeCalled()).toBe(true);

    // Emit after cleanup - should not update store
    emit(TEST_PROGRESS);
    expect(lifecycleStore.lifecycleEntries.value.get(TEST_WORKSPACE_PATH)).toBeUndefined();
  });

  it("handles multiple workspaces independently", () => {
    const { api, emit } = createMockApi();

    setupDeletionProgress(api);

    const workspace1Path = "/test/project/.worktrees/feature1" as WorkspacePath;
    const workspace2Path = "/test/project/.worktrees/feature2" as WorkspacePath;

    const progress1: DeletionProgress = {
      ...TEST_PROGRESS,
      workspacePath: workspace1Path,
    };
    const progress2: DeletionProgress = {
      ...TEST_PROGRESS,
      workspacePath: workspace2Path,
      workspaceName: "feature-2" as WorkspaceName,
    };

    emit(progress1);
    emit(progress2);

    expect(lifecycleStore.lifecycleEntries.value.get(workspace1Path)).toEqual({
      kind: "deleting",
      progress: progress1,
    });
    expect(lifecycleStore.lifecycleEntries.value.get(workspace2Path)).toEqual({
      kind: "deleting",
      progress: progress2,
    });

    // Complete workspace1
    emit({ ...progress1, completed: true, hasErrors: false });

    // Workspace1 cleared, workspace2 still exists
    expect(lifecycleStore.lifecycleEntries.value.get(workspace1Path)).toBeUndefined();
    expect(lifecycleStore.lifecycleEntries.value.get(workspace2Path)).toEqual({
      kind: "deleting",
      progress: progress2,
    });
  });
});
