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
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import type { ConfirmHookResult } from "../intents/delete-workspace";
import { INTENT_GET_WORKSPACE_STATUS } from "../intents/get-workspace-status";
import { INTENT_GET_METADATA } from "../intents/get-metadata";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { createDeletionDialogModule } from "./deletion-dialog-module";
import { createMockDialogManager } from "./dialog-manager.state-mock";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DeletionProgress } from "../shared/api/types";
import type { WorkspacePath } from "../shared/ipc";
import type { WorkspaceName, ProjectId } from "../shared/api/types";
import type { DialogConfig } from "../shared/dialog-types";

// =============================================================================
// Test Helpers
// =============================================================================

/** The id of the footer's cancel-role button (the one Escape clicks), or undefined. */
function cancelRoleButtonId(config: DialogConfig): string | undefined {
  for (const section of config.sections) {
    if (section.type !== "group") continue;
    for (const item of section.items) {
      if (item.type === "button" && item.role === "cancel") return item.id;
    }
  }
  return undefined;
}

// =============================================================================
// Test Constants
// =============================================================================

const WS_PATH_A = "/projects/workspace-a" as WorkspacePath;
const WS_PATH_B = "/projects/workspace-b" as WorkspacePath;
const WS_NAME_A = "workspace-a" as WorkspaceName;
const WS_NAME_B = "workspace-b" as WorkspaceName;
const PROJECT_ID = "test-project-12345678" as ProjectId;

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
    ui: dialogManager.ui,
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

    expect(dialogManager.manager.open).toHaveBeenCalledTimes(1);
    expect(dialogManager.lastHandle).not.toBeNull();
    expect(dialogManager.lastHandle!.closed).toBe(false);
  });

  it("should NOT open dialog for non-active workspace", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Switch to workspace A (make it active)
    await fireSwitched(WS_PATH_A);

    // Fire deletion progress for workspace B (not active)
    await fireProgress(makeProgress({ workspacePath: WS_PATH_B, workspaceName: WS_NAME_B }));

    expect(dialogManager.manager.open).not.toHaveBeenCalled();
  });

  it("should update existing dialog on progress update", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    // Make workspace A active and start deletion
    await fireSwitched(WS_PATH_A);
    await fireProgress(makeProgress());

    expect(dialogManager.manager.open).toHaveBeenCalledTimes(1);
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
    expect(dialogManager.manager.open).toHaveBeenCalledTimes(1);
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

    // Config should have a button group for retry and dismiss
    const config = handle.config;
    const group = config.sections.find((s) => s.type === "group");
    expect(group).toBeDefined();
    const buttonIds =
      group?.type === "group"
        ? group.items.filter((i) => i.type === "button").map((i) => i.id)
        : [];
    expect(buttonIds).toContain("retry");
    expect(buttonIds).toContain("dismiss");
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
    expect(dialogManager.manager.open).toHaveBeenCalledTimes(2);
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
    expect(dialogManager.manager.open).toHaveBeenCalledTimes(1);
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

  it("marks Dismiss as the cancel-role button when completed with errors (Escape clicks it)", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    await fireSwitched(WS_PATH_A);
    await fireProgress(
      makeProgress({
        completed: true,
        hasErrors: true,
        operations: [
          { id: "cleanup-workspace", label: "Removing workspace", status: "error", error: "EBUSY" },
        ],
      })
    );

    // The cancel-role marker is what makes the form route Escape to Dismiss;
    // the Dismiss action itself (force-delete + close) is covered above.
    expect(cancelRoleButtonId(dialogManager.lastHandle!.config)).toBe("dismiss");
  });

  it("renders no cancel-role button while deletion is in progress (Escape is a no-op)", async () => {
    const { dialogManager, fireProgress, fireSwitched } = setup;

    await fireSwitched(WS_PATH_A);
    // In progress: no Dismiss button is rendered, so the modal has no
    // cancel-role button and Escape does nothing.
    await fireProgress(makeProgress());

    expect(cancelRoleButtonId(dialogManager.lastHandle!.config)).toBeUndefined();
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
    expect(dialogManager.manager.open).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Remove confirmation (the "confirm" hook on workspace:delete)
// =============================================================================

describe("DeletionDialogModule - remove confirm", () => {
  interface ConfirmSetup {
    dialogManager: ReturnType<typeof createMockDialogManager>;
    /** Resolve the background status/metadata dispatches. */
    resolveStatus(status: { isDirty: boolean; unmergedCommits: number }): void;
    resolveMetadata(metadata: Record<string, string>): void;
    rejectStatus(error: Error): void;
    /** Run the confirm hook (parks until the dialog answers). */
    confirm(): Promise<ConfirmHookResult>;
  }

  function createConfirmSetup(): ConfirmSetup {
    const dialogManager = createMockDialogManager();

    let resolveStatusFn!: (status: unknown) => void;
    let rejectStatusFn!: (error: Error) => void;
    const statusPromise = new Promise((resolve, reject) => {
      resolveStatusFn = resolve;
      rejectStatusFn = reject;
    });
    let resolveMetadataFn!: (metadata: unknown) => void;
    const metadataPromise = new Promise((resolve) => {
      resolveMetadataFn = resolve;
    });

    const dispatcher = {
      dispatch: vi.fn((intent: { type: string }) => {
        if (intent.type === INTENT_GET_WORKSPACE_STATUS) return statusPromise;
        if (intent.type === INTENT_GET_METADATA) return metadataPromise;
        return Promise.resolve();
      }),
    };

    const module = createDeletionDialogModule({
      ui: dialogManager.ui,
      dispatcher: dispatcher as unknown as Dispatcher,
      logger: SILENT_LOGGER,
    });

    const confirm = (): Promise<ConfirmHookResult> =>
      module.hooks![DELETE_WORKSPACE_OPERATION_ID]!["confirm"]!.handler({
        intent: {
          type: INTENT_DELETE_WORKSPACE,
          payload: {
            workspacePath: WS_PATH_A,
            keepBranch: false,
            force: false,
            removeWorktree: true,
            interactive: true,
          },
        },
        projectPath: "/projects",
        workspacePath: WS_PATH_A,
        workspaceName: WS_NAME_A,
        active: true,
      } as unknown as HookContext) as Promise<ConfirmHookResult>;

    return {
      dialogManager,
      resolveStatus: (status) => resolveStatusFn(status),
      resolveMetadata: (metadata) => resolveMetadataFn(metadata),
      rejectStatus: (error) => rejectStatusFn(error),
      confirm,
    };
  }

  /** Flatten the dialog's text contents for assertions. */
  function textsOf(config: { sections: readonly { type: string }[] }): string[] {
    return config.sections
      .filter((s): s is { type: "text"; content: string } => s.type === "text")
      .map((s) => s.content);
  }

  it("opens the dialog immediately with a checking notice and keep-branch checkbox", async () => {
    const setup = createConfirmSetup();

    const pending = setup.confirm();

    const handle = setup.dialogManager.lastHandle!;
    expect(handle).toBeTruthy();
    expect(handle.config.modal).toBe(true);
    expect(textsOf(handle.config)).toEqual([
      "Remove Workspace",
      `Remove workspace "${WS_NAME_A}"?`,
      "Checking workspace status...",
    ]);
    expect(handle.config.sections).toContainEqual({
      type: "checkbox",
      id: "keep-branch",
      label: "Keep branch",
    });

    handle.emitAction("cancel");
    await pending;
  });

  it("fills warnings in when the background status check lands", async () => {
    const setup = createConfirmSetup();
    const pending = setup.confirm();

    setup.resolveStatus({ isDirty: true, unmergedCommits: 2 });
    setup.resolveMetadata({ base: "develop" });
    await vi.waitFor(() => {
      const handle = setup.dialogManager.lastHandle!;
      expect(handle.configs.length).toBeGreaterThan(1);
    });

    const handle = setup.dialogManager.lastHandle!;
    const texts = textsOf(handle.config);
    expect(texts).toContain("This workspace has uncommitted changes that will be lost.");
    expect(texts).toContain("This branch has 2 commits not merged into develop.");
    expect(texts).not.toContain("Checking workspace status...");
    // Warnings carry the warning style.
    const warnings = handle.config.sections.filter(
      (s) => s.type === "text" && "style" in s && s.style === "warning"
    );
    expect(warnings).toHaveLength(2);

    handle.emitAction("cancel");
    await pending;
  });

  it("falls back to no warnings when the status check fails", async () => {
    const setup = createConfirmSetup();
    const pending = setup.confirm();

    setup.rejectStatus(new Error("git broke"));
    await vi.waitFor(() => {
      expect(setup.dialogManager.lastHandle!.configs.length).toBeGreaterThan(1);
    });

    const texts = textsOf(setup.dialogManager.lastHandle!.config);
    expect(texts).toEqual(["Remove Workspace", `Remove workspace "${WS_NAME_A}"?`]);

    setup.dialogManager.lastHandle!.emitAction("cancel");
    await pending;
  });

  it("Remove resolves with the keep-branch answer and closes the dialog", async () => {
    const setup = createConfirmSetup();
    const pending = setup.confirm();
    const handle = setup.dialogManager.lastHandle!;

    handle.emitAction("remove", { "keep-branch": "true" });

    await expect(pending).resolves.toEqual({ keepBranch: true });
    expect(handle.closed).toBe(true);
  });

  it("Cancel resolves canceled and closes the dialog", async () => {
    const setup = createConfirmSetup();
    const pending = setup.confirm();
    const handle = setup.dialogManager.lastHandle!;

    handle.emitAction("cancel", { "keep-branch": "false" });

    await expect(pending).resolves.toEqual({ canceled: true });
    expect(handle.closed).toBe(true);
  });

  it("marks Cancel as the cancel-role button so Escape clicks it", async () => {
    const setup = createConfirmSetup();
    setup.confirm();
    const handle = setup.dialogManager.lastHandle!;

    // Escape routes to Cancel (resolves canceled — covered above).
    expect(cancelRoleButtonId(handle.config)).toBe("cancel");
  });

  it("a status result landing after the answer does not update the closed dialog", async () => {
    const setup = createConfirmSetup();
    const pending = setup.confirm();
    const handle = setup.dialogManager.lastHandle!;

    handle.emitAction("remove", { "keep-branch": "false" });
    await pending;
    const configCount = handle.configs.length;

    setup.resolveStatus({ isDirty: true, unmergedCommits: 1 });
    setup.resolveMetadata({});
    // Give the background task a chance to (incorrectly) update.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle.configs.length).toBe(configCount);
  });
});
