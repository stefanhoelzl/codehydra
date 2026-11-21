/**
 * WakeupModule — what decides when a hibernated workspace wakes.
 *
 * A workspace may carry one wakeup (`ch ws wakeup set`, or `ch ws hibernate`
 * with the same fields), usually set by its own agent before it goes to sleep.
 * It wakes on whichever of its conditions comes first:
 *
 * - **its script** ("wake me when CI on PR #12 finishes"): while the workspace
 *   is hibernated, the poll module (poll-module.ts) runs it every tick, and it
 *   prints what to do — nothing or `{"action":"keep"}` to stay asleep,
 *   `{"action":"wake","message":"…"}` to wake in place (no switch) and send
 *   `message`, if any, to its agent. The longer it sleeps, the less often it
 *   runs: every tick for its first day, every 15 minutes after a day, every 2
 *   hours after a week (counted from `hibernated-at`; a script just set runs
 *   on the next tick). A script that fails (any exit but 0; exit
 *   75, a temporary failure, once it has gone on for the poll module's grace
 *   period) or prints something else wakes the workspace too, with a message
 *   telling its agent what went wrong: a broken script must not leave a
 *   workspace asleep for good.
 * - **other workspaces** it waits on, each for a state — deleted (no longer
 *   open: deleted, or closed with its project), hibernated or woken; any one of
 *   them, or every one with `all`. A watched workspace that is gone counts as
 *   having reached any state: it never will now. Checked the moment any
 *   workspace is deleted, hibernated or woken, and on every poll tick (what
 *   catches a closed project — its teardown is no deletion, and quitting
 *   tears projects down too — and the state at start). With `all`, a workspace
 *   that reached its state stays counted (recorded as `reachedAt` in the
 *   stored watch), even if it leaves that state again before the others get
 *   there.
 *
 * - **its timeout**: whatever it waits for, it wakes once this long has passed
 *   since it hibernated (`timeoutSeconds`; 14 days when none was given, never
 *   with null), so a condition that never comes — a buggy script, a workspace
 *   nobody deletes — cannot leave it asleep for good. A wakeup may also be a
 *   timeout alone: "wake me in 2 hours". Checked on every poll tick. A
 *   workspace hibernated without any wakeup has none.
 *
 * There is deliberately no "delete": a script that decides a workspace is done
 * wakes it with a message asking its agent to delete it, so the deletion goes
 * through someone who can see what would be lost.
 *
 * The wakeup is stored in the protected `wakeup` metadata key, so it survives a
 * restart and goes with the worktree. The sidebar lists such a workspace as
 * "automated" (the presenter reads the same key). Older versions also set a
 * `tags.wakeup` tag; it is no longer written, only cleared. Any wake — the
 * wakeup's own, the user's, an automation's — clears the wakeup (and any such
 * tag): it is one-shot, so a condition that is still true cannot wake a
 * workspace the moment it is hibernated again.
 *
 * Failures are the poll module's to announce; how each run went is kept here,
 * in memory, for `ch ws wakeup show`.
 */

import { z } from "zod/v4";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { IntentModule } from "../intents/lib/module";
import type { Logger } from "../boundaries/platform/logging-types";
import type { PathProvider } from "../boundaries/platform/path-provider";
import { projectDirName } from "../boundaries/platform/paths";
import { defineEvents, defineHooks } from "../intents/declarations";
import { POLL_TICK_OPERATION_ID, type PollJob, type PollRun } from "../intents/poll-tick";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../intents/list-projects";
import { INTENT_GET_METADATA, type GetMetadataIntent } from "../intents/get-metadata";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../intents/set-metadata";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../intents/resolve-workspace";
import {
  EVENT_WORKSPACE_WOKEN,
  INTENT_WAKE_WORKSPACE,
  type WakeWorkspaceIntent,
} from "../intents/wake-workspace";
import {
  EVENT_WORKSPACE_HIBERNATED,
  HIBERNATED_AT_METADATA_KEY,
  HIBERNATED_METADATA_KEY,
  readHibernatedAt,
} from "../intents/hibernate-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import {
  INTENT_SEND_AGENT_MESSAGE,
  type SendAgentMessageIntent,
} from "../intents/send-agent-message";
import { workspaceRefSchema, type WorkspaceRef } from "../intents/contract";
import { tagKey } from "../shared/api/types";
import { getErrorMessage } from "../shared/error-utils";
import { Path } from "../utils/path/path";
import { parseWorkspaceRef } from "../utils/ref";
import { formatDuration } from "../api/entries/wakeup";
import {
  DEFAULT_WAKEUP_TIMEOUT_SECONDS,
  WATCH_STATES,
  type Wakeup,
  type WakeupStatus,
  type Wakeups,
  type WatchState,
} from "../api/entries/deps";
import { TEMPORARY_FAILURE_GRACE_MS, type PollError } from "./poll-module";
import { SHELL_NAMES } from "./scripts/shells";

/** The metadata key a workspace's wakeup is stored under (protected). */
export const WAKEUP_METADATA_KEY = "wakeup";
/** The legacy sidebar tag older versions set beside a script; only cleared now. */
export const WAKEUP_TAG_KEY = tagKey("wakeup");
/** The poll jobs this module collects: one per hibernated workspace with a script. */
export const WAKEUP_OWNER = "wakeup";
/** Who a wakeup message is signed by. */
const MESSAGE_FROM = "CodeHydra · wakeup";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/**
 * How often a script runs, by how long its workspace has slept: the first
 * matching step's gap (none: every tick).
 */
const CADENCE: readonly { readonly asleepFor: number; readonly every: number }[] = [
  { asleepFor: 7 * DAY_MS, every: 120 * MINUTE_MS },
  { asleepFor: DAY_MS, every: 15 * MINUTE_MS },
];

/** The gap between a script's runs, for a workspace asleep since `hibernatedAt` (ms; 0: every tick). */
export function runGap(hibernatedAt: string | undefined, now: number): number {
  if (hibernatedAt === undefined) return 0;
  const asleepFor = now - Date.parse(hibernatedAt);
  return CADENCE.find((step) => asleepFor >= step.asleepFor)?.every ?? 0;
}

/** How much of a failed script's output its agent is shown. */
const OUTPUT_TAIL_CHARS = 2000;

const storedWatchSchema = z.strictObject({
  workspace: workspaceRefSchema,
  until: z.enum(WATCH_STATES),
  /** When it reached its state, for `all`: it stays counted. */
  reachedAt: z.string().optional(),
});

const storedWakeupSchema = z
  .strictObject({
    script: z.string().min(1).optional(),
    shell: z.enum(SHELL_NAMES).optional(),
    env: z.record(z.string(), z.string()).optional(),
    watch: z.array(storedWatchSchema).min(1).optional(),
    all: z.boolean().optional(),
    /** Seconds; null for none; absent for the default. */
    timeoutSeconds: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (wakeup) =>
      wakeup.script !== undefined ||
      wakeup.watch !== undefined ||
      typeof wakeup.timeoutSeconds === "number"
  );

type StoredWakeup = z.infer<typeof storedWakeupSchema>;
type StoredWatch = z.infer<typeof storedWatchSchema>;

/** What a wakeup script prints. Empty output is a keep. */
const outputSchema = z.strictObject({
  action: z.enum(["wake", "keep"]),
  message: z.string().optional(),
});

/** A stored wakeup, or undefined for an absent or unreadable value. */
export function decodeWakeup(value: string | undefined): StoredWakeup | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = storedWakeupSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace's name, for messages: the name its ref carries. */
function nameOf(workspaceRef: WorkspaceRef): string {
  return parseWorkspaceRef(workspaceRef)?.name ?? workspaceRef;
}

const STATE_WORDS: Readonly<Record<WatchState, string>> = {
  deleted: "is deleted",
  hibernated: "hibernates",
  woken: "wakes",
};

const PAST_WORDS: Readonly<Record<WatchState, string>> = {
  deleted: "was deleted",
  hibernated: "hibernated",
  woken: "woke",
};

/**
 * A one-line description of a wakeup, for the sidebar: the script alone when
 * that is all it has (as it always was), else each condition.
 */
export function describeWakeup(wakeup: StoredWakeup): string {
  const parts: string[] = [];
  if (wakeup.watch !== undefined) {
    const watches = wakeup.watch.map((w) => `${nameOf(w.workspace)} ${STATE_WORDS[w.until]}`);
    parts.push(`when ${watches.join(wakeup.all === true ? " and " : " or ")}`);
  }
  if (wakeup.script !== undefined) {
    parts.push(parts.length === 0 ? wakeup.script : `script: ${wakeup.script}`);
  }
  // The default timeout goes without saying; one given is part of what it waits for.
  if (typeof wakeup.timeoutSeconds === "number") {
    const after = formatDuration(wakeup.timeoutSeconds);
    parts.push(parts.length === 0 ? `after ${after}` : `at the latest after ${after}`);
  }
  return parts.join(" · or ");
}

/** The timeout a wakeup has in effect, in seconds; null for none. */
export function timeoutOf(wakeup: StoredWakeup): number | null {
  return wakeup.timeoutSeconds === undefined
    ? DEFAULT_WAKEUP_TIMEOUT_SECONDS
    : wakeup.timeoutSeconds;
}

/** When a hibernated workspace with this wakeup wakes at the latest (ms), or null. */
function deadlineOf(wakeup: StoredWakeup, hibernatedAt: string | undefined): number | null {
  const timeout = timeoutOf(wakeup);
  if (timeout === null || hibernatedAt === undefined) return null;
  return Date.parse(hibernatedAt) + timeout * 1000;
}

/** What a wakeup script printed: its verdict, or a message saying what is wrong with it. */
function parseOutput(stdout: string): z.infer<typeof outputSchema> {
  if (stdout.trim() === "") return { action: "keep" };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("printed something that is not JSON");
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('printed JSON that is not {"action": "wake" | "keep", "message"?: string}');
  }
  return parsed.data;
}

/** The end of a script's output, for a message. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}

export interface WakeupModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly pathProvider: Pick<PathProvider, "dataPath">;
  /** The wakeup scripts failing right now, as the poll module recorded them. */
  readonly pollErrors: (owner: string) => readonly PollError[];
  /** Tells the poll module a script is not due this tick (its failure stands). */
  readonly markWaiting: (job: Pick<PollJob, "owner" | "id">) => void;
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

export interface WakeupModule extends IntentModule {
  /** What the `workspace.wakeup.*` registry entries reach. */
  readonly api: Wakeups;
}

/** What is known about the workspaces right now, beside the list: what an event just said. */
interface Overrides {
  readonly gone?: WorkspaceRef;
  readonly hibernated?: WorkspaceRef;
  readonly woken?: WorkspaceRef;
}

export function createWakeupModule(deps: WakeupModuleDeps): WakeupModule {
  const now = deps.now ?? Date.now;
  const logsRoot = deps.pathProvider.dataPath("logs/wakeup");

  /** How each workspace's script last ran since it was set. */
  const lastRuns = new Map<WorkspaceRef, NonNullable<WakeupStatus["lastRun"]>>();
  /** When each workspace's script's current run of temporary failures began. */
  const temporarySince = new Map<WorkspaceRef, number>();
  /** Workspaces being woken by this module, so two checks never wake one twice. */
  const waking = new Set<WorkspaceRef>();
  /** Set once the app shuts down: projects closing then are no reason to wake. */
  let stopped = false;

  function record(
    workspaceRef: WorkspaceRef,
    outcome: NonNullable<WakeupStatus["lastRun"]>["outcome"],
    message?: string
  ): void {
    lastRuns.set(workspaceRef, {
      at: new Date(now()).toISOString(),
      outcome,
      ...(message !== undefined && { message }),
    });
  }

  async function write(workspaceRef: WorkspaceRef, key: string, value: string | null) {
    await deps.dispatcher.dispatch<SetMetadataIntent>({
      type: INTENT_SET_METADATA,
      payload: { workspaceRef, key, value },
    });
  }

  async function store(workspaceRef: WorkspaceRef, wakeup: StoredWakeup): Promise<void> {
    await write(workspaceRef, WAKEUP_METADATA_KEY, JSON.stringify(wakeup));
  }

  async function set(workspaceRef: WorkspaceRef, wakeup: Wakeup | null): Promise<void> {
    lastRuns.delete(workspaceRef);
    temporarySince.delete(workspaceRef);
    if (wakeup === null) {
      await write(workspaceRef, WAKEUP_METADATA_KEY, null);
      await write(workspaceRef, WAKEUP_TAG_KEY, null);
      return;
    }
    const stored: StoredWakeup = {
      ...(wakeup.script !== undefined && {
        script: wakeup.script,
        shell: wakeup.shell ?? "bash",
        env: { ...wakeup.env },
      }),
      ...(wakeup.watch !== undefined &&
        wakeup.watch.length > 0 && {
          watch: wakeup.watch.map((w) => ({ workspace: w.workspace, until: w.until })),
        }),
      ...(wakeup.all === true && { all: true }),
      ...(wakeup.timeoutSeconds !== undefined && { timeoutSeconds: wakeup.timeoutSeconds }),
    };
    await store(workspaceRef, stored);
  }

  async function show(workspaceRef: WorkspaceRef): Promise<WakeupStatus | null> {
    const metadata = await deps.dispatcher.dispatch<GetMetadataIntent>({
      type: INTENT_GET_METADATA,
      payload: { workspaceRef },
    });
    const wakeup = decodeWakeup(metadata?.[WAKEUP_METADATA_KEY]);
    if (wakeup === undefined) return null;
    const lastRun = lastRuns.get(workspaceRef);
    const error = deps.pollErrors(WAKEUP_OWNER).find((entry) => entry.id === workspaceRef);
    const deadline =
      metadata?.[HIBERNATED_METADATA_KEY] === "true"
        ? deadlineOf(wakeup, readHibernatedAt(metadata[HIBERNATED_AT_METADATA_KEY]))
        : null;
    return {
      ...(wakeup.script !== undefined && {
        script: wakeup.script,
        shell: wakeup.shell ?? "bash",
        env: wakeup.env ?? {},
      }),
      ...(wakeup.watch !== undefined && {
        watch: wakeup.watch.map((w) => ({
          workspace: w.workspace,
          until: w.until,
          ...(w.reachedAt !== undefined && { reachedAt: w.reachedAt }),
        })),
      }),
      ...(wakeup.all === true && { all: true }),
      timeoutSeconds: timeoutOf(wakeup),
      ...(deadline !== null && { deadline: new Date(deadline).toISOString() }),
      ...(lastRun !== undefined && { lastRun }),
      ...(error !== undefined && {
        error: {
          message: error.message,
          ...(error.logPath !== undefined && { logPath: error.logPath }),
        },
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Waking
  // ---------------------------------------------------------------------------

  /**
   * Wake a workspace in place, sending `message` to its agent. Returns what went
   * wrong, if anything.
   */
  async function wake(
    workspaceRef: WorkspaceRef,
    why: string,
    message: string | undefined
  ): Promise<string | undefined> {
    if (waking.has(workspaceRef)) return undefined;
    waking.add(workspaceRef);
    const log = deps.logger.scoped({ workspace: workspaceRef });
    try {
      // It may have woken or started closing since it was looked at.
      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspaceRef },
      });
      if (resolved.closing !== null || resolved.metadata[HIBERNATED_METADATA_KEY] !== "true") {
        log.debug("Wakeup condition met, but the workspace is no longer asleep", { why });
        return undefined;
      }
      log.info("Wakeup woke the workspace", { why });
      if (message === undefined) {
        await deps.dispatcher.dispatch<WakeWorkspaceIntent>({
          type: INTENT_WAKE_WORKSPACE,
          payload: { workspaceRef, stealFocus: false },
        });
      } else {
        // The send wakes it (in the background, no switch) and waits for its
        // agent to come up: a send right after a wake of our own would find
        // the editor not connected yet.
        const sent = await deps.dispatcher.dispatch<SendAgentMessageIntent>({
          type: INTENT_SEND_AGENT_MESSAGE,
          payload: { workspaceRef, text: message, from: MESSAGE_FROM, wake: true },
        });
        if (!sent.sent) log.warn("Wakeup message not delivered", { reason: sent.reason ?? "" });
      }
      return undefined;
    } catch (error) {
      log.warn("Wakeup could not wake the workspace", { error: getErrorMessage(error) });
      return `could not wake the workspace: ${getErrorMessage(error)}`;
    } finally {
      waking.delete(workspaceRef);
    }
  }

  /** Wake a workspace whose script failed, telling its agent what went wrong. */
  async function wakeOnFailure(
    job: PollJob,
    run: PollRun,
    failure: string
  ): Promise<string | undefined> {
    const workspaceRef = workspaceRefSchema.parse(job.id);
    const lines = [
      `Your wakeup script failed (${failure}), so CodeHydra woke this workspace instead of ` +
        "leaving it asleep. Its wakeup is cleared.",
    ];
    if (run.stderr.trim() !== "") lines.push("", "stderr:", tail(run.stderr));
    if (run.stdout.trim() !== "") lines.push("", "stdout:", tail(run.stdout));
    lines.push(
      "",
      `Run logs: ${new Path(job.logDir).toNative()}`,
      "",
      "Tell the user what went wrong. If this workspace should still wait, fix the script " +
        "and hibernate again."
    );
    return wake(workspaceRef, `script failed: ${failure}`, lines.join("\n"));
  }

  // ---------------------------------------------------------------------------
  // Watched workspaces
  // ---------------------------------------------------------------------------

  /**
   * Whether a watched workspace is in the state it is waited for, and how to
   * say so; undefined when it is not. Gone counts as every state.
   */
  function reached(
    watch: StoredWatch,
    hibernated: ReadonlyMap<WorkspaceRef, boolean>
  ): string | undefined {
    const name = nameOf(watch.workspace);
    const state = hibernated.get(watch.workspace);
    if (state === undefined) {
      return watch.until === "deleted"
        ? `${name} was deleted (or its project closed)`
        : `${name} is gone (deleted, or its project closed) — it will not ` +
            `${watch.until === "hibernated" ? "hibernate" : "wake"} now`;
    }
    if (watch.until === "hibernated" && state) return `${name} hibernated`;
    if (watch.until === "woken" && !state) return `${name} woke`;
    return undefined;
  }

  /** Wake every hibernated workspace whose watched workspaces have reached their states. */
  async function checkWatches(overrides: Overrides = {}): Promise<void> {
    if (stopped) return;
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    const hibernated = new Map<WorkspaceRef, boolean>();
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces) {
        hibernated.set(workspace.ref, workspace.metadata[HIBERNATED_METADATA_KEY] === "true");
      }
    }
    // An event may run ahead of the list: what it said wins.
    if (overrides.gone !== undefined) hibernated.delete(overrides.gone);
    if (overrides.hibernated !== undefined) hibernated.set(overrides.hibernated, true);
    if (overrides.woken !== undefined) hibernated.set(overrides.woken, false);

    const wakes: Promise<unknown>[] = [];
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces) {
        if (hibernated.get(workspace.ref) !== true) continue;
        const wakeup = decodeWakeup(workspace.metadata[WAKEUP_METADATA_KEY]);
        const watched = wakeup?.watch;
        if (wakeup === undefined || watched === undefined) continue;
        const outcomes = watched.map((watch) => ({
          watch,
          reason: reached(watch, hibernated),
        }));
        if (wakeup.all === true) {
          // Record each newly reached one, so leaving its state again later
          // does not un-count it.
          const at = new Date(now()).toISOString();
          const watch = outcomes.map(({ watch: w, reason }) =>
            reason !== undefined && w.reachedAt === undefined ? { ...w, reachedAt: at } : w
          );
          if (watch.some((w, i) => w !== watched[i])) {
            await store(workspace.ref, { ...wakeup, watch });
          }
          if (!watch.every((w) => w.reachedAt !== undefined)) continue;
          const reasons = outcomes.map(
            ({ watch: w, reason }) => reason ?? `${nameOf(w.workspace)} ${PAST_WORDS[w.until]}`
          );
          wakes.push(
            wake(
              workspace.ref,
              "every watched workspace reached its state",
              "Woken because every workspace this one waited for reached its state: " +
                `${reasons.join("; ")}.`
            )
          );
        } else {
          const first = outcomes.find((o) => o.reason !== undefined);
          if (first?.reason === undefined) continue;
          wakes.push(wake(workspace.ref, first.reason, `Woken because ${first.reason}.`));
        }
      }
    }
    await Promise.all(wakes);
  }

  /** Check the watches without failing the caller: an event handler or a tick. */
  async function checkWatchesSafely(overrides?: Overrides): Promise<void> {
    try {
      await checkWatches(overrides);
    } catch (error) {
      deps.logger.warn("Checking watched workspaces failed", { error: getErrorMessage(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /** One job per hibernated workspace that has a script. */
  async function collect(): Promise<readonly PollJob[]> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    const jobs: PollJob[] = [];
    const timedOut: Promise<unknown>[] = [];
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces) {
        if (workspace.metadata[HIBERNATED_METADATA_KEY] !== "true") continue;
        const wakeup = decodeWakeup(workspace.metadata[WAKEUP_METADATA_KEY]);
        if (wakeup === undefined) continue;
        const hibernatedAt = readHibernatedAt(workspace.metadata[HIBERNATED_AT_METADATA_KEY]);
        const deadline = deadlineOf(wakeup, hibernatedAt);
        if (deadline !== null && now() >= deadline) {
          timedOut.push(wakeOnTimeout(workspace.ref, wakeup, hibernatedAt));
          continue;
        }
        if (wakeup.script === undefined) continue;
        const lastRun = lastRuns.get(workspace.ref);
        const gap = runGap(hibernatedAt, now());
        if (lastRun !== undefined && now() - Date.parse(lastRun.at) < gap) {
          deps.markWaiting({ owner: WAKEUP_OWNER, id: workspace.ref });
          continue;
        }
        const env = wakeup.env ?? {};
        jobs.push({
          owner: WAKEUP_OWNER,
          id: workspace.ref,
          source: "wakeup",
          entry: workspace.name,
          shell: wakeup.shell ?? "bash",
          script: wakeup.script,
          cwd: workspace.path,
          input: { workspace: workspace.ref, project: project.ref, workspacePath: workspace.path },
          logDir: new Path(logsRoot, projectDirName(project.path), workspace.name).toString(),
          ...(Object.keys(env).length > 0 && { env: { ...env } }),
          workspaceDir: workspace.path,
          failure: { title: "Wakeup script failed", pointer: "see ch ws wakeup show" },
        });
      }
    }
    await Promise.all(timedOut);
    return jobs;
  }

  /** Wake a workspace whose timeout has passed, telling its agent what it waited for. */
  async function wakeOnTimeout(
    workspaceRef: WorkspaceRef,
    wakeup: StoredWakeup,
    hibernatedAt: string | undefined
  ): Promise<void> {
    const timeout = timeoutOf(wakeup) ?? 0;
    const given = wakeup.timeoutSeconds === undefined ? " (the default)" : "";
    const since = hibernatedAt === undefined ? "" : ` since it hibernated at ${hibernatedAt}`;
    const conditions: string[] = [];
    if (wakeup.watch !== undefined) {
      const watches = wakeup.watch.map((w) => `${nameOf(w.workspace)} ${STATE_WORDS[w.until]}`);
      conditions.push(watches.join(wakeup.all === true ? " and " : " or "));
    }
    if (wakeup.script !== undefined) conditions.push("its wakeup script says so");
    const waited =
      conditions.length === 0
        ? ""
        : `, before what it waited for came (until ${conditions.join(", or ")})`;
    await wake(
      workspaceRef,
      "its timeout passed",
      `Woken because its timeout of ${formatDuration(timeout)}${given} passed${since}${waited}.`
    );
  }

  /** Act on what a wakeup script printed. Returns what went wrong, for the poll module. */
  async function handle(job: PollJob, run: PollRun): Promise<readonly string[]> {
    const workspaceRef = workspaceRefSchema.parse(job.id);
    if (run.failure !== undefined) {
      record(workspaceRef, "failed", run.failure);
      if (run.temporary) {
        const since = temporarySince.get(workspaceRef) ?? now();
        temporarySince.set(workspaceRef, since);
        if (now() - since < TEMPORARY_FAILURE_GRACE_MS) return [];
      }
      temporarySince.delete(workspaceRef);
      const error = await wakeOnFailure(job, run, run.failure);
      return error === undefined ? [] : [error];
    }
    temporarySince.delete(workspaceRef);
    let output: z.infer<typeof outputSchema>;
    try {
      output = parseOutput(run.stdout);
    } catch (error) {
      const reason = getErrorMessage(error);
      record(workspaceRef, "failed", reason);
      const wakeError = await wakeOnFailure(job, run, reason);
      return wakeError === undefined ? [reason] : [reason, wakeError];
    }
    if (output.action === "keep") {
      record(workspaceRef, "keep");
      return [];
    }
    const error = await wake(workspaceRef, "its script said so", output.message);
    return error === undefined ? [] : [error];
  }

  const hooks = defineHooks({
    [POLL_TICK_OPERATION_ID]: {
      collect: {
        handler: async () => {
          await checkWatchesSafely();
          return { result: { jobs: await collect() } };
        },
      },
      result: {
        handler: async (ctx) => {
          if (ctx.job.owner !== WAKEUP_OWNER) return;
          return { result: { errors: await handle(ctx.job, ctx.run) } };
        },
      },
    },
    [APP_SHUTDOWN_OPERATION_ID]: {
      stop: {
        handler: async () => {
          stopped = true;
        },
      },
    },
  });

  const events = defineEvents({
    // One-shot: whoever woke it, the condition has served its purpose.
    [EVENT_WORKSPACE_WOKEN]: {
      handler: async (event): Promise<void> => {
        const { workspaceRef } = event.payload;
        const metadata = await deps.dispatcher.dispatch<GetMetadataIntent>({
          type: INTENT_GET_METADATA,
          payload: { workspaceRef },
        });
        if (metadata !== undefined) {
          if (WAKEUP_METADATA_KEY in metadata || WAKEUP_TAG_KEY in metadata) {
            await set(workspaceRef, null);
          }
        }
        await checkWatchesSafely({ woken: workspaceRef });
      },
    },
    [EVENT_WORKSPACE_HIBERNATED]: {
      handler: async (event): Promise<void> => {
        await checkWatchesSafely({ hibernated: event.payload.workspaceRef });
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event): Promise<void> => {
        lastRuns.delete(event.payload.workspaceRef);
        temporarySince.delete(event.payload.workspaceRef);
        // Only a real deletion: the teardown of a closing project (which quitting
        // may do too) is left to the next tick, which the shutdown stops.
        if (event.payload.worktreeRemoved) {
          await checkWatchesSafely({ gone: event.payload.workspaceRef });
        }
      },
    },
  });

  return { name: "wakeup", hooks, events, api: { set, show } };
}
