/**
 * DeletionDialogModule - Shows deletion progress dialog only when the
 * workspace being deleted is the active (selected) workspace.
 *
 * Subscribes to EVENT_WORKSPACE_DELETION_PROGRESS, EVENT_WORKSPACE_DELETED,
 * and EVENT_WORKSPACE_SWITCHED. Opens/closes the dialog based on which
 * workspace is currently active — behaves like a workspace view replacement.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type {
  DialogConfig,
  DialogSection,
  DialogAction,
  ProgressItem,
  TableColumn,
  TableRow,
} from "../shared/dialog-types";
import type { DeletionProgress, DeletionOperationStatus } from "../shared/api/types";
import {
  EVENT_WORKSPACE_DELETION_PROGRESS,
  EVENT_WORKSPACE_DELETED,
  EVENT_WORKSPACE_DELETE_FAILED,
  INTENT_DELETE_WORKSPACE,
} from "../intents/delete-workspace";
import type {
  WorkspaceDeletionProgressEvent,
  WorkspaceDeletedEvent,
  DeleteWorkspaceIntent,
} from "../intents/delete-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import type { Logger } from "../boundaries/platform/logging";

/**
 * Dependencies for the deletion dialog module.
 */
export interface DeletionDialogModuleDeps {
  readonly dialogManager: DialogManager;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
}

/**
 * Map DeletionOperationStatus to ProgressItem status.
 */
function mapStatus(status: DeletionOperationStatus): ProgressItem["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "in-progress":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

/**
 * Build a DialogConfig from DeletionProgress.
 */
function buildConfig(progress: DeletionProgress): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Removing workspace", style: "heading" },
    { type: "text", content: `"${progress.workspaceName}"`, style: "subtitle" },
  ];

  const items: ProgressItem[] = progress.operations.map((op) => ({
    id: op.id,
    label: op.label,
    status: mapStatus(op.status),
    ...(op.error !== undefined && { message: op.error }),
  }));

  sections.push({ type: "progress", items, style: "spinner" });

  const blockers = progress.blockingProcesses;
  if (blockers && blockers.length > 0) {
    const processCount = blockers.length;
    const fileCount = blockers.reduce((sum, p) => sum + p.files.length, 0);
    const columns: TableColumn[] = [
      { key: "name", label: "Process" },
      { key: "pid", label: "PID" },
      { key: "command", label: "Command" },
      { key: "files", label: "Files" },
    ];
    const rows: TableRow[] = blockers.map((p) => ({
      name: p.name,
      pid: String(p.pid),
      command: truncate(p.commandLine, 60),
      files: p.files.length > 0 ? `${p.files.length} file(s)` : (p.cwd ?? "(none)"),
    }));
    sections.push({
      type: "table",
      header: `Blocked by ${processCount} process(es) holding ${fileCount} file(s)`,
      headerIcon: "warning",
      columns,
      rows,
    });
  }

  const actions: DialogAction[] = [];
  if (progress.completed && progress.hasErrors) {
    const hasBlockers = blockers && blockers.length > 0;
    actions.push({
      id: "retry",
      label: hasBlockers ? "Kill & Retry" : "Retry",
    });
    actions.push({
      id: "dismiss",
      label: "Dismiss",
      variant: "secondary",
      title:
        "Close dialog. Workspace will be removed from CodeHydra, but blocking processes and files may remain on disk.",
    });
  }

  return { sections, ...(actions.length > 0 && { actions }) };
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  const tail = Math.min(20, Math.floor(max / 3));
  const head = max - tail - 3;
  return str.slice(0, head) + "..." + str.slice(-tail);
}

/**
 * Dispatch a delete-workspace intent (fire-and-forget).
 */
function dispatchDelete(dispatcher: Dispatcher, payload: DeleteWorkspaceIntent["payload"]): void {
  const intent: DeleteWorkspaceIntent = {
    type: INTENT_DELETE_WORKSPACE,
    payload,
  };
  const handle = dispatcher.dispatch(intent);
  void handle.catch(() => {});
}

/**
 * Create the deletion dialog module.
 */
export function createDeletionDialogModule(deps: DeletionDialogModuleDeps): IntentModule {
  // All active deletions (keyed by workspace path)
  const progressMap = new Map<string, DeletionProgress>();
  // Currently visible dialog (only one at a time — the active workspace's)
  let activeDialog: { path: string; handle: DialogHandle } | null = null;
  // Currently active workspace path
  let activeWorkspacePath: string | null = null;

  /** Wire retry/dismiss event handlers on a dialog handle. */
  function wireEvents(handle: DialogHandle, workspacePath: string): void {
    handle.onEvent((evt) => {
      const progress = progressMap.get(workspacePath);
      if (!progress) return;

      if (evt.actionId === "retry") {
        deps.logger.debug("Deletion retry", { workspace: workspacePath });
        const pids = progress.blockingProcesses?.map((p) => p.pid);
        dispatchDelete(deps.dispatcher, {
          workspacePath,
          keepBranch: progress.keepBranch,
          force: false,
          removeWorktree: true,
          ignoreWarnings: true,
          skipSwitch: true,
          ...(pids && { blockingPids: pids }),
        });
      } else if (evt.actionId === "dismiss") {
        deps.logger.debug("Deletion dismiss", { workspace: workspacePath });
        handle.close();
        activeDialog = null;
        progressMap.delete(workspacePath);
        dispatchDelete(deps.dispatcher, {
          workspacePath,
          keepBranch: false,
          force: true,
          removeWorktree: true,
          ignoreWarnings: true,
        });
      }
    });
  }

  /** Open dialog for the given workspace if it has deletion progress. */
  function showDialogForWorkspace(path: string): void {
    const progress = progressMap.get(path);
    if (!progress) return;
    const handle = deps.dialogManager.open(buildConfig(progress));
    activeDialog = { path, handle };
    wireEvents(handle, path);
  }

  /** Close the active dialog if it exists. */
  function closeActiveDialog(): void {
    if (activeDialog) {
      activeDialog.handle.close();
      activeDialog = null;
    }
  }

  const events: EventDeclarations = {
    [EVENT_WORKSPACE_DELETION_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const progress = (event as WorkspaceDeletionProgressEvent).payload;
        const key = progress.workspacePath;

        // Update stored progress
        progressMap.set(key, progress);

        // If this workspace's dialog is currently showing, update it
        if (activeDialog && activeDialog.path === key) {
          activeDialog.handle.update(buildConfig(progress));
        } else if (key === activeWorkspacePath && !activeDialog) {
          // Active workspace just started deletion — open dialog
          showDialogForWorkspace(key);
        }

        // Auto-close on successful completion
        if (progress.completed && !progress.hasErrors) {
          if (activeDialog?.path === key) {
            closeActiveDialog();
          }
          progressMap.delete(key);
        }
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as WorkspaceSwitchedEvent).payload;
        const newPath = payload?.path ?? null;

        // Close dialog if switching away from the workspace with deletion
        if (activeDialog && activeDialog.path !== newPath) {
          closeActiveDialog();
        }

        activeWorkspacePath = newPath;

        // Open dialog if the new workspace has deletion progress
        if (newPath && progressMap.has(newPath) && !activeDialog) {
          showDialogForWorkspace(newPath);
        }
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        if (activeDialog?.path === workspacePath) {
          closeActiveDialog();
        }
        progressMap.delete(workspacePath);
      },
    },
    [EVENT_WORKSPACE_DELETE_FAILED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        void event;
      },
    },
  };

  return {
    name: "deletion-dialog",
    events,
  };
}
