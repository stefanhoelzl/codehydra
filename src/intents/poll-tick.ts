/**
 * PollTickOperation - One poll cycle: collect the scripts modules want run, run
 * them, and hand each result back to its owner.
 *
 * The poll module dispatches it on its timer (`poll.interval`), so a module
 * that needs a script run periodically never runs one itself: it describes the
 * job, and gets the outcome.
 *
 * Hook points, in order:
 * 1. "collect" - every module returns the jobs it wants run this tick
 *    (automations: one per automation; wakeup: one per hibernated workspace
 *    with a wakeup script).
 * 2. Per job, all jobs concurrently, each as soon as the one before it is done:
 *    a. "run"    - the poll module runs the script and judges its exit
 *    b. "result" - the job's owner reads what it printed and acts on it; it
 *                  returns the errors a person must hear about (a bad item,
 *                  output that does not parse). Every handler sees every job
 *                  and answers only for its own `owner`. Failed runs arrive too,
 *                  for the owner's own bookkeeping.
 *    c. "report" - the poll module writes the run log and records the failure
 *                  (or clears it), so failures are announced in one place.
 *
 * The operation resolves once every job is reported, so the poll module's
 * "gap between the end of one tick and the start of the next" includes what
 * owners did with their results.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema } from "./contract";

export const INTENT_POLL_TICK = "poll:tick" as const;
export const POLL_TICK_OPERATION_ID = "poll-tick";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const pollTickPayloadSchema = z.object({}).readonly();

/** One script a module wants run this tick. Paths are normalized `Path` strings. */
export const pollJobSchema = z
  .object({
    /** The module that collected it; only that module's "result" handler answers. */
    owner: z.string(),
    /** The job's identity within its owner, stable across ticks (failures are kept by it). */
    id: z.string(),
    /** Whose script it is, for people: a plugin's id (`local:github`), or `wakeup`. */
    source: z.string(),
    /** What it is within its source: `automations.reviews`, a workspace's name. */
    entry: z.string(),
    shell: z.enum(["bash", "powershell", "cmd"]),
    script: z.string(),
    cwd: z.string(),
    /** Serialized to stdin. */
    input: z.unknown(),
    /** Where its run logs go. */
    logDir: z.string(),
    /** Variables of the script's own. */
    env: z.record(z.string(), z.string()).optional(),
    /** Overrides `poll.timeout`. */
    timeoutMs: z.number().int().positive().optional(),
    /** `CH_PLUGIN_DIR`. */
    pluginDir: z.string().optional(),
    /** `CH_WORKSPACE_DIR`. */
    workspaceDir: z.string().optional(),
    /** How a failure is announced: the card's title, and where to read more. */
    failure: z.object({ title: z.string(), pointer: z.string() }).readonly(),
  })
  .readonly();

/** How a job's script ran. */
export const pollRunSchema = z
  .object({
    /** `not-started`: its shell is missing, or the process could not start. */
    status: z.enum(["exited", "canceled", "timed-out", "not-started"]),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    /** Why the run failed, in the words a notification uses; absent when it exited 0. */
    failure: z.string().optional(),
    /** It exited 75 (`EX_TEMPFAIL`): try again next tick, quietly at first. */
    temporary: z.boolean(),
  })
  .readonly();

const pollTickHookInputSchema = hookCtxSchema(pollTickPayloadSchema, {});
const pollJobHookInputSchema = hookCtxSchema(pollTickPayloadSchema, { job: pollJobSchema });
const pollResultHookInputSchema = hookCtxSchema(pollTickPayloadSchema, {
  job: pollJobSchema,
  run: pollRunSchema,
});
const pollReportHookInputSchema = hookCtxSchema(pollTickPayloadSchema, {
  job: pollJobSchema,
  run: pollRunSchema,
  errors: z.array(z.string()).readonly(),
});

export const collectJobsResultSchema = z
  .object({ jobs: z.array(pollJobSchema).readonly().optional() })
  .readonly();
export const runJobResultSchema = z.object({ run: pollRunSchema.optional() }).readonly();
export const jobResultResultSchema = z
  .object({ errors: z.array(z.string()).readonly().optional() })
  .readonly();

export const pollTickResultSchema = z.object({ jobs: z.number() }).readonly();

export const schemas = {
  type: INTENT_POLL_TICK,
  payload: pollTickPayloadSchema,
  result: pollTickResultSchema,
  hooks: {
    collect: { input: pollTickHookInputSchema, result: collectJobsResultSchema },
    run: { input: pollJobHookInputSchema, result: runJobResultSchema },
    result: { input: pollResultHookInputSchema, result: jobResultResultSchema },
    report: { input: pollReportHookInputSchema, result: z.object({}).readonly() },
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type PollTickIntent = IntentOf<typeof schemas>;
export type PollTickResult = z.infer<typeof pollTickResultSchema>;
export type PollJob = z.infer<typeof pollJobSchema>;
export type PollRun = z.infer<typeof pollRunSchema>;

// =============================================================================
// Operation
// =============================================================================

export class PollTickOperation implements Operation<typeof schemas> {
  readonly id = POLL_TICK_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<PollTickIntent, typeof schemas>): Promise<PollTickResult> {
    const { intent } = ctx;
    // A module whose collect throws contributes nothing this tick; the others
    // still run (the dispatcher logs the error).
    const collected = await ctx.hooks.collect("collect", { intent });
    const jobs = collected.results.flatMap((result) => result.jobs ?? []);

    await Promise.all(
      jobs.map(async (job) => {
        const ran = await ctx.hooks.collect("run", { intent, job });
        const run: PollRun = ran.results.find((result) => result.run)?.run ?? {
          status: "not-started",
          exitCode: null,
          stdout: "",
          stderr: "",
          failure: ran.errors[0]?.message ?? "nothing ran it",
          temporary: false,
        };

        const handled = await ctx.hooks.collect("result", { intent, job, run });
        const errors = [
          ...handled.results.flatMap((result) => result.errors ?? []),
          ...handled.errors.map((error) => error.message),
        ];

        await ctx.hooks.collect("report", { intent, job, run, errors });
      })
    );

    return { jobs: jobs.length };
  }
}
