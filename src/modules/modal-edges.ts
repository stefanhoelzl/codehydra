/**
 * Counts one source's open questions per workspace and reports the 0↔1 edges as
 * `vscode:modal-changed`.
 *
 * Shared by the two sources: the API server module (modals in a workspace's
 * editor) and the presenter (sidebar cards attached to a workspace that wait for
 * an answer). Each counts on its own; the agent module combines them.
 */

import type { Dispatcher } from "../intents/lib/dispatcher";
import type { WorkspaceRef } from "../intents/contract";
import type { Logger } from "../boundaries/platform/logging-types";
import {
  INTENT_VSCODE_MODAL_CHANGED,
  type ModalSource,
  type VscodeModalChangedIntent,
} from "../intents/vscode-modal-changed";
import { getErrorMessage } from "../shared/errors/service-errors";

export interface ModalEdges {
  /** One more question is open in the workspace. */
  opened(workspaceRef: WorkspaceRef): void;
  /** One fewer. */
  closed(workspaceRef: WorkspaceRef): void;
}

export function createModalEdges(
  dispatcher: Pick<Dispatcher, "dispatch">,
  logger: Logger,
  source: ModalSource
): ModalEdges {
  const open = new Map<WorkspaceRef, number>();

  /**
   * The last edge report per workspace. Each report waits for the previous one,
   * so an open and its close cannot overtake each other in the dispatcher and
   * leave the workspace parked.
   */
  const reports = new Map<WorkspaceRef, Promise<void>>();

  function report(workspaceRef: WorkspaceRef, isOpen: boolean): void {
    const previous = reports.get(workspaceRef) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await dispatcher.dispatch<VscodeModalChangedIntent>({
          type: INTENT_VSCODE_MODAL_CHANGED,
          payload: { workspaceRef, source, open: isOpen },
        });
      } catch (error) {
        logger.scoped({ workspace: workspaceRef }).warn("Failed to report modal change", {
          source,
          open: isOpen,
          error: getErrorMessage(error),
        });
      }
    });
    reports.set(workspaceRef, next);
    void next.finally(() => {
      if (reports.get(workspaceRef) === next) reports.delete(workspaceRef);
    });
  }

  return {
    opened(workspaceRef) {
      const count = (open.get(workspaceRef) ?? 0) + 1;
      open.set(workspaceRef, count);
      if (count === 1) report(workspaceRef, true);
    },
    closed(workspaceRef) {
      const count = (open.get(workspaceRef) ?? 0) - 1;
      if (count > 0) {
        open.set(workspaceRef, count);
        return;
      }
      open.delete(workspaceRef);
      report(workspaceRef, false);
    },
  };
}
