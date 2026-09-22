/**
 * HooksModule — lets a repository attach its own scripts to CodeHydra's
 * lifecycle.
 *
 * A repository declares hooks by dropping executable files into
 * `.codehydra/hooks/` in its worktree. An `on-` entry reports something that
 * already happened and is fired and forgotten; every other entry runs at a
 * moment CodeHydra is waiting on and may return data. `hook-map.ts` is the
 * whole contract — which moments exist, what each is handed, what each may
 * return — and nothing internal reaches disk.
 *
 * Hooks are read from the *acted-on worktree*, never the project root. That is
 * the only tree the user ever has open in the IDE, so it is the only place a
 * hook can actually be authored and iterated on; the price, worth documenting,
 * is that a hook must be committed on the branch a workspace is created from.
 *
 * What the four entries do:
 * - `after-worktree-created` runs at `open-workspace : provision`, only for a
 *   genuinely new worktree. It blocks the open and is best-effort: a failure
 *   is loud but the workspace still opens. There is no rollback to be had —
 *   the worktree already exists by then — and a failed `pnpm install` is a
 *   thing you fix *in* the workspace.
 * - `before-workspace-opened` runs at `open-workspace : prepare` on every open
 *   — new, app start, project open, wake — and supplies the environment the
 *   agent and the editor's terminals get. Same failure rule. It runs each time
 *   because that environment lives in memory only and is never written down.
 * - `before-worktree-deleted` runs at `delete-workspace : pre-delete` and can
 *   refuse. It fails closed: a script that breaks stops the deletion too.
 * - `on-workspace-opened` observes `workspace:created` (every open) and can
 *   affect nothing.
 *
 * While a blocking entry's process runs it is registered with the presenter,
 * which offers a Cancel for it (the loading surface, a notification, or the
 * deletion panel). Cancel kills the hook's process tree and counts as that
 * hook failing, with that entry's usual consequence.
 */

import type { z } from "zod/v4";
import type { IntentModule, EventDeclarations, HookDeclarations } from "../../intents/lib/module";
import type { DomainEvent } from "../../intents/lib/types";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { RunningHook, UiPresenter } from "../presentation/presentation-module";
import { notify } from "../presentation/notification-card";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import { storeBoolean, storeCustom } from "../../boundaries/platform/store-definition";
import { Path } from "../../utils/path/path";
import { getErrorMessage } from "../../shared/error-utils";
import { TAGS_METADATA_KEY_PREFIX, TITLE_METADATA_KEY } from "../../shared/api/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type PrepareHookInput,
  type PrepareHookResult,
  type ProvisionHookInput,
  type ProvisionHookResult,
  type WorkspaceCreatedEvent,
} from "../../intents/open-workspace";
import {
  CAPABILITY_REPO_HOOK,
  DELETE_WORKSPACE_OPERATION_ID,
  type DeletePipelineHookInput,
  type DeleteWorkspaceIntent,
  type PreDeleteHookResult,
  type PreDeleteStartedFrame,
  type PreflightHookResult,
  EVENT_WORKSPACE_DELETED,
  type WorkspaceDeletedEvent,
} from "../../intents/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import type { WorkspacePath } from "../../intents/contract";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import {
  AFTER_WORKTREE_CREATED,
  BEFORE_WORKSPACE_OPENED,
  BEFORE_WORKTREE_DELETED,
  ON_WORKSPACE_OPENED,
  afterWorktreeCreatedOutputSchema,
  beforeWorkspaceOpenedOutputSchema,
  beforeWorktreeDeletedOutputSchema,
  type AfterWorktreeCreatedOutput,
  type CoreInput,
  type HookSpec,
} from "./hook-map";
import {
  ambiguityError,
  findHook,
  runEventHook,
  runHook,
  type FoundHook,
  type HookOutputSink,
  type HookRunnerDeps,
} from "./runner";
import { createTrustGate, type TrustGate } from "./trust";

// =============================================================================
// Dependencies
// =============================================================================

export interface HooksModuleDeps {
  readonly fileSystem: FileSystemBoundary;
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
  readonly config: Config;
  readonly stateService: StateService;
  readonly dispatcher: Dispatcher;
  readonly ui: Pick<UiPresenter, "dialog" | "trackRunningHook">;
  /** Directory holding the `ch` CLI, prepended to every hook's PATH. */
  readonly binDir: Path;
  readonly sink: HookOutputSink;
  /** Which platform-suffixed hook files apply. Default: this process's. */
  readonly platform?: NodeJS.Platform;
}

// =============================================================================
// State + config
// =============================================================================

/**
 * Per-project trust answers. `true` = Always, `false` = Never; a project with
 * no entry has not been asked, or was only ever answered Once/Skip.
 */
function registerTrustState(stateService: StateService) {
  return stateService.register<Record<string, boolean>>("hooks.trusted", {
    default: {},
    description: "Projects whose .codehydra hooks may run (Always) or may not (Never)",
    ...storeCustom<Record<string, boolean>>({
      parse: (raw) => parseTrustMap(safeJsonParse(raw)),
      validate: (value) => parseTrustMap(value),
      validValues: "<project path → boolean>",
    }),
  });
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Keep only string→boolean pairs; a hand-edited oddity costs its own entry. */
function parseTrustMap(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

// =============================================================================
// Output mapping
// =============================================================================

/** The `codehydra.*` metadata keys a setup hook's `title`/`tags` map to. */
export function toMetadata(output: AfterWorktreeCreatedOutput): Record<string, string> {
  const metadata: Record<string, string> = {};

  if (output.title !== undefined) {
    metadata[TITLE_METADATA_KEY] = output.title;
  }
  for (const [name, tag] of Object.entries(output.tags ?? {})) {
    metadata[`${TAGS_METADATA_KEY_PREFIX}${name}`] = JSON.stringify(tag);
  }

  return metadata;
}

/** Prefix of CodeHydra's own variables, which a repository's env may not override. */
const RESERVED_ENV_PREFIX = "_CH_";

/**
 * A hook's `env`, minus the keys CodeHydra owns.
 *
 * Dropped here, once, rather than left to each consumer's merge order: the
 * environment goes to several places (the agent terminal, the OpenCode server,
 * the editor's terminals), and one of them getting the precedence wrong would
 * let a repository point `ch` at another workspace or another instance.
 */
export function splitReservedEnv(env: Readonly<Record<string, string>>): {
  readonly env: Record<string, string>;
  readonly dropped: readonly string[];
} {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(RESERVED_ENV_PREFIX)) dropped.push(key);
    else kept[key] = value;
  }
  return { env: kept, dropped };
}

// =============================================================================
// Module
// =============================================================================

export function createHooksModule(deps: HooksModuleDeps): IntentModule {
  const enabled = deps.config.register("hooks.enabled", {
    default: true,
    description: "Run a repository's .codehydra hooks",
    applies: "live",
    ...storeBoolean(),
  });

  const trustState = registerTrustState(deps.stateService);

  const trust: TrustGate = createTrustGate({
    trusted: trustState,
    ui: deps.ui,
    logger: deps.logger,
  });

  const runnerDeps: HookRunnerDeps = {
    fileSystem: deps.fileSystem,
    processRunner: deps.processRunner,
    logger: deps.logger,
    binDir: deps.binDir,
    sink: deps.sink,
    ...(deps.platform !== undefined && { platform: deps.platform }),
  };

  // ---------------------------------------------------------------------------
  // after-worktree-created
  // ---------------------------------------------------------------------------

  async function afterWorktreeCreated(ctx: HookContext): Promise<HookOutput<ProvisionHookResult>> {
    const input = ctx as ProvisionHookInput;
    const intent = ctx.intent as OpenWorkspaceIntent;

    // Activating a discovered workspace is not a creation. Re-running a setup
    // script for every workspace at every project open would be both surprising
    // and slow — that is what `before-workspace-opened` is for.
    if (intent.payload.existingWorkspace !== undefined) return { result: {} };

    const output = await runOpenHook(
      input,
      AFTER_WORKTREE_CREATED,
      coreInput(input, intent),
      afterWorktreeCreatedOutputSchema
    );
    if (output === undefined) return { result: {} };

    const metadata = toMetadata(output);
    await persistMetadata(input.workspacePath, metadata);
    return { result: Object.keys(metadata).length > 0 ? { metadata } : {} };
  }

  // ---------------------------------------------------------------------------
  // before-workspace-opened
  // ---------------------------------------------------------------------------

  async function beforeWorkspaceOpened(ctx: HookContext): Promise<HookOutput<PrepareHookResult>> {
    const input = ctx as PrepareHookInput;
    const intent = ctx.intent as OpenWorkspaceIntent;

    const output = await runOpenHook(
      input,
      BEFORE_WORKSPACE_OPENED,
      { ...coreInput(input, intent), reopened: intent.payload.existingWorkspace !== undefined },
      beforeWorkspaceOpenedOutputSchema
    );
    if (output?.env === undefined) return { result: {} };

    const { env, dropped } = splitReservedEnv(output.env);
    if (dropped.length > 0) {
      deps.logger.warn("Repository hook env may not set CodeHydra's own variables", {
        entry: BEFORE_WORKSPACE_OPENED.name,
        dropped: dropped.join(","),
      });
    }
    return { result: { env } };
  }

  /**
   * Run one of the blocking open entries, if the repository has it and may.
   *
   * Loud, but not fatal: `undefined` means "nothing to apply", whether there was
   * no hook, trust said skip, or the hook failed. The worktree exists by now, so
   * failing the open would either strand it or need a teardown path — and a
   * workspace you can open is where you fix whatever went wrong.
   */
  async function runOpenHook<T>(
    input: ProvisionHookInput | PrepareHookInput,
    spec: HookSpec,
    stdin: CoreInput & Record<string, unknown>,
    schema: z.ZodType<T>
  ): Promise<T | undefined> {
    // Whatever happened to this workspace's editor before, it is coming now.
    deps.sink.opening(input.workspacePath);
    if (!allowed()) return undefined;

    const worktree = new Path(input.workspacePath);
    const found = await findHook(runnerDeps, worktree, spec.name);
    if (!found) return undefined;

    const decision = await trust.check({
      projectPath: input.projectPath,
      workspacePath: input.workspacePath,
      entry: found.entry,
    });
    if (decision === "skip") return undefined;

    try {
      return await runCancelable(
        found,
        {
          workspacePath: input.workspacePath,
          projectPath: input.projectPath,
          workspaceName: stdin.workspaceName,
          phase: "open",
        },
        (signal) => runHook(runnerDeps, found, worktree, stdin, schema, { signal })
      );
    } catch (error) {
      reportFailure(found, error);
      return undefined;
    }
  }

  /**
   * Run a blocking hook with a Cancel on offer for as long as it runs.
   *
   * An ambiguous entry never starts a process, so it is not offered — it fails
   * straight away inside `run`.
   */
  async function runCancelable<T>(
    found: FoundHook,
    hook: Omit<RunningHook, "entry" | "cancel">,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const untrack =
      found.kind === "file"
        ? deps.ui.trackRunningHook({
            ...hook,
            entry: found.entry,
            cancel: () => controller.abort(),
          })
        : undefined;
    try {
      return await run(controller.signal);
    } finally {
      untrack?.();
    }
  }

  function reportFailure(found: FoundHook, error: unknown): void {
    // warn, not error: a repository's script failing — or the user canceling
    // it — is the repository's problem, and CodeHydra is working as designed.
    // The `error` level is kept for CodeHydra itself being broken; the user
    // still gets the error notification below.
    deps.logger.warn("Repository hook failed", {
      entry: found.entry,
      error: getErrorMessage(error),
    });
    notify(deps.dispatcher, {
      type: "error",
      title: "Repository hook failed",
      message: getErrorMessage(error),
      dismissible: true,
    });
  }

  /** The core every open entry is handed. `branch`/`base` stay absent when unknown. */
  function coreInput(
    input: ProvisionHookInput | PrepareHookInput,
    intent: OpenWorkspaceIntent
  ): CoreInput {
    return {
      workspaceName: intent.payload.existingWorkspace?.name ?? intent.payload.workspaceName,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      ...(input.branch !== undefined && { branch: input.branch }),
      ...(input.base !== undefined && { base: input.base }),
    };
  }

  // ---------------------------------------------------------------------------
  // before-worktree-deleted
  // ---------------------------------------------------------------------------

  async function* beforeWorktreeDeleted(
    ctx: HookContext
  ): AsyncGenerator<PreDeleteStartedFrame, HookOutput<PreDeleteHookResult>, void> {
    const input = ctx as DeletePipelineHookInput;
    const intent = ctx.intent as DeleteWorkspaceIntent;

    if (!allowed()) return { result: {} };

    const worktree = new Path(input.workspacePath);
    const found = await findHook(runnerDeps, worktree, BEFORE_WORKTREE_DELETED.name);
    if (!found) return { result: {} };

    // Claim a row on the deletion panel before anything slow happens — the
    // trust dialog included, so a question raised here has something to explain
    // it. Without a hook nothing is yielded and no row ever appears.
    yield { started: true };

    const decision = await trust.check({
      projectPath: input.projectPath,
      workspacePath: input.workspacePath,
      entry: found.entry,
    });
    if (decision === "skip") return { result: {} };

    const identity = await resolveBranchAndBase(input.workspacePath);

    // The editor was torn down at "shutdown" and is not coming back: whatever
    // this hook prints belongs in the log, not in a buffer nobody will flush.
    deps.sink.closed(input.workspacePath);

    const output = await runCancelable(
      found,
      {
        workspacePath: input.workspacePath,
        projectPath: input.projectPath,
        workspaceName: input.workspaceName,
        phase: "delete",
      },
      (signal) =>
        runHook(
          runnerDeps,
          found,
          worktree,
          {
            workspaceName: input.workspaceName,
            workspacePath: input.workspacePath,
            projectPath: input.projectPath,
            ...identity,
            keepBranch: intent.payload.keepBranch,
          },
          beforeWorktreeDeletedOutputSchema,
          { signal }
        )
    );

    // A throw above is the "could not tell" half of the gate and stops the
    // deletion by itself; this is the deliberate refusal.
    return {
      result: {
        ...(output.blocked === true && { blocked: true }),
        ...(output.reason !== undefined && { reason: output.reason }),
      },
    };
  }

  /**
   * Claim the deletion panel's row, if this repository has a hook to run.
   *
   * Runs at "preflight" purely for its timing: that is the last hook point
   * before the first progress event, so it is the only place the row can be
   * claimed early enough to be listed alongside the other steps. It never
   * blocks — the decision belongs to `before-worktree-deleted` itself — and it
   * asks nothing about trust, because a question raised here would arrive
   * before the user has even seen a deletion start.
   */
  async function announceDeleteHook(ctx: HookContext): Promise<HookOutput<PreflightHookResult>> {
    const input = ctx as DeletePipelineHookInput;
    const { payload } = ctx.intent as DeleteWorkspaceIntent;

    // Exactly the conditions under which the stage will actually run.
    if (!payload.removeWorktree || payload.force || !allowed()) return {};

    const found = await findHook(
      runnerDeps,
      new Path(input.workspacePath),
      BEFORE_WORKTREE_DELETED.name
    );

    return found ? { provides: { [CAPABILITY_REPO_HOOK]: true } } : {};
  }

  // ---------------------------------------------------------------------------
  // on-workspace-opened (fire-and-forget)
  // ---------------------------------------------------------------------------

  function onWorkspaceOpened(event: DomainEvent): void {
    const payload = (event as WorkspaceCreatedEvent).payload;
    const worktree = new Path(payload.workspacePath);

    void (async (): Promise<void> => {
      try {
        if (!allowed()) return;

        const found = await findHook(runnerDeps, worktree, ON_WORKSPACE_OPENED.name);
        if (!found) return;

        const decision = await trust.check({
          projectPath: payload.projectPath,
          workspacePath: payload.workspacePath,
          entry: found.entry,
        });
        if (decision === "skip") return;

        // Nothing waits on this entry, but a repository whose files cannot say
        // which one is the hook has a mistake the author needs to hear about.
        if (found.kind === "ambiguous") {
          reportFailure(found, ambiguityError(found));
          return;
        }

        await runEventHook(runnerDeps, found, worktree, {
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
          projectPath: payload.projectPath,
          ...(payload.branch !== undefined && { branch: payload.branch }),
          ...(payload.base !== undefined && { base: payload.base }),
          reopened: payload.reopened === true,
        });
      } catch (error) {
        deps.logger.warn("Event hook could not be dispatched", {
          entry: ON_WORKSPACE_OPENED.name,
          error: getErrorMessage(error),
        });
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a hook's title and tags to the workspace's git config.
   *
   * Done during `setup`, so WorktreeModule's finalize re-read — which folds in
   * after every setup result — sees them and reports the same values. Writing
   * later, or not at all, loses them to that read.
   *
   * Best-effort per key: a tag that could not be written should not cost the
   * title, and none of it should cost the workspace.
   */
  async function persistMetadata(
    workspacePath: WorkspacePath,
    metadata: Record<string, string>
  ): Promise<void> {
    for (const [key, value] of Object.entries(metadata)) {
      try {
        await deps.dispatcher.dispatch<SetMetadataIntent>({
          type: INTENT_SET_METADATA,
          payload: { workspacePath, key, value },
        });
      } catch (error) {
        deps.logger.warn("Could not persist metadata from a hook", {
          key,
          error: getErrorMessage(error),
        });
      }
    }
  }

  /** The global kill switch — the way out when a repository's hook is broken. */
  function allowed(): boolean {
    if (enabled.get()) return true;
    deps.logger.debug("Repository hooks are disabled by configuration");
    return false;
  }

  /**
   * The branch and base for a workspace being deleted.
   *
   * Read here rather than threaded through the deletion contract: the pipeline
   * resolves identity for its own purposes and has no use for either, and this
   * is a git-config read on a path that is already doing far slower work.
   * Best-effort — a workspace we cannot resolve still gets its gate, just
   * without the two optional fields.
   */
  async function resolveBranchAndBase(
    workspacePath: WorkspacePath
  ): Promise<{ branch?: string; base?: string }> {
    try {
      const resolved = await deps.dispatcher.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath },
      });
      const base = resolved.metadata["base"];
      return {
        ...(resolved.branch !== null && { branch: resolved.branch }),
        ...(base !== undefined && { base }),
      };
    } catch (error) {
      deps.logger.debug("Could not resolve branch/base for a hook", {
        workspacePath,
        error: getErrorMessage(error),
      });
      return {};
    }
  }

  const hooks: HookDeclarations = {
    [OPEN_WORKSPACE_OPERATION_ID]: {
      provision: { handler: afterWorktreeCreated },
      prepare: { handler: beforeWorkspaceOpened },
    },
    [DELETE_WORKSPACE_OPERATION_ID]: {
      preflight: { handler: announceDeleteHook },
      "pre-delete": { handler: beforeWorktreeDeleted },
    },
  };

  const events: EventDeclarations = {
    [EVENT_WORKSPACE_CREATED]: {
      // Returns immediately: the emitter must never wait on a repository's
      // script, least of all one that may park on a trust dialog.
      handler: async (event: DomainEvent): Promise<void> => {
        onWorkspaceOpened(event);
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      // Its editor is never coming back, so neither is a reason to hold its output.
      handler: async (event: DomainEvent): Promise<void> => {
        deps.sink.closed((event as WorkspaceDeletedEvent).payload.workspacePath);
      },
    },
  };

  return { name: "hooks", hooks, events };
}
