/**
 * HooksModule — lets a repository attach its own scripts to CodeHydra's
 * lifecycle, and replaces `.keepfiles` entirely.
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
 * What the three entries do:
 * - `after-worktree-created` runs at `open-workspace : setup`, blocks the open
 *   (it must, to inject environment variables), and is best-effort: a failure
 *   is loud but the workspace still opens. There is no rollback to be had —
 *   the worktree already exists by then — and a failed `pnpm install` is a
 *   thing you fix *in* the workspace.
 * - `before-worktree-deleted` runs at `delete-workspace : pre-delete` and can
 *   refuse. It fails closed: a script that breaks stops the deletion too.
 * - `on-workspace-created` observes `workspace:created` and can affect nothing.
 */

import type { IntentModule, EventDeclarations, HookDeclarations } from "../../intents/lib/module";
import type { DomainEvent } from "../../intents/lib/types";
import type { HookContext, HookOutput } from "../../intents/lib/operation";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { UiPresenter } from "../presentation/presentation-module";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import type { StateService } from "../../boundaries/platform/state-service";
import { storeBoolean, storeCustom } from "../../boundaries/platform/store-definition";
import { Path } from "../../utils/path/path";
import { FileSystemError } from "../../shared/errors/service-errors";
import { getErrorMessage } from "../../shared/error-utils";
import { TAGS_METADATA_KEY_PREFIX, TITLE_METADATA_KEY } from "../../shared/api/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type SetupHookInput,
  type SetupHookResult,
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
} from "../../intents/delete-workspace";
import {
  INTENT_RESOLVE_WORKSPACE,
  type ResolveWorkspaceIntent,
} from "../../intents/resolve-workspace";
import type { WorkspacePath } from "../../intents/contract";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import {
  AFTER_WORKTREE_CREATED,
  BEFORE_WORKTREE_DELETED,
  ON_WORKSPACE_CREATED,
  afterWorktreeCreatedOutputSchema,
  beforeWorktreeDeletedOutputSchema,
  type AfterWorktreeCreatedOutput,
} from "./hook-map";
import {
  findHook,
  runEventHook,
  runHook,
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
  readonly ui: Pick<UiPresenter, "dialog" | "notification">;
  /** Directory holding the `ch` CLI, prepended to every hook's PATH. */
  readonly binDir: Path;
  readonly sink: HookOutputSink;
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

/**
 * Fold a setup hook's return value into the shape the operation already merges.
 *
 * The metadata is reported here *as well as* being written to git config,
 * because reporting alone would not survive: WorktreeModule's finalize handler
 * re-reads git config and its result folds in last, so a title that exists only
 * as a setup result is superseded by that read a moment later. Writing it first
 * makes the read agree — and makes the value durable, which reporting never was.
 */
export function toSetupResult(output: AfterWorktreeCreatedOutput): SetupHookResult {
  const metadata = toMetadata(output);
  return {
    ...(output.env !== undefined && { envVars: output.env }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
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
  };

  /** Projects already told their `.keepfiles` is dead. One notice, not one per workspace. */
  const keepFilesWarned = new Set<string>();

  /**
   * `.keepfiles` was replaced outright, and stopping silently would look
   * exactly like data loss — the files it used to copy simply stop appearing.
   * So the file's continued presence is reported once per project, naming what
   * to do instead.
   */
  async function warnAboutStaleKeepFiles(projectPath: string): Promise<void> {
    if (keepFilesWarned.has(projectPath)) return;
    keepFilesWarned.add(projectPath);

    const path = new Path(projectPath, ".keepfiles");
    try {
      await deps.fileSystem.readFile(path);
    } catch (error) {
      // Absent is the expected case and says nothing.
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") return;
      return;
    }

    deps.logger.warn(".keepfiles is no longer supported", { path: path.toNative() });
    deps.ui.notification({
      type: "warning",
      title: ".keepfiles is no longer supported",
      message:
        "Nothing was copied. Move it to .codehydra/hooks/after-worktree-created — " +
        "a script that copies the files you want into the new worktree.",
      dismissible: true,
    });
  }

  // ---------------------------------------------------------------------------
  // after-worktree-created
  // ---------------------------------------------------------------------------

  async function afterWorktreeCreated(ctx: HookContext): Promise<HookOutput<SetupHookResult>> {
    const input = ctx as SetupHookInput;
    const intent = ctx.intent as OpenWorkspaceIntent;

    // Activating a discovered workspace is not a creation. Re-running a setup
    // script for every workspace at every project open would be both surprising
    // and slow — and it is the rule `.keepfiles` already followed.
    if (intent.payload.existingWorkspace !== undefined) return { result: {} };

    await warnAboutStaleKeepFiles(input.projectPath);

    if (!allowed()) return { result: {} };

    const worktree = new Path(input.workspacePath);
    const found = await findHook(runnerDeps, worktree, AFTER_WORKTREE_CREATED.name);
    if (!found) return { result: {} };

    const decision = await trust.check({
      projectPath: input.projectPath,
      workspacePath: input.workspacePath,
      entry: found.entry,
    });
    if (decision === "skip") return { result: {} };

    try {
      const output = await runHook(
        runnerDeps,
        found,
        worktree,
        {
          workspaceName: intent.payload.workspaceName,
          workspacePath: input.workspacePath,
          projectPath: input.projectPath,
          branch: input.branch,
          ...(input.base !== undefined && { base: input.base }),
        },
        afterWorktreeCreatedOutputSchema
      );
      await persistMetadata(input.workspacePath, toMetadata(output));
      return { result: toSetupResult(output) };
    } catch (error) {
      // Loud, but not fatal. The worktree exists by now, so failing the open
      // would either strand it or need a teardown path — and a workspace you
      // can open is where you fix whatever went wrong.
      const message = getErrorMessage(error);
      deps.logger.error("Repository hook failed", { entry: found.entry }, toError(error));
      deps.ui.notification({
        type: "error",
        title: "Repository hook failed",
        message,
        dismissible: true,
      });
      return { result: {} };
    }
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

    const output = await runHook(
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
      beforeWorktreeDeletedOutputSchema
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
  // on-workspace-created (fire-and-forget)
  // ---------------------------------------------------------------------------

  function onWorkspaceCreated(event: DomainEvent): void {
    const payload = (event as WorkspaceCreatedEvent).payload;
    const worktree = new Path(payload.workspacePath);

    void (async (): Promise<void> => {
      try {
        if (!allowed()) return;

        const found = await findHook(runnerDeps, worktree, ON_WORKSPACE_CREATED.name);
        if (!found) return;

        const decision = await trust.check({
          projectPath: payload.projectPath,
          workspacePath: payload.workspacePath,
          entry: found.entry,
        });
        if (decision === "skip") return;

        await runEventHook(runnerDeps, found, worktree, {
          workspaceName: payload.workspaceName,
          workspacePath: payload.workspacePath,
          projectPath: payload.projectPath,
          branch: payload.branch,
          ...(payload.base !== undefined && { base: payload.base }),
          reopened: payload.reopened === true,
        });
      } catch (error) {
        deps.logger.warn("Event hook could not be dispatched", {
          entry: ON_WORKSPACE_CREATED.name,
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
      setup: { handler: afterWorktreeCreated },
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
        onWorkspaceCreated(event);
      },
    },
  };

  return { name: "hooks", hooks, events };
}

function toError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}
