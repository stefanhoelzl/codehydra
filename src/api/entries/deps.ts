/**
 * Dependencies the registry entries dispatch through.
 *
 * Entries hold no state of their own. Anything that needs module-level state —
 * notably waiting on a deletion's terminal progress event, which requires a
 * domain-event subscription — is injected here by the module that owns it.
 */

import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { AppBoundary } from "../../boundaries/shell/app";
import type { DeletionProgress } from "../../shared/api/types";
import type { WorkspacePath } from "../../intents/contract";
import type { OperationRegistry } from "../registry";

export interface EntryDeps {
  readonly dispatcher: Dispatcher;
  /**
   * Open a path with the OS. `reveal` shows it in the file manager (selecting a
   * file's containing folder), otherwise it opens with the default application.
   * No intent covers this — the plugin server calls the app boundary directly.
   */
  readonly appLayer: Pick<AppBoundary, "openPath">;
  /**
   * Wait for the terminal deletion-progress event for a workspace.
   *
   * Deletion reports its real outcome through an event rather than the dispatch
   * result: `ctx.emit` is not awaited inside the delete operation, so reading
   * state after `await handle` races the emit. Returns a promise for the
   * terminal progress plus a cleanup to drop the waiter.
   */
  readonly awaitDeletion: (workspacePath: WorkspacePath) => {
    readonly outcome: Promise<DeletionProgress>;
    readonly release: () => void;
  };
  /**
   * The registry itself, for the entry that describes it.
   *
   * A getter rather than the value because the registry is built FROM these
   * entries: the describe entry has to be able to see the finished registry it
   * is a member of. Set once during construction.
   */
  readonly registry: () => OperationRegistry;
}
