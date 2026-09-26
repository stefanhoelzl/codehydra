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
 * The name decides blocking: an `on-` entry reports something that already
 * happened, so it is fire-and-forget and its output is ignored; every other
 * entry runs at a moment CodeHydra is waiting on, blocks it, and may return
 * data. One directory, and the tense of the name tells you which you are
 * writing — `before-workspace-opened` is a job, `on-workspace-opened` is news.
 */

import { z } from "zod/v4";
import type { OperationSchemas, HookPointOf } from "../../intents/lib/operation";
import { schemas as openWorkspaceSchemas } from "../../intents/open-workspace";
import { schemas as deleteWorkspaceSchemas } from "../../intents/delete-workspace";
import { isValidMetadataKey, TAGS_METADATA_KEY_PREFIX } from "../../shared/api/types";

// =============================================================================
// Directories
// =============================================================================

/** Repository-owned directory. */
export const HOOKS_ROOT = ".codehydra";

/** Every entry, blocking or not, lives here. */
export const HOOKS_DIR = "hooks";

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
 * on it down the wrong path while looking like it worked. The same rule holds
 * for every entry and every path that fires it — creation, app start, project
 * open, wake, deletion — so a hook never sees a field change shape by origin.
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

/**
 * Every entry that fires on an open says which kind of open it is. A genuinely
 * new workspace is `false`; app start, project open (adopted worktrees
 * included) and wake from hibernation are `true`. A script that registers a
 * workspace somewhere external will want to skip reopens, and one that re-warms
 * a cache or mints a credential will not.
 */
const openInputSchema = coreInputSchema.extend({
  reopened: z.boolean(),
});

const beforeWorkspaceOpenedInputSchema = openInputSchema;

const beforeWorktreeDeletedInputSchema = coreInputSchema.extend({
  /** The branch survives the deletion — so unmerged commits stay reachable. */
  keepBranch: z.boolean(),
});

const onWorkspaceOpenedInputSchema = openInputSchema;

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
 * A tag's name, held to the rule its metadata key must obey.
 *
 * Checked here rather than at the write: a name that cannot be stored used to
 * slip through as a warning, reach `workspace:created` and show in the sidebar
 * until the next restart quietly lost it. Failing the whole output instead is
 * the strict-schema rule applied to keys — the author finds out now, with the
 * name in the message.
 */
const tagNameSchema = z
  .string()
  .refine((name) => isValidMetadataKey(`${TAGS_METADATA_KEY_PREFIX}${name}`), {
    error:
      `not a valid tag name (each dot-separated part must ` +
      `start with a letter, contain only letters, digits and -, and not end with -; ` +
      `at most 59 characters in all)`,
  });

/**
 * What `after-worktree-created` may contribute back.
 *
 * Separate fields rather than one metadata map, so the reachable surface is
 * exactly these: a repository cannot write `base`, which the deletion gate's
 * unmerged-commit check reads and which a setup script must not be able to
 * rewrite from under it.
 *
 * No `env`: environment is not a once-per-worktree thing — it has to be there
 * on every open, after a restart and a wake too — so it belongs to
 * `before-workspace-opened`, which runs each time.
 *
 * Strict on purpose — `{"titel": …}`, or an `env` left over from before the
 * split, is a mistake that would otherwise be dropped in silence.
 */
export const afterWorktreeCreatedOutputSchema = z
  .object({
    /** Sidebar display title. The branch name stays the identity. */
    title: z.string().optional(),
    /** Tags to attach, keyed by name. */
    tags: z.record(tagNameSchema, tagSchema).optional(),
  })
  .strict();

export type AfterWorktreeCreatedOutput = z.infer<typeof afterWorktreeCreatedOutputSchema>;

/**
 * What `before-workspace-opened` may return: the workspace's environment.
 *
 * Delivered in memory to the agent (its terminal and its server) and to the
 * editor's terminals, and never written to disk — which is why the hook runs on
 * every open: nothing survives a restart for it to rely on.
 *
 * Strict for the same reason as the setup hook: `{"envs": …}` is a typo, and an
 * environment that quietly never arrived is a miserable thing to debug.
 */
export const beforeWorkspaceOpenedOutputSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type BeforeWorkspaceOpenedOutput = z.infer<typeof beforeWorkspaceOpenedOutputSchema>;

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

/**
 * A blocking entry: the on-disk name plus the JSON it exchanges.
 *
 * Something is waiting on it — a workspace opening, a deletion pausing — so it
 * gets to return a result, and a failure is worth reporting.
 */
export interface HookSpec {
  readonly name: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/**
 * A fire-and-forget entry, named `on-<something-that-happened>`.
 *
 * No output, because nothing is waiting for one: by the time it runs, the thing
 * it reports is already true and cannot be affected.
 */
export interface EventSpec {
  readonly name: string;
  readonly input: z.ZodType;
}

export const AFTER_WORKTREE_CREATED: HookSpec = {
  name: "after-worktree-created",
  input: afterWorktreeCreatedInputSchema,
  output: afterWorktreeCreatedOutputSchema,
};

export const BEFORE_WORKSPACE_OPENED: HookSpec = {
  name: "before-workspace-opened",
  input: beforeWorkspaceOpenedInputSchema,
  output: beforeWorkspaceOpenedOutputSchema,
};

export const BEFORE_WORKTREE_DELETED: HookSpec = {
  name: "before-worktree-deleted",
  input: beforeWorktreeDeletedInputSchema,
  output: beforeWorktreeDeletedOutputSchema,
};

export const ON_WORKSPACE_OPENED: EventSpec = {
  name: "on-workspace-opened",
  input: onWorkspaceOpenedInputSchema,
};

// =============================================================================
// Bindings
// =============================================================================

/** Exhaustive over one operation's hook points. `null` = not exposed. */
type HookPointMap<S extends OperationSchemas> = Readonly<Record<HookPointOf<S>, HookSpec | null>>;

/**
 * The two points before `setup` exist for this map, one per entry, in the order
 * a repository needs them: `provision` sets a genuinely new worktree up once,
 * then `prepare` supplies the environment on every open. Both precede `setup`
 * because that is where the agent server starts, and it must start in a set-up
 * tree with the environment already known. `create` runs before the worktree
 * exists; `finalize` runs after the environment has been consumed.
 */
export const OPEN_WORKSPACE_HOOKS: HookPointMap<typeof openWorkspaceSchemas> = {
  create: null,
  provision: AFTER_WORKTREE_CREATED,
  prepare: BEFORE_WORKSPACE_OPENED,
  setup: null,
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
  BEFORE_WORKSPACE_OPENED,
  BEFORE_WORKTREE_DELETED,
  ON_WORKSPACE_OPENED,
];
