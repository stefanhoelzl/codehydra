/**
 * WakeupModule — a script that decides when a hibernated workspace wakes.
 *
 * A workspace may carry one wakeup script (`ch ws wakeup set`, or
 * `ch ws hibernate --wakeup`), usually set by its own agent before it goes to
 * sleep: "wake me when CI on PR #12 finishes". While the workspace is
 * hibernated, the poll module (poll-module.ts) runs the script every tick; the
 * script prints what to do:
 *
 * - nothing, or `{"action":"keep"}` — stay asleep, ask again next tick;
 * - `{"action":"wake","message":"…"}` — wake the workspace in place (no switch)
 *   and send `message`, if any, to its agent.
 *
 * There is deliberately no "delete": a script that decides a workspace is done
 * wakes it with a message asking its agent to delete it, so the deletion goes
 * through someone who can see what would be lost.
 *
 * The script is stored in the protected `wakeup` metadata key (with its shell
 * and variables), so it survives a restart and goes with the worktree. A
 * `tags.wakeup` tag shows it in the sidebar. Any wake — the script's, the
 * user's, an automation's — clears both: a wakeup script is one-shot, so a
 * condition that is still true cannot wake a workspace the moment it is
 * hibernated again.
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
import { HIBERNATED_METADATA_KEY } from "../intents/hibernate-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import {
  INTENT_SEND_AGENT_MESSAGE,
  type SendAgentMessageIntent,
} from "../intents/send-agent-message";
import { workspaceRefSchema, type WorkspaceRef } from "../intents/contract";
import { encodeTag, tagKey } from "../shared/api/types";
import { getErrorMessage } from "../shared/error-utils";
import { Path } from "../utils/path/path";
import type { WakeupScript, WakeupStatus, Wakeups } from "../api/entries/deps";
import type { PollError } from "./poll-module";
import { SHELL_NAMES } from "./scripts/shells";

/** The metadata key a workspace's wakeup script is stored under (protected). */
export const WAKEUP_METADATA_KEY = "wakeup";
/** The sidebar tag that says a workspace has one. */
export const WAKEUP_TAG_KEY = tagKey("wakeup");
/** The poll jobs this module collects: one per hibernated workspace with a script. */
export const WAKEUP_OWNER = "wakeup";
/** The tag's label: an alarm clock. */
const WAKEUP_TAG_LABEL = "⏰";
/** Who a wakeup message is signed by. */
const MESSAGE_FROM = "CodeHydra · wakeup";

const storedScriptSchema = z.strictObject({
  script: z.string().min(1),
  shell: z.enum(SHELL_NAMES),
  env: z.record(z.string(), z.string()),
});

/** What a wakeup script prints. Empty output is a keep. */
const outputSchema = z.strictObject({
  action: z.enum(["wake", "keep"]),
  message: z.string().optional(),
});

/** A stored script, or undefined for an absent or unreadable value. */
export function decodeWakeup(value: string | undefined): WakeupScript | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = storedScriptSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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

export interface WakeupModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
  readonly pathProvider: Pick<PathProvider, "dataPath">;
  /** The wakeup scripts failing right now, as the poll module recorded them. */
  readonly pollErrors: (owner: string) => readonly PollError[];
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

export interface WakeupModule extends IntentModule {
  /** What the `workspace.wakeup.*` registry entries reach. */
  readonly api: Wakeups;
}

export function createWakeupModule(deps: WakeupModuleDeps): WakeupModule {
  const now = deps.now ?? Date.now;
  const logsRoot = deps.pathProvider.dataPath("logs/wakeup");

  /** How each workspace's script last ran since it was set. */
  const lastRuns = new Map<WorkspaceRef, NonNullable<WakeupStatus["lastRun"]>>();

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

  async function set(workspaceRef: WorkspaceRef, script: WakeupScript | null): Promise<void> {
    lastRuns.delete(workspaceRef);
    if (script === null) {
      await write(workspaceRef, WAKEUP_METADATA_KEY, null);
      await write(workspaceRef, WAKEUP_TAG_KEY, null);
      return;
    }
    const stored: z.infer<typeof storedScriptSchema> = {
      script: script.script,
      shell: script.shell,
      env: { ...script.env },
    };
    await write(workspaceRef, WAKEUP_METADATA_KEY, JSON.stringify(stored));
    await write(
      workspaceRef,
      WAKEUP_TAG_KEY,
      encodeTag({ label: WAKEUP_TAG_LABEL, description: `Wakeup script: ${script.script}` })
    );
  }

  async function show(workspaceRef: WorkspaceRef): Promise<WakeupStatus | null> {
    const metadata = await deps.dispatcher.dispatch<GetMetadataIntent>({
      type: INTENT_GET_METADATA,
      payload: { workspaceRef },
    });
    const script = decodeWakeup(metadata?.[WAKEUP_METADATA_KEY]);
    if (script === undefined) return null;
    const lastRun = lastRuns.get(workspaceRef);
    const error = deps.pollErrors(WAKEUP_OWNER).find((entry) => entry.id === workspaceRef);
    return {
      ...script,
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
  // Polling
  // ---------------------------------------------------------------------------

  /** One job per hibernated workspace that has a script. */
  async function collect(): Promise<readonly PollJob[]> {
    const projects = await deps.dispatcher.dispatch<ListProjectsIntent>({
      type: INTENT_LIST_PROJECTS,
      payload: {},
    });
    const jobs: PollJob[] = [];
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces) {
        if (workspace.metadata[HIBERNATED_METADATA_KEY] !== "true") continue;
        const wakeup = decodeWakeup(workspace.metadata[WAKEUP_METADATA_KEY]);
        if (wakeup === undefined) continue;
        jobs.push({
          owner: WAKEUP_OWNER,
          id: workspace.ref,
          source: "wakeup",
          entry: workspace.name,
          shell: wakeup.shell,
          script: wakeup.script,
          cwd: workspace.path,
          input: { workspace: workspace.ref, project: project.ref, workspacePath: workspace.path },
          logDir: new Path(logsRoot, projectDirName(project.path), workspace.name).toString(),
          ...(Object.keys(wakeup.env).length > 0 && { env: { ...wakeup.env } }),
          workspaceDir: workspace.path,
          failure: { title: "Wakeup script failed", pointer: "see ch ws wakeup show" },
        });
      }
    }
    return jobs;
  }

  /** Act on what a wakeup script printed. Returns what went wrong, for the poll module. */
  async function handle(job: PollJob, run: PollRun): Promise<readonly string[]> {
    const workspaceRef = workspaceRefSchema.parse(job.id);
    if (run.failure !== undefined) {
      record(workspaceRef, "failed", run.failure);
      return [];
    }
    let output: z.infer<typeof outputSchema>;
    try {
      output = parseOutput(run.stdout);
    } catch (error) {
      record(workspaceRef, "failed", getErrorMessage(error));
      return [getErrorMessage(error)];
    }
    if (output.action === "keep") {
      record(workspaceRef, "keep");
      return [];
    }

    const log = deps.logger.scoped({ workspace: workspaceRef });
    try {
      // It may have woken or started closing while its script ran.
      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspaceRef },
      });
      if (resolved.closing !== null || resolved.metadata[HIBERNATED_METADATA_KEY] !== "true") {
        log.debug("Wakeup script said wake, but the workspace is no longer asleep");
        return [];
      }
      log.info("Wakeup script woke the workspace");
      if (output.message === undefined) {
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
          payload: { workspaceRef, text: output.message, from: MESSAGE_FROM, wake: true },
        });
        if (!sent.sent) log.warn("Wakeup message not delivered", { reason: sent.reason ?? "" });
      }
    } catch (error) {
      log.warn("Wakeup script could not wake the workspace", { error: getErrorMessage(error) });
      return [`could not wake the workspace: ${getErrorMessage(error)}`];
    }
    return [];
  }

  const hooks = defineHooks({
    [POLL_TICK_OPERATION_ID]: {
      collect: { handler: async () => ({ result: { jobs: await collect() } }) },
      result: {
        handler: async (ctx) => {
          if (ctx.job.owner !== WAKEUP_OWNER) return;
          return { result: { errors: await handle(ctx.job, ctx.run) } };
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
        if (metadata === undefined) return;
        if (!(WAKEUP_METADATA_KEY in metadata) && !(WAKEUP_TAG_KEY in metadata)) return;
        await set(workspaceRef, null);
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (event): Promise<void> => {
        lastRuns.delete(event.payload.workspaceRef);
      },
    },
  });

  return { name: "wakeup", hooks, events, api: { set, show } };
}
