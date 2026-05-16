/**
 * SubmitBugReportOperation - Trivial operation that emits bug-report:submitted.
 *
 * No hooks needed — just emits a domain event for subscribers
 * (PostHog module) to react to.
 */

import type { Intent, DomainEvent } from "./lib/types";
import type { Operation, OperationContext } from "./lib/operation";

// =============================================================================
// Intent Types
// =============================================================================

export interface SubmitBugReportPayload {
  readonly description: string;
  readonly logs: string;
  /** Chromium/Electron native log (--enable-logging=file output). */
  readonly electronLogs: string;
}

export interface SubmitBugReportIntent extends Intent<void> {
  readonly type: "bug-report:submit";
  readonly payload: SubmitBugReportPayload;
}

export const INTENT_SUBMIT_BUG_REPORT = "bug-report:submit" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface BugReportSubmittedPayload {
  readonly description: string;
  readonly logs: string;
  /** Chromium/Electron native log (--enable-logging=file output). */
  readonly electronLogs: string;
}

export interface BugReportSubmittedEvent extends DomainEvent {
  readonly type: "bug-report:submitted";
  readonly payload: BugReportSubmittedPayload;
}

export const EVENT_BUG_REPORT_SUBMITTED = "bug-report:submitted" as const;

// =============================================================================
// Operation
// =============================================================================

export const SUBMIT_BUG_REPORT_OPERATION_ID = "submit-bug-report";

export class SubmitBugReportOperation implements Operation<SubmitBugReportIntent, void> {
  readonly id = SUBMIT_BUG_REPORT_OPERATION_ID;

  async execute(ctx: OperationContext<SubmitBugReportIntent>): Promise<void> {
    const event: BugReportSubmittedEvent = {
      type: EVENT_BUG_REPORT_SUBMITTED,
      payload: {
        description: ctx.intent.payload.description,
        logs: ctx.intent.payload.logs,
        electronLogs: ctx.intent.payload.electronLogs,
      },
    };
    ctx.emit(event);
  }
}
