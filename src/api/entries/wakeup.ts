/**
 * Wakeup entries: set, clear and show what decides when a hibernated workspace
 * wakes (wakeup-module.ts) — a script, other workspaces it waits on, or both.
 * `workspace.hibernate` takes the same fields, so a workspace can go to sleep
 * with its condition in one call.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { WorkspaceRef } from "../../intents/contract";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../../intents/list-projects";
import { HIBERNATED_METADATA_KEY } from "../../intents/hibernate-workspace";
import type { EntryDeps, Wakeup, WakeupScript, WatchState, WorkspaceWatch } from "./deps";
import { DEFAULT_WAKEUP_TIMEOUT_SECONDS } from "./deps";
import {
  createReferenceResolver,
  createTargetResolver,
  targetFields,
  workspaceDisplayName,
} from "./target";

/** An environment variable's name: what every shell accepts. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** CodeHydra's own variables, which a script may not override. */
const RESERVED_ENV_PREFIX = "_CH_";

const DURATION = /^(\d+)([smhdw])$/;
/** Each unit a duration may be given in, largest first, with its seconds. */
const UNITS = [
  ["w", 7 * 24 * 60 * 60],
  ["d", 24 * 60 * 60],
  ["h", 60 * 60],
  ["m", 60],
  ["s", 1],
] as const;

/** A duration as `10d`, `12h`, `30m`, `90s` or `2w`, in seconds; null for `never`. */
export function parseDuration(text: string): number | null {
  if (text === "never") return null;
  const match = DURATION.exec(text.trim());
  const unit = UNITS.find(([name]) => name === match?.[2]);
  const seconds = match && unit ? Number(match[1]) * unit[1] : 0;
  if (seconds <= 0) {
    throw new ApiError(
      "usage",
      `timeout "${text}" is not a duration like 10d, 12h, 30m, 90s, 2w, or never`
    );
  }
  return seconds;
}

/** Seconds as the largest whole unit up to days: `14d`, `36h`, `90m`, `45s`. */
export function formatDuration(seconds: number): string {
  const [name, size] = UNITS.find(([unit, size]) => unit !== "w" && seconds % size === 0) ?? [
    "s",
    1,
  ];
  return `${seconds / size}${name}`;
}

export const WAKEUP_INSTRUCTIONS =
  "A hibernated workspace wakes on whichever comes first: its wakeup script says so, or the " +
  "workspaces it waits on (untilDeleted, untilHibernated, untilWoken; any one of them, every " +
  "one with all) reach their state, checked the moment any workspace is deleted, hibernated " +
  "or woken. At the latest it wakes once its timeout has passed since it hibernated " +
  `(default ${formatDuration(DEFAULT_WAKEUP_TIMEOUT_SECONDS)}; never with timeout "never"), ` +
  "so a condition that never comes cannot leave it asleep for good. While the workspace is " +
  "hibernated the script runs every poll tick (poll.interval, default 60 s) for its first " +
  "day asleep, then every 15 minutes, then every 2 hours after a week; it is killed after " +
  "poll.timeout (default 30 s), and runs in the worktree with `ch` on PATH. Bash runs it " +
  "with -eo pipefail: a failing command stops it, so catch the failures you expect. " +
  'It prints nothing or {"action":"keep"} to stay asleep, or ' +
  '{"action":"wake","message":"…"} to wake the workspace in place and send the message to its ' +
  "agent. A script that fails (a non-zero exit, output that is not that JSON) wakes the " +
  "workspace too, and its agent is told what went wrong. There is no delete: to have a " +
  "workspace deleted, wake it with a message asking its agent to. Any wake clears the wakeup.";

/** The fields that describe a wakeup script, beside `script` itself. */
export const wakeupOptionFields = {
  shell: z
    .enum(["bash", "powershell", "cmd"])
    .optional()
    .describe("Shell the script is written for (default bash; on Windows, Git Bash)"),
  env: z
    .array(z.string())
    .optional()
    .describe("Variables of the script's own, each KEY=VALUE (repeat the flag for several)"),
};

const WATCHED_REFERENCE =
  "its name (looked up in your own project first), <project>::<name> or full ref; " +
  "repeat for several";

/** The fields that name the workspaces a hibernated workspace waits on. */
export const wakeupWatchFields = {
  untilDeleted: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Wake once this workspace is deleted (or closed with its project): ${WATCHED_REFERENCE}`
    ),
  untilHibernated: z
    .array(z.string().min(1))
    .optional()
    .describe(`Wake once this awake workspace hibernates: ${WATCHED_REFERENCE}`),
  untilWoken: z
    .array(z.string().min(1))
    .optional()
    .describe(`Wake once this hibernated workspace wakes: ${WATCHED_REFERENCE}`),
  all: z
    .boolean()
    .optional()
    .describe(
      "With several watched workspaces, wake only once every one has reached its state " +
        "(default: the first one does)"
    ),
  timeout: z
    .string()
    .optional()
    .describe(
      "Wake at the latest this long after hibernating, as 10d, 12h, 30m, 90s or 2w; never " +
        `for no limit (default ${formatDuration(DEFAULT_WAKEUP_TIMEOUT_SECONDS)}). ` +
        "On its own, it wakes the workspace after that long."
    ),
};

/** Turn the input fields into a script, refusing a malformed variable. */
export function toWakeupScript(input: {
  readonly script: string;
  readonly shell?: "bash" | "powershell" | "cmd" | undefined;
  readonly env?: readonly string[] | undefined;
}): WakeupScript {
  if (input.script.trim() === "") throw new ApiError("usage", "The wakeup script is empty.");
  const env: Record<string, string> = {};
  for (const pair of input.env ?? []) {
    const equals = pair.indexOf("=");
    const name = equals === -1 ? pair : pair.slice(0, equals);
    if (equals === -1 || !ENV_NAME.test(name)) {
      throw new ApiError("usage", `env "${pair}" is not KEY=VALUE`);
    }
    if (name.startsWith(RESERVED_ENV_PREFIX)) {
      throw new ApiError(
        "usage",
        `env ${name}: variables starting ${RESERVED_ENV_PREFIX} are CodeHydra's`
      );
    }
    env[name] = pair.slice(equals + 1);
  }
  return { script: input.script, shell: input.shell ?? "bash", env };
}

/** The wakeup fields of an entry's input, after parsing. */
export interface WakeupInput {
  readonly script?: string | undefined;
  readonly shell?: "bash" | "powershell" | "cmd" | undefined;
  readonly env?: readonly string[] | undefined;
  readonly untilDeleted?: readonly string[] | undefined;
  readonly untilHibernated?: readonly string[] | undefined;
  readonly untilWoken?: readonly string[] | undefined;
  readonly all?: boolean | undefined;
  readonly timeout?: string | undefined;
}

/** Whether the input gives any wakeup field: then it replaces the wakeup as a whole. */
export function hasWakeupFields(input: WakeupInput): boolean {
  return Object.values({
    script: input.script,
    shell: input.shell,
    env: input.env,
    untilDeleted: input.untilDeleted,
    untilHibernated: input.untilHibernated,
    untilWoken: input.untilWoken,
    all: input.all,
    timeout: input.timeout,
  }).some((value) => value !== undefined);
}

/**
 * Build a wakeup from an entry's input: resolve the watched workspaces the way
 * `--workspace` does and refuse what could never mean what was asked — a
 * workspace waiting on itself, or on a state its watched workspace is already
 * in. (A workspace that is not open cannot be waited on to be deleted: its name
 * does not resolve.)
 */
export function createWakeupBuilder(
  dispatcher: Dispatcher
): (ctx: OperationContext, self: WorkspaceRef, input: WakeupInput) => Promise<Wakeup> {
  const resolveReference = createReferenceResolver(dispatcher);

  return async (ctx, self, input) => {
    if (input.script === undefined && (input.shell !== undefined || input.env !== undefined)) {
      throw new ApiError("usage", "shell and env describe a wakeup script: pass the script too");
    }
    const requested: readonly [WatchState, readonly string[] | undefined][] = [
      ["deleted", input.untilDeleted],
      ["hibernated", input.untilHibernated],
      ["woken", input.untilWoken],
    ];
    const watch: WorkspaceWatch[] = [];
    for (const [until, references] of requested) {
      for (const reference of references ?? []) {
        const workspace = await resolveReference(ctx, reference);
        if (workspace === self) {
          throw new ApiError("usage", "A workspace cannot wait for itself.");
        }
        if (!watch.some((w) => w.workspace === workspace && w.until === until)) {
          watch.push({ workspace, until });
        }
      }
    }
    if (input.all === true && watch.length === 0) {
      throw new ApiError("usage", "all says how to wait for several workspaces: name some.");
    }
    const timeoutSeconds = input.timeout === undefined ? undefined : parseDuration(input.timeout);
    if (input.script === undefined && watch.length === 0 && typeof timeoutSeconds !== "number") {
      throw new ApiError(
        "usage",
        "Nothing to wake on: give a script, workspaces to wait for (untilDeleted, " +
          "untilHibernated, untilWoken) or a timeout."
      );
    }

    if (watch.some((w) => w.until !== "deleted")) {
      const projects = await dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {},
      });
      const hibernated = new Map<WorkspaceRef, boolean>();
      for (const project of projects ?? []) {
        for (const workspace of project.workspaces) {
          hibernated.set(workspace.ref, workspace.metadata[HIBERNATED_METADATA_KEY] === "true");
        }
      }
      for (const w of watch) {
        const name = workspaceDisplayName(w.workspace);
        if (w.until === "hibernated" && hibernated.get(w.workspace) === true) {
          throw new ApiError("conflict", `${name} is hibernated already.`);
        }
        if (w.until === "woken" && hibernated.get(w.workspace) === false) {
          throw new ApiError("conflict", `${name} is awake already.`);
        }
      }
    }

    return {
      ...(input.script !== undefined &&
        toWakeupScript({ script: input.script, shell: input.shell, env: input.env })),
      ...(watch.length > 0 && { watch }),
      ...(input.all === true && { all: true }),
      ...(timeoutSeconds !== undefined && { timeoutSeconds }),
    };
  };
}

export function wakeupEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const targetOf = createTargetResolver(deps.dispatcher);
  const toWakeup = createWakeupBuilder(deps.dispatcher);

  const set = defineEntry({
    name: "workspace.wakeup.set",
    kind: "command",
    description:
      "Set what wakes a hibernated workspace: a script, workspaces to wait for, a timeout.",
    instructions:
      "Replaces the workspace's wakeup, if it has one, as a whole. Set it while awake to arm " +
      "the next hibernation, or hibernate with the same fields in one call. " +
      WAKEUP_INSTRUCTIONS,
    input: z.object({
      ...targetFields,
      script: z.string().optional().describe("The script body, in its shell"),
      ...wakeupOptionFields,
      ...wakeupWatchFields,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const workspaceRef = await targetOf(ctx, input);
      await deps.wakeups.set(workspaceRef, await toWakeup(ctx, workspaceRef, input));
      return deps.wakeups.show(workspaceRef);
    },
  });

  const clear = defineEntry({
    name: "workspace.wakeup.clear",
    kind: "command",
    description: "Remove a workspace's wakeup.",
    instructions: "The workspace stays as it is, hibernated or not; nothing wakes it by itself.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      await deps.wakeups.set(await targetOf(ctx, input), null);
      return null;
    },
  });

  const show = defineEntry({
    name: "workspace.wakeup.show",
    kind: "command",
    description: "Show a workspace's wakeup and how its script last ran.",
    instructions:
      "Null when it has none. watch lists the workspaces it waits on, each with the state it " +
      "is waited for; timeoutSeconds is the timeout in effect (null for none) and deadline, " +
      "while it is hibernated, when it wakes at the latest; lastRun is the script's last run since it was set; error is its current " +
      "failure, with the failed run's log file.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => deps.wakeups.show(await targetOf(ctx, input)),
  });

  return [set, clear, show];
}
