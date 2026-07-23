/**
 * SubmitBugReportOperation - Trivial operation that emits bug-report:submitted.
 *
 * No hooks needed — just emits a domain event for subscribers
 * (PostHog module) to react to.
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/event schemas are
 * declared once and hung on the operation's `schemas` field; the `Intent` and event-payload
 * types are **derived** from that bundle via `IntentOf`/`z.infer`. The result is void.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";

export const INTENT_SUBMIT_BUG_REPORT = "bug-report:submit" as const;

export const EVENT_BUG_REPORT_SUBMITTED = "bug-report:submitted" as const;

export const SUBMIT_BUG_REPORT_OPERATION_ID = "submit-bug-report";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const submitBugReportPayloadSchema = z
  .object({
    description: z.string(),
  })
  .readonly();

export const bugReportSubmittedPayloadSchema = z
  .object({
    description: z.string(),
  })
  .readonly();

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_SUBMIT_BUG_REPORT,
  payload: submitBugReportPayloadSchema,
  events: {
    [EVENT_BUG_REPORT_SUBMITTED]: bugReportSubmittedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SubmitBugReportPayload = z.infer<typeof submitBugReportPayloadSchema>;
export type SubmitBugReportIntent = IntentOf<typeof schemas>;
export type BugReportSubmittedPayload = z.infer<typeof bugReportSubmittedPayloadSchema>;

export interface BugReportSubmittedEvent extends DomainEvent {
  readonly type: "bug-report:submitted";
  readonly payload: BugReportSubmittedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class SubmitBugReportOperation implements Operation<typeof schemas> {
  readonly id = SUBMIT_BUG_REPORT_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<SubmitBugReportIntent, typeof schemas>): Promise<void> {
    const event: BugReportSubmittedEvent = {
      type: EVENT_BUG_REPORT_SUBMITTED,
      payload: {
        description: ctx.intent.payload.description,
      },
    };
    // Awaited so dispatch() resolves only after the subscriber (error-report
    // module) has read logs, captured the exception, and flushed. The MCP
    // report_bug tool relies on this to confirm delivery; the dialog path
    // fire-and-forgets its dispatch, so it is unaffected.
    await ctx.emit(event);
  }
}
