/**
 * Wakeup script entries: set, clear and show the script that decides when a
 * hibernated workspace wakes (wakeup-module.ts). `workspace.hibernate` takes
 * the same fields, so a workspace can go to sleep with its condition in one call.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps, WakeupScript } from "./deps";
import { createTargetResolver, targetFields } from "./target";

/** An environment variable's name: what every shell accepts. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** CodeHydra's own variables, which a script may not override. */
const RESERVED_ENV_PREFIX = "_CH_";

export const WAKEUP_INSTRUCTIONS =
  "The script runs every poll tick (poll.interval, default 60 s; killed after poll.timeout, " +
  "default 30 s) while the workspace is hibernated, in its worktree, with `ch` on PATH. It " +
  'prints nothing or {"action":"keep"} to stay asleep, or {"action":"wake","message":"…"} to ' +
  "wake the workspace in place and send the message to its agent. A non-zero exit is a " +
  "failure, never a wake. There is no delete: to have a workspace deleted, wake it with a " +
  "message asking its agent to. Any wake clears the script.";

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

export function wakeupEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const targetOf = createTargetResolver(deps.dispatcher);

  const set = defineEntry({
    name: "workspace.wakeup.set",
    kind: "command",
    description: "Set the script that decides when a hibernated workspace wakes.",
    instructions:
      "Replaces the workspace's wakeup script, if it has one. Set it while awake to arm the " +
      "next hibernation, or hibernate with the same fields in one call. " +
      WAKEUP_INSTRUCTIONS,
    input: z.object({
      ...targetFields,
      script: z.string().describe("The script body, in its shell"),
      ...wakeupOptionFields,
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const workspaceRef = await targetOf(ctx, input);
      await deps.wakeups.set(workspaceRef, toWakeupScript(input));
      return deps.wakeups.show(workspaceRef);
    },
  });

  const clear = defineEntry({
    name: "workspace.wakeup.clear",
    kind: "command",
    description: "Remove a workspace's wakeup script.",
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
    description: "Show a workspace's wakeup script and how it last ran.",
    instructions:
      "Null when it has none. lastRun is the last run since the script was set; error is its " +
      "current failure, with the failed run's log file.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => deps.wakeups.show(await targetOf(ctx, input)),
  });

  return [set, clear, show];
}
