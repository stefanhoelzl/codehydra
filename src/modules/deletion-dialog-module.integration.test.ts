// @vitest-environment node
/**
 * Integration tests for DeletionDialogModule.
 *
 * Tests the module's domain event handlers directly, verifying:
 * - Dialog open/update/close lifecycle based on active workspace
 * - Auto-close on successful completion
 * - Retry/dismiss actions dispatch correct intents
 * - Workspace switch closes old dialog and opens new one
 * - Cleanup on workspace:deleted event
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import {
  EVENT_WORKSPACE_DELETION_PROGRESS,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  INTENT_DELETE_WORKSPACE,
} from "../intents/delete-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { createDeletionDialogModule } from "./deletion-dialog-module";
import type { IntentModule } from "../intents/lib/module";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogAction, DialogConfig, DialogUserEvent } from "../shared/dialog-types";
import type { DeletionProgress } from "../shared/api/types";
import type { WorkspacePath } from "../shared/ipc";
import type { WorkspaceName, ProjectId } from "../shared/api/types";

// =============================================================================
// Test Constants
// =============================================================================

const WS_PATH_A = "/projects/workspace-a" as WorkspacePath;
const WS_PATH_B = "/projects/workspace-b" as WorkspacePath;
const WS_NAME_A = "workspace-a" as WorkspaceName;
const WS_NAME_B = "workspace-b" as WorkspaceName;
const PROJECT_ID = "test-project-12345678" as ProjectId;

// =============================================================================
// Mock DialogManager
// =============================================================================

interface MockHandle {
  id: string;
  config: DialogConfig;
  closed: boolean;
  eventListeners: Set<(event: DialogUserEvent) => void>;
  emitEvent(event: DialogUserEvent): void;
}

interface MockDialogManager {
  handles: MockHandle[];
  lastHandle: MockHandle | null;
  open: ReturnType<typeof vi.fn>;
  routeEvent: () => void;
}

function createMockDialogManager(): MockDialogManager {
  const handles: MockHandle[] = [];
  return {
    handles,
    get lastHandle() {
      return handles[handles.length - 1] ?? null;
    },
    open: vi.fn((config: DialogConfig) => {
      const listeners = new Set<(event: DialogUserEvent) => void>();
      const handle: MockHandle = {
        id: `dlg-test-${handles.length + 1}`,
        config,
        closed: false,
        eventListeners: listeners,
        emitEvent(event) {
          for (const l of listeners) l(event);
        },
      };
      handles.push(handle);
      return {
        id: handle.id,
        update: vi.fn((newConfig: DialogConfig) => {
          handle.config = newConfig;
        }),
        close: vi.fn(() => {
          handle.closed = true;
        }),
        onEvent: vi.fn((handler: (event: DialogUserEvent) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        }),
        nextEvent: vi.fn(),
        closed: new Promise<void>(() => {}),
      } as DialogHandle;
    }),
    routeEvent() {},
  } as unknown as MockDialogManager;
}

// =============================================================================
// Mock Dispatcher
// =============================================================================

function createMockDispatcher() {
  const dispatched: Array<{ type: string; payload: unknown }> = [];
  return {
    dispatched,
    dispatch: vi.fn((intent: { type: string; payload: unknown }) => {
      dispatched.push(intent);
      return Promise.resolve();
    }),
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

function makeProgress(overrides?: Partial<DeletionProgress>): DeletionProgress {
  return {
    workspacePath: WS_PATH_A,
    workspaceName: WS_NAME_A,
    projectId: PROJECT_ID,
    keepBranch: false,
    operations: [
      { id: "kill-terminals", label: "Terminating processes", status: "in-progress" },
      { id: "stop-server", label: "Stopping agent server", status: "pending" },
      { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
      { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
    ],
    completed: false,
    hasErrors: false,
    ...overrides,
  };
}

interface TestSetup {
  module: IntentModule;
  dialogManager: ReturnType<typeof createMockDialogManager>;
  dispatcher: ReturnType<typeof createMockDispatcher>;
  fireProgress(progress: DeletionProgress): Promise<void>;
  fireSwitched(path: string | null): Promise<void>;
  fireDeleted(workspacePath: string): Promise<void>;
}

function createTestSetup(): TestSetup {
  const dialogManager = createMockDialogManager();
  const dispatcher = createMockDispatcher();

  const module = createDeletionDialogModule({
    dialogManager: dialogManager as unknown as DialogManager,
    dispatcher: dispatcher as unknown as Dispatcher,
    logger: SILENT_LOGGER,
  });

  const fireProgress = async (progress: DeletionProgress): Promise<void> => {
    await module.events![EVENT_WORKSPACE_DELETION_PROGRESS]!.handler({
      type: EVENT_WORKSPACE_DELETION_PROGRESS,
      payload: progress,
    });
  };

  const fireSwitched = async (path: string | null): Promise<void> => {
    await module.events![EVENT_WORKSPACE_SWITCHED]!.handler({
      type: EVENT_WORKSPACE_SWITCHED,
      payload: path !== null ? { path } : null,
    });
  };

  const fireDeleted = async (workspacePath: string): Promise<void> => {
    await module.events![EVENT_WORKSPACE_DELETED]!.handler({
      type: EVENT_WORKSPACE_DELETED,
      payload: { workspacePath },
    });
  };

  return { module, dialogManager, dispatcher, fireProgress, fireSwitched, fireDeleted };
}

// =============================================================================
// Tests
// =============================================================================

describe("DeletionDialogModule", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  it("should open dialog when active workspace starts deletion", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Switch to workspace A (make it active)
    await fireSwitched(WS_PATH_A);

    // Fire deletion progress for workspace A
    await fireProgress(makeProgress());

    expect(dialogManager.open).toHaveBeenCalledTimes(1);
    expect(dialogManager.lastHandle).not.toBeNull();
    expect(dialogManager.lastHandle!.closed).toBe(false);
  });

  it("should NOT open dialog for non-active workspace", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Switch to workspace A (make it active)
    await fireSwitched(WS_PATH_A);

    // Fire deletion progress for workspace B (not active)
    await fireProgress(makeProgress({ workspacePath: WS_PATH_B, workspaceName: WS_NAME_B }));

    expect(dialogManager.open).not.toHaveBeenCalled();
  });

  it("should update existing dialog on progress update", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    expect(dialogManager.open).toHaveBeenCalledTimes(1);
    const handle = dialogManager.lastHandle!;

    // Fire another progress event
    const updatedProgress = makeProgress({
      operations: [
        { id: "kill-terminals", label: "Terminating processes", status: "done" },
        { id: "stop-server", label: "Stopping agent server", status: "in-progress" },
        { id: "cleanup-vscode", label: "Closing VS Code view", status: "pending" },
        { id: "cleanup-workspace", label: "Removing workspace", status: "pending" },
      ],
    });
    await fireProgress(updatedProgress);

    // Should not open a new dialog, just update
    expect(dialogManager.open).toHaveBeenCalledTimes(1);
    // The config should have been updated (verify via the mock handle's config)
    expect(handle.config).toBeDefined();
  });

  it("should auto-close dialog on successful completion", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    const handle = dialogManager.lastHandle!;
    expect(handle.closed).toBe(false);

    // Fire completed progress with no errors
    await fireProgress(
      makeProgress({
        completed: true,
        hasErrors: false,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "stop-server", label: "Stopping agent server", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "done" },
        ],
      })
    );

    expect(handle.closed).toBe(true);
  });

  it("should keep dialog open on error completion with retry/dismiss actions", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    const handle = dialogManager.lastHandle!;

    // Fire completed progress WITH errors
    await fireProgress(
      makeProgress({
        completed: true,
        hasErrors: true,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "stop-server", label: "Stopping agent server", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          {
            id: "cleanup-workspace",
            label: "Removing workspace",
            status: "error",
            error: "EBUSY",
          },
        ],
      })
    );

    // Dialog should remain open
    expect(handle.closed).toBe(false);

    // Config should have actions for retry and dismiss
    const config = handle.config;
    expect(config.actions).toBeDefined();
    const actionIds = config.actions!.map((a: DialogAction) => a.id);
    expect(actionIds).toContain("retry");
    expect(actionIds).toContain("dismiss");
  });

  it("should close old dialog and open new on workspace switch", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    const handleA = dialogManager.lastHandle!;
    expect(handleA.closed).toBe(false);

    // Also track deletion for workspace B
    await fireProgress(makeProgress({ workspacePath: WS_PATH_B, workspaceName: WS_NAME_B }));

    // Switch to workspace B (which also has deletion progress)
    await fireSwitched(WS_PATH_B);

    // Old dialog should be closed
    expect(handleA.closed).toBe(true);

    // New dialog should be opened for workspace B
    expect(dialogManager.open).toHaveBeenCalledTimes(2);
    const handleB = dialogManager.lastHandle!;
    expect(handleB.closed).toBe(false);
  });

  it("should close dialog on workspace switch to workspace without deletion", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    const handle = dialogManager.lastHandle!;
    expect(handle.closed).toBe(false);

    // Switch to workspace B (no deletion progress)
    await fireSwitched(WS_PATH_B);

    // Dialog should be closed
    expect(handle.closed).toBe(true);

    // No new dialog should be opened
    expect(dialogManager.open).toHaveBeenCalledTimes(1);
  });

  it("should dispatch delete intent on retry", async () => {
    const { dialogManager, dispatcher, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion with blocking processes
    await fireSwitched(WS_PATH_A);
    const progress = makeProgress({
      completed: true,
      hasErrors: true,
      keepBranch: true,
      blockingProcesses: [
        {
          pid: 1234,
          name: "node.exe",
          commandLine: "node server.js",
          files: ["file.lock"],
          cwd: null,
        },
      ],
      operations: [
        { id: "kill-terminals", label: "Terminating processes", status: "done" },
        { id: "stop-server", label: "Stopping agent server", status: "done" },
        { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
        { id: "cleanup-workspace", label: "Removing workspace", status: "error", error: "EBUSY" },
      ],
    });
    await fireProgress(progress);

    const handle = dialogManager.lastHandle!;

    // Emit "retry" user event
    handle.emitEvent({ dialogId: handle.id, actionId: "retry" });

    // Allow the void dispatch to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatcher.dispatch).toHaveBeenCalled();
    const retryIntent = dispatcher.dispatched.find((d) => d.type === INTENT_DELETE_WORKSPACE);
    expect(retryIntent).toBeDefined();
    const payload = retryIntent!.payload as Record<string, unknown>;
    expect(payload.workspacePath).toBe(WS_PATH_A);
    expect(payload.keepBranch).toBe(true);
    expect(payload.ignoreWarnings).toBe(true);
    expect(payload.blockingPids).toEqual([1234]);
    expect(payload.force).toBe(false);
  });

  it("should dispatch force delete intent on dismiss", async () => {
    const { dialogManager, dispatcher, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(
      makeProgress({
        completed: true,
        hasErrors: true,
        operations: [
          { id: "kill-terminals", label: "Terminating processes", status: "done" },
          { id: "stop-server", label: "Stopping agent server", status: "done" },
          { id: "cleanup-vscode", label: "Closing VS Code view", status: "done" },
          { id: "cleanup-workspace", label: "Removing workspace", status: "error", error: "EBUSY" },
        ],
      })
    );

    const handle = dialogManager.lastHandle!;

    // Emit "dismiss" user event
    handle.emitEvent({ dialogId: handle.id, actionId: "dismiss" });

    // Allow the void dispatch to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Dialog should be closed
    expect(handle.closed).toBe(true);

    // Force delete intent should be dispatched
    expect(dispatcher.dispatch).toHaveBeenCalled();
    const forceIntent = dispatcher.dispatched.find((d) => d.type === INTENT_DELETE_WORKSPACE);
    expect(forceIntent).toBeDefined();
    const payload = forceIntent!.payload as Record<string, unknown>;
    expect(payload.workspacePath).toBe(WS_PATH_A);
    expect(payload.force).toBe(true);
    expect(payload.ignoreWarnings).toBe(true);
  });

  it("should clean up on EVENT_WORKSPACE_DELETED", async () => {
    const { dialogManager, fireProgress, fireSwitched, fireDeleted } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    const handle = dialogManager.lastHandle!;
    expect(handle.closed).toBe(false);

    // Fire workspace deleted event
    await fireDeleted(WS_PATH_A);

    // Dialog should be closed
    expect(handle.closed).toBe(true);

    // Switching back to workspace A should not re-open dialog (progress was cleaned up)
    await fireSwitched(WS_PATH_A);
    expect(dialogManager.open).toHaveBeenCalledTimes(1);
  });

  it("should handle EVENT_WORKSPACE_DELETE_FAILED as no-op", async () => {
    // The module registers a handler for this event but it's a no-op
    const { module } = setup;

    // Should not throw
    await module.events![EVENT_WORKSPACE_DELETE_FAILED]!.handler({
      type: EVENT_WORKSPACE_DELETE_FAILED,
      payload: { workspacePath: WS_PATH_A },
    });
  });
});
