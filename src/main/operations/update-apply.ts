/**
 * UpdateApplyOperation - Orchestrates update choice, download, and install.
 *
 * Dispatched from AppStartOperation after check-deps detects an update.
 * Uses an interceptor (in auto-updater module) to reject when config="never"
 * or no update was detected.
 *
 * Runs four hook points:
 * 1. "show-choice" - (if needsChoice) Emit show-choice UI event
 * 2. "await-choice" - (if needsChoice) Await user response via IPC
 * 3. "download" - Download update, report progress, handle cancel
 * 4. "install" - Dispatch app:shutdown with installUpdate flag
 *
 * Version is NOT in the payload — it lives in auto-updater module state.
 * Hook handlers supply the version when calling report().
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { UpdateProgressAction, UpdateChoice } from "../../shared/ipc";
import type { ConfigService } from "../../services/config/config-service";

// =============================================================================
// Intent Types
// =============================================================================

export interface UpdateApplyPayload {
  readonly needsChoice: boolean;
}

export interface UpdateApplyIntent extends Intent<void> {
  readonly type: "app:update";
  readonly payload: UpdateApplyPayload;
}

export const INTENT_UPDATE_APPLY = "app:update" as const;

// =============================================================================
// Domain Events
// =============================================================================

export interface UpdateProgressPayload {
  readonly action: UpdateProgressAction;
  readonly version: string;
  readonly percent: number;
  readonly finished?: boolean;
}

export interface UpdateProgressEvent extends DomainEvent {
  readonly type: typeof EVENT_UPDATE_PROGRESS;
  readonly payload: UpdateProgressPayload;
}

export const EVENT_UPDATE_PROGRESS = "app:update:progress" as const;

// =============================================================================
// Hook Context & Result Types
// =============================================================================

export const UPDATE_APPLY_OPERATION_ID = "update-apply";

/**
 * Progress reporter callback for update UI.
 * Wraps ctx.emit() to emit UPDATE_PROGRESS domain events.
 */
export type UpdateProgressReporter = (
  action: UpdateProgressAction,
  percent: number,
  version: string,
  finished?: boolean
) => void;

/**
 * Input context for update-apply hooks — carries the report callback.
 */
export interface UpdateApplyHookContext extends HookContext {
  readonly report: UpdateProgressReporter;
}

/**
 * Result from the "choice" hook — returns the user's choice.
 */
export interface UpdateChoiceResult {
  readonly choice?: UpdateChoice;
}

/**
 * Result from the "download" hook — indicates if download was cancelled.
 */
export interface UpdateDownloadResult {
  readonly cancelled?: boolean;
}

// =============================================================================
// Operation
// =============================================================================

export class UpdateApplyOperation implements Operation<UpdateApplyIntent, void> {
  readonly id = UPDATE_APPLY_OPERATION_ID;

  constructor(private readonly configService: ConfigService) {}

  async execute(ctx: OperationContext<UpdateApplyIntent>): Promise<void> {
    const { needsChoice } = ctx.intent.payload;

    const report: UpdateProgressReporter = (action, percent, version, finished?) => {
      ctx.emit({
        type: EVENT_UPDATE_PROGRESS,
        payload: {
          action,
          version,
          percent,
          ...(finished !== undefined && { finished }),
        },
      });
    };

    const hookCtx: UpdateApplyHookContext = {
      intent: ctx.intent,
      report,
    };

    // 1. Choice (conditional)
    if (needsChoice) {
      // show-choice: emit UI event (auto-updater module)
      await ctx.hooks.collect("show-choice", hookCtx);
      // await-choice: block until user responds via IPC (view module)
      const { results } = await ctx.hooks.collect<UpdateChoiceResult>("await-choice", hookCtx);
      const choice = results.find((r) => r.choice)?.choice;

      switch (choice) {
        case "always":
          await this.configService.set("auto-update", "always");
          break;
        case "never":
          await this.configService.set("auto-update", "never");
          report("show-choice", 0, "", true);
          return;
        case "skip":
          report("show-choice", 0, "", true);
          return;
      }
    }

    // 2. Download (cancel handled by download hook — emits finished:true before returning)
    const { results: dlResults } = await ctx.hooks.collect<UpdateDownloadResult>(
      "download",
      hookCtx
    );
    const cancelled = dlResults.some((r) => r.cancelled);
    if (cancelled) return; // download hook already emitted finished:true

    // 3. Install (dispatches app:shutdown with installUpdate flag)
    await ctx.hooks.collect("install", hookCtx);
  }
}
