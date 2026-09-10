/**
 * The repository-hook contract: every moment a repository can attach a script
 * to, and the exact JSON it exchanges there.
 *
 * This file is the whole public surface of the feature. Nothing else knows the
 * on-disk names, and no internal identifier reaches disk: a hook binds to an
 * operation's hook point (or a domain event) here, and the name a repository
 * writes is declared beside it. Renaming `open-workspace`'s "setup" point, or
 * the `workspace:created` event, is therefore an ordinary refactor — this map
 * is the only thing that has to keep up.
 *
 * The two hook maps are exhaustive over their operation's hook points
 * (`Record<HookPointOf<typeof schemas>, …>`), so adding a hook point to either
 * operation fails to compile until someone says what a repository may do there
 * — or writes an explicit `null`, which is a decision rather than an oversight.
 *
 * Directory decides blocking: an entry under `hooks/` blocks the operation and
 * may return data; one under `events/` is fire-and-forget with its output
 * ignored. That is the whole rule, which is why it is a directory and not a
 * flag.
 */

import { z } from "zod/v4";
import type { OperationSchemas, HookPointOf } from "../../intents/lib/operation";
import { schemas as openWorkspaceSchemas } from "../../intents/open-workspace";
import { schemas as deleteWorkspaceSchemas } from "../../intents/delete-workspace";

// =============================================================================
// Directories
// =============================================================================

/** Repository-owned directory holding both hook trees. */
export const HOOKS_ROOT = ".codehydra";

/** Blocking entries live here. */
export const HOOKS_DIR = "hooks";

/** Fire-and-forget entries live here. */
export const EVENTS_DIR = "events";

// =============================================================================
// Input
// =============================================================================

/**
 * What every entry is handed, whichever moment it fires at.
 *
 * Deliberately small: a hook holds `workspacePath`, so anything else about the
 * workspace is one `git` call away, and a field shipped here is a field we owe
 * stability. `branch` and `base` are the exceptions — CodeHydra knows them
 * authoritatively and a script would otherwise dig `base` out of git config.
 *
 * Both are optional, and *absent* rather than null when unknown: a workspace on
 * a detached HEAD has no branch, and a worktree the user adopted by hand never
 * had a base. Substituting a plausible default would send a hook that branches
 * on it down the wrong path while looking like it worked.
 */
export const coreInputSchema = z.object({
  workspaceName: z.string(),
  workspacePath: z.string(),
  projectPath: z.string(),
  branch: z.string().optional(),
  base: z.string().optional(),
});

export type CoreInput = z.infer<typeof coreInputSchema>;

const afterWorktreeCreatedInputSchema = coreInputSchema;

const beforeWorktreeDeletedInputSchema = coreInputSchema.extend({
  /** The branch survives the deletion — so unmerged commits stay reachable. */
  keepBranch: z.boolean(),
});

const onWorkspaceCreatedInputSchema = coreInputSchema.extend({
  /**
   * The workspace was discovered at project open or woken from hibernation,
   * rather than genuinely created. The event fires either way; a script that
   * registers a workspace somewhere external will want to skip these, and one
   * that re-warms a cache will not.
   */
  reopened: z.boolean(),
});

// =============================================================================
// Output
// =============================================================================

/**
 * A tag as a repository declares it. The name is the object key — it is the
 * tag's identity (it becomes the `tags.<name>` metadata key), so keying by it
 * makes a duplicate unrepresentable rather than something to resolve.
 *
 * Every field is presentation and every field is optional; `{}` is a valid bare
 * tag. Mirrors `WorkspaceTag` minus its `name`.
 */
const tagSchema = z
  .object({
    color: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

/**
 * What `after-worktree-created` may contribute back.
 *
 * Three separate fields rather than one metadata map, so the reachable surface
 * is exactly these: a repository cannot write `base`, which the deletion gate's
 * unmerged-commit check reads and which a setup script must not be able to
 * rewrite from under it.
 *
 * Strict on purpose — `{"envs": …}` is a typo that would otherwise be dropped
 * in silence, and a setup hook whose environment quietly never arrived is a
 * miserable thing to debug.
 */
export const afterWorktreeCreatedOutputSchema = z
  .object({
    /** Merged into the workspace's environment: the agent and IDE terminals. */
    env: z.record(z.string(), z.string()).optional(),
    /** Sidebar display title. The branch name stays the identity. */
    title: z.string().optional(),
    /** Tags to attach, keyed by name. */
    tags: z.record(z.string(), tagSchema).optional(),
  })
  .strict();

export type AfterWorktreeCreatedOutput = z.infer<typeof afterWorktreeCreatedOutputSchema>;

/**
 * What `before-worktree-deleted` may return.
 *
 * `blocked` is a policy decision, and it is the only way to express one: a
 * non-zero exit means the script broke or could not tell, which also stops the
 * deletion but is reported as a hook failure. Same split the internal gates
 * use, where a returned `blocked` and a thrown handler mean different things.
 */
export const beforeWorktreeDeletedOutputSchema = z
  .object({
    blocked: z.boolean().optional(),
    /** Why. Shown as the deletion progress row's error text. */
    reason: z.string().optional(),
  })
  .strict();

export type BeforeWorktreeDeletedOutput = z.infer<typeof beforeWorktreeDeletedOutputSchema>;

// =============================================================================
// Entries
// =============================================================================

/** A blocking entry: the on-disk name plus the JSON it exchanges. */
export interface HookSpec {
  readonly name: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/** A fire-and-forget entry. No output — nothing is waiting for one. */
export interface EventSpec {
  readonly name: string;
  readonly input: z.ZodType;
}

export const AFTER_WORKTREE_CREATED: HookSpec = {
  name: "after-worktree-created",
  input: afterWorktreeCreatedInputSchema,
  output: afterWorktreeCreatedOutputSchema,
};

export const BEFORE_WORKTREE_DELETED: HookSpec = {
  name: "before-worktree-deleted",
  input: beforeWorktreeDeletedInputSchema,
  output: beforeWorktreeDeletedOutputSchema,
};

export const ON_WORKSPACE_CREATED: EventSpec = {
  name: "on-workspace-created",
  input: onWorkspaceCreatedInputSchema,
};

// =============================================================================
// Bindings
// =============================================================================

/** Exhaustive over one operation's hook points. `null` = not exposed. */
type HookPointMap<S extends OperationSchemas> = Readonly<Record<HookPointOf<S>, HookSpec | null>>;

/**
 * `setup` is the only exposed point, and it is the right one: the worktree
 * exists by then (so a script has something to set up), and its result folds
 * into `envVars`/`metadata`, which `finalize` and the `workspace:created`
 * snapshot carry. `create` runs before the worktree exists; `finalize` runs
 * after the environment has already been consumed.
 */
export const OPEN_WORKSPACE_HOOKS: HookPointMap<typeof openWorkspaceSchemas> = {
  create: null,
  setup: AFTER_WORKTREE_CREATED,
  finalize: null,
};

/**
 * `pre-delete` exists for this map. The gates that precede it are internal
 * policy (`preflight`) or the user's own answer (`confirm`), and the points
 * after it are teardown — by `delete` the worktree is being removed.
 */
export const DELETE_WORKSPACE_HOOKS: HookPointMap<typeof deleteWorkspaceSchemas> = {
  confirm: null,
  preflight: null,
  shutdown: null,
  "pre-delete": BEFORE_WORKTREE_DELETED,
  release: null,
  delete: null,
  detect: null,
  flush: null,
};

/** Every entry, for diagnostics and docs. */
export const ALL_ENTRIES: readonly (HookSpec | EventSpec)[] = [
  AFTER_WORKTREE_CREATED,
  BEFORE_WORKTREE_DELETED,
  ON_WORKSPACE_CREATED,
];
