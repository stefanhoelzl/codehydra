/**
 * DeletionDialogModule - Owns the dialogs of the workspace-deletion flow:
 *
 * 1. Remove confirmation: the "confirm" hook on workspace:delete (interactive
 *    dispatches). Opens instantly, runs the dirty/unmerged status check in
 *    the background and updates the warnings in, parks the dispatch until the
 *    user answers (keepBranch or cancel).
 * 2. Deletion progress: shown only when the workspace being deleted is the
 *    active (selected) workspace. Subscribes to
 *    EVENT_WORKSPACE_DELETION_PROGRESS, EVENT_WORKSPACE_DELETED, and
 *    EVENT_WORKSPACE_SWITCHED — behaves like a workspace view replacement,
 *    with retry/dismiss on failure.
 */

import type { IntentModule, EventDeclarations, HookDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogHandle } from "./presentation/sessions";
import type { UiPresenter } from "./presentation/presentation-module";
import type {
  DialogConfig,
  DialogSection,
  ProgressItem,
  TableColumn,
  TableRow,
} from "../shared/dialog-types";
import type { DeletionProgress, DeletionOperationStatus } from "../shared/api/types";
import {
  EVENT_WORKSPACE_DELETION_PROGRESS,
  EVENT_WORKSPACE_DELETED,
  INTENT_DELETE_WORKSPACE,
  DELETE_WORKSPACE_OPERATION_ID,
} from "../intents/delete-workspace";
import type {
  WorkspaceDeletionProgressEvent,
  WorkspaceDeletedEvent,
  DeleteWorkspaceIntent,
  DeletePipelineHookInput,
  ConfirmHookResult,
} from "../intents/delete-workspace";
import {
  INTENT_GET_WORKSPACE_STATUS,
  type GetWorkspaceStatusIntent,
} from "../intents/get-workspace-status";
import { INTENT_GET_METADATA, type GetMetadataIntent } from "../intents/get-metadata";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import type { Logger } from "../boundaries/platform/logging";
import { getErrorMessage } from "../shared/error-utils";

/**
 * Dependencies for the deletion dialog module.
 */
export interface DeletionDialogModuleDeps {
  readonly ui: Pick<UiPresenter, "dialog" | "deletionProgress">;
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

  if (progress.completed && progress.hasErrors) {
    const hasBlockers = blockers && blockers.length > 0;
    sections.push({
      type: "group",
      items: [
        {
          type: "button",
          id: "retry",
          label: hasBlockers ? "Kill & Retry" : "Retry",
          variant: "primary",
        },
        {
          type: "button",
          id: "dismiss",
          label: "Dismiss",
          variant: "secondary",
          // role "cancel": Escape clicks Dismiss. Only rendered when the
          // deletion completed with errors, so mid-deletion Escape is a no-op.
          role: "cancel",
          title:
            "Close dialog. Workspace will be removed from CodeHydra, but blocking processes and files may remain on disk.",
        },
      ],
    });
  }

  return { sections };
}

/** Display state of the remove confirmation dialog. */
interface RemoveConfirmState {
  readonly workspaceName: string;
  /** The background dirty/unmerged status check is still running. */
  readonly checking: boolean;
  /** The background status check failed — dirty/unmerged state is unknown. */
  readonly checkFailed: boolean;
  readonly isDirty: boolean;
  readonly unmergedCommits: number;
  /** Base branch name (workspace metadata), for the unmerged warning text. */
  readonly base: string | undefined;
}

/** Build the remove confirmation DialogConfig from its display state. */
function buildRemoveConfirmConfig(state: RemoveConfirmState): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Remove Workspace", style: "heading" },
    { type: "text", content: `Remove workspace "${state.workspaceName}"?` },
  ];

  if (state.checking) {
    // Warning, not a dim subtitle: Remove is live while the check runs, so
    // "we don't know yet whether this loses your work" is a caution to weigh.
    sections.push({ type: "text", content: "Checking workspace status...", style: "warning" });
  } else if (state.checkFailed) {
    sections.push({
      type: "text",
      content:
        "Could not check workspace status. Uncommitted changes or unmerged commits may be lost.",
      style: "warning",
    });
  } else {
    if (state.isDirty) {
      sections.push({
        type: "text",
        content: "This workspace has uncommitted changes that will be lost.",
        style: "warning",
      });
    }
    if (state.unmergedCommits > 0) {
      const plural = state.unmergedCommits === 1 ? "" : "s";
      sections.push({
        type: "text",
        content: `This branch has ${state.unmergedCommits} commit${plural} not merged into ${state.base ?? "base"}.`,
        style: "warning",
      });
    }
  }

  sections.push({ type: "checkbox", id: "keep-branch", label: "Keep branch" });
  sections.push({
    type: "group",
    items: [
      { type: "button", id: "remove", label: "Remove", variant: "primary" },
      // role "cancel": Escape clicks Cancel. The form auto-focuses the
      // first field (the keep-branch checkbox) on mount.
      { type: "button", id: "cancel", label: "Cancel", variant: "secondary", role: "cancel" },
    ],
  });

  return { sections };
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
  // Currently visible dialog (only one at a time — the active workspace's).
  // Deletion progress itself is owned by the presenter (single source of
  // truth); this module reads it via deps.ui.deletionProgress(path).
  let activeDialog: { path: string; handle: DialogHandle } | null = null;
  // Currently active workspace path
  let activeWorkspacePath: string | null = null;

  /** Wire retry/dismiss event handlers on a dialog handle. */
  function wireEvents(handle: DialogHandle, workspacePath: string): void {
    function dismiss(): void {
      deps.logger.debug("Deletion dismiss", { workspace: workspacePath });
      handle.close();
      activeDialog = null;
      dispatchDelete(deps.dispatcher, {
        workspacePath,
        keepBranch: false,
        force: true,
        removeWorktree: true,
        ignoreWarnings: true,
      });
    }

    handle.onEvent((evt) => {
      const progress = deps.ui.deletionProgress(workspacePath);
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
        dismiss();
      }
    });
    // Escape is handled declaratively: the Dismiss button carries role
    // "cancel" (only rendered when completed with errors), so Escape clicks it
    // through the normal action path above; mid-deletion Escape is a no-op.
  }

  /** Open the deletion dialog for a workspace from its current progress. */
  function showDialog(path: string, progress: DeletionProgress): void {
    const handle = deps.ui.dialog(buildConfig(progress), { kind: "panel" });
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
        // Render from the event payload directly; the presenter stores the
        // canonical copy off the same event (single source of truth).
        const progress = (event as WorkspaceDeletionProgressEvent).payload;
        const key = progress.workspacePath;

        // If this workspace's dialog is currently showing, update it
        if (activeDialog && activeDialog.path === key) {
          activeDialog.handle.update(buildConfig(progress));
        } else if (key === activeWorkspacePath && !activeDialog) {
          // Active workspace just started deletion — open dialog
          showDialog(key, progress);
        }

        // Auto-close on successful completion (the presenter clears its copy).
        if (progress.completed && !progress.hasErrors && activeDialog?.path === key) {
          closeActiveDialog();
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

        // Open dialog if the new workspace has deletion progress (read from the
        // presenter, the single source of truth).
        const progress = newPath ? deps.ui.deletionProgress(newPath) : undefined;
        if (newPath && progress && !activeDialog) {
          showDialog(newPath, progress);
        }
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const { workspacePath } = (event as WorkspaceDeletedEvent).payload;
        if (activeDialog?.path === workspacePath) {
          closeActiveDialog();
        }
      },
    },
  };

  /**
   * The "confirm" hook on workspace:delete (interactive dispatches only):
   * opens the confirmation dialog immediately, fills the dirty/unmerged
   * warnings in when the background status check lands, and parks the
   * dispatch until the user answers.
   */
  async function confirmRemove(ctx: HookContext): Promise<HookOutput<ConfirmHookResult>> {
    const input = ctx as DeletePipelineHookInput;
    let state: RemoveConfirmState = {
      workspaceName: input.workspaceName,
      checking: true,
      checkFailed: false,
      isDirty: false,
      unmergedCommits: 0,
      base: undefined,
    };

    const handle = deps.ui.dialog(buildRemoveConfirmConfig(state));
    let dialogOpen = true;

    // Background status check (refresh fetches remotes — slow). Never blocks
    // the dialog; a failure warns that the status is unknown rather than
    // silently rendering as "verified clean".
    void (async (): Promise<void> => {
      try {
        const [status, metadata] = await Promise.all([
          deps.dispatcher.dispatch({
            type: INTENT_GET_WORKSPACE_STATUS,
            payload: { workspacePath: input.workspacePath, refresh: true },
          } as GetWorkspaceStatusIntent),
          deps.dispatcher.dispatch({
            type: INTENT_GET_METADATA,
            payload: { workspacePath: input.workspacePath },
          } as GetMetadataIntent),
        ]);
        state = {
          ...state,
          checking: false,
          checkFailed: false,
          isDirty: status.isDirty,
          unmergedCommits: status.unmergedCommits,
          base: metadata["base"],
        };
      } catch (error) {
        deps.logger.warn("Remove-confirm status check failed", {
          workspace: input.workspacePath,
          error: getErrorMessage(error),
        });
        state = { ...state, checking: false, checkFailed: true };
      }
      if (dialogOpen) {
        handle.update(buildRemoveConfirmConfig(state));
      }
    })();

    try {
      const event = await handle.nextEvent();
      if (event.kind !== "dismiss" && event.actionId === "remove") {
        return { result: { keepBranch: event.data?.["keep-branch"] === "true" } };
      }
      // Cancel button or Escape.
      return { result: { canceled: true } };
    } finally {
      dialogOpen = false;
      handle.close();
    }
  }

  return {
    name: "deletion-dialog",
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        confirm: { handler: confirmRemove },
      },
    } satisfies HookDeclarations,
    events,
  };
}
