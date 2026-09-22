/**
 * Lock registry entries — `ch lock take|release|ls`, plus the hidden `lock.hold`
 * that `ch lock run` is built on.
 *
 * The table itself lives in the lock module and is reached through
 * `deps.locks`; these entries only turn a caller and its arguments into a lock
 * key and shape the answer. The holder is always the caller's workspace — a lock
 * cannot be taken or released on another workspace's behalf, which is what
 * makes "open THAT workspace's terminal and release it there" the one way to
 * break someone else's lock.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps, LockKey, LockSnapshot } from "./deps";
import type { ProjectPath, WorkspacePath } from "../../intents/contract";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import type { ResolveWorkspaceIntent } from "../../intents/resolve-workspace";
import { Path } from "../../utils/path/path";
import { formatAge } from "../../utils/age";

const lockName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "lock names are letters, digits, hyphens and underscores");

const scopeSchema = z.enum(["global", "project"]);
type Scope = z.infer<typeof scopeSchema>;

const SCOPE_DESCRIPTION =
  "Who contends for this name: every workspace of every open project, or only this project's";

/** The caller's workspace. Entries that use it declare `requiresWorkspace`. */
function callerOf(ctx: OperationContext): WorkspacePath {
  if (ctx.workspacePath === null) {
    throw new ApiError("no-workspace", "No workspace to act on.");
  }
  return ctx.workspacePath;
}

function holderName(workspacePath: WorkspacePath): string {
  return new Path(workspacePath).basename;
}

export function lockEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher, locks } = deps;

  /** The project the caller's workspace belongs to. */
  const projectOf = async (ctx: OperationContext): Promise<ProjectPath> => {
    const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: callerOf(ctx) },
    });
    return resolved.projectPath;
  };

  const keyOf = async (ctx: OperationContext, name: string, scope: Scope): Promise<LockKey> => ({
    name,
    project: scope === "project" ? await projectOf(ctx) : null,
  });

  /** Whether a lock falls in the namespace a `--scope` filter names. */
  const inScope = (lock: LockSnapshot, scope: Scope | undefined, project: ProjectPath | null) =>
    scope === undefined || (scope === "global" ? lock.project === null : lock.project === project);

  const takeInput = z.object({
    name: lockName.describe("Lock name: letters, digits, hyphens and underscores"),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe("Why you need it. Shown to whoever is waiting, and in the sidebar tag's tooltip"),
    scope: scopeSchema.default("global").describe(SCOPE_DESCRIPTION),
    noWait: z
      .boolean()
      .default(false)
      .describe("Fail immediately if it is held, instead of queueing"),
  });

  const take = defineEntry({
    name: "lock.take",
    kind: "command",
    description: "Take a lock, waiting until it is free",
    instructions:
      "A lock is held by the WORKSPACE, not by this process: the command exits as soon as " +
      "the lock is yours and the hold continues without it. Run it as a background call — " +
      "waiting is unbounded, and a foreground shell dies at the harness's 10-minute clamp.\n\n" +
      "Waiters are served in arrival order and granted atomically, so there is no gap to lose " +
      "a race in: when this returns, the lock is yours. It prints nothing while it waits — " +
      "run `ch lock ls` to see who holds it and who is queued.\n\n" +
      "Taking a lock this workspace already holds succeeds immediately and changes nothing.\n\n" +
      "The lock releases when you run `ch lock release`, when the workspace hibernates, and " +
      "when it is deleted. Closing the agent terminal does not release it. Nothing else takes " +
      "it from you — there is no steal. To break someone else's lock, open THAT workspace's " +
      "terminal and release it there.",
    input: takeInput,
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await locks.take(callerOf(ctx), await keyOf(ctx, input.name, input.scope), {
        reason: input.reason,
        wait: !input.noWait,
        signal: ctx.signal,
        releaseOnDisconnect: false,
      });
      return {
        name: input.name,
        scope: input.scope,
        acquired: result.acquired,
        waitedSeconds: Math.round(result.waitedMs / 1000),
      };
    },
  });

  const hold = defineEntry({
    name: "lock.hold",
    kind: "command",
    description: "Take a lock for as long as this connection lives",
    instructions:
      "What `ch lock run` is built on: a take that is also released when the caller's " +
      "connection closes, so the hold is the process. From a shell, use `ch lock run`.",
    input: takeInput,
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await locks.take(callerOf(ctx), await keyOf(ctx, input.name, input.scope), {
        reason: input.reason,
        wait: !input.noWait,
        signal: ctx.signal,
        releaseOnDisconnect: true,
      });
      return {
        name: input.name,
        scope: input.scope,
        acquired: result.acquired,
        waitedSeconds: Math.round(result.waitedMs / 1000),
      };
    },
  });

  const release = defineEntry({
    name: "lock.release",
    kind: "command",
    description: "Release a lock this workspace holds",
    instructions:
      "With no name, releases every lock this workspace holds — the cleanup to run when you " +
      "are done with a resource, without enumerating what you took.\n\n" +
      "Releasing hands the lock to the next waiter immediately. Releasing a lock this " +
      "workspace does not hold is an error, not a silent success: it almost always means the " +
      "hold ended earlier than you thought — the workspace hibernated, or a `ch lock run` " +
      "that held it was killed — and somebody else has been using the resource since.",
    input: z.object({
      name: lockName
        .optional()
        .describe("Lock to release. Omit to release all this workspace holds"),
      scope: scopeSchema
        .optional()
        .describe(
          "Namespace the name lives in (default: global). Without a name, limits which locks are released"
        ),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const workspace = callerOf(ctx);

      if (input.name !== undefined) {
        locks.release(workspace, await keyOf(ctx, input.name, input.scope ?? "global"));
        return { released: [input.name] };
      }

      const project = input.scope === "project" ? await projectOf(ctx) : null;
      const mine = locks
        .list()
        .filter((lock) => new Path(lock.holder).equals(workspace))
        .filter((lock) => inScope(lock, input.scope, project));
      for (const lock of mine) {
        locks.release(workspace, { name: lock.name, project: lock.project });
      }
      return { released: mine.map((lock) => lock.name) };
    },
  });

  const list = defineEntry({
    name: "lock.list",
    kind: "command",
    description: "List locks, their holders and who is waiting",
    instructions:
      "Shows every lock currently held. A lock exists only while someone holds it; there is " +
      "nothing to declare and nothing to clean up. `project` names the project a " +
      "project-scoped lock belongs to, and is empty for a global one.",
    input: z.object({
      scope: scopeSchema.optional().describe("Show only this namespace (default: both)"),
    }),
    // Listing is a read of the whole instance; only `--scope project` needs to
    // know which project the caller is in.
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const project = input.scope === "project" ? await projectOf(ctx) : null;
      return locks
        .list()
        .filter((lock) => inScope(lock, input.scope, project))
        .sort(
          (a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.name.localeCompare(b.name)
        )
        .map((lock) => ({
          // Strings throughout, so the human table has no `null` cells.
          name: lock.name,
          project: lock.project === null ? "" : new Path(lock.project).basename,
          holder: holderName(lock.holder),
          held: formatAge(lock.acquiredAt),
          reason: lock.reason ?? "",
          waiting: lock.waiting.map(holderName).join(", "),
        }));
    },
  });

  return [take, hold, release, list];
}
