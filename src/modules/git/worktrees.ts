/**
 * The workspace side of the git type: a git project's workspaces are its
 * worktrees. Discovery and adoption, worktree create/remove, the delete
 * preflight, status, bases and each project's default base.
 *
 * The workspaces themselves, and their metadata, live in the core workspace
 * registry (`workspace-registry-module.ts`): this part tells it what discovery
 * and creation found, where each worktree's metadata file is
 * (`.git/worktrees/<id>/codehydra.json`) and when a worktree is gone, and the
 * registry answers resolve, switch, list and metadata for every project type alike.
 */

import type { GitWorktreeProvider } from "../../boundaries/platform/git-worktree-provider";
import type { UnmanagedWorktree } from "../../boundaries/platform/git-types";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { notify } from "../presentation/notification-card";
import type { WorkspacesRoot } from "../workspaces-root/workspaces-root";
import type { Logger } from "../../boundaries/platform/logging-types";
import type {
  CreateHookInput,
  CreateHookResult,
  OpenWorkspacePayload,
} from "../../intents/open-workspace";
import type { ListChoicesHookResult } from "../../intents/get-option-choices";
import { branchChoices } from "./choices";
import type {
  DeleteHookResult,
  DeletePipelineHookInput,
  DeleteWorkspacePayload,
  PreflightHookResult,
} from "../../intents/delete-workspace";
import type {
  DiscoverHookInput,
  DiscoverHookResult,
  OpenProjectPayload,
  PrepareHookResult,
} from "../../intents/open-project";
import type { GetStatusHookInput, GetStatusHookResult } from "../../intents/get-workspace-status";
import type {
  ListWorkspacesHookEntry,
  ListWorkspacesHookResult,
} from "../../intents/list-projects";
import { Path } from "../../utils/path/path";
import { getErrorMessage, WorkspaceError } from "../../shared/errors/service-errors";
import { projectPathSchema, workspacePathSchema } from "../../intents/contract";
import type { ProjectPath, WorkspacePath } from "../../intents/contract";
import { descriptionOf, toDiscoveredWorkspaces } from "../../utils/workspace-conversion";
import {
  BASE_METADATA_KEY,
  branchOf,
  describeWorkStatus,
  describeWorktree,
  registeredWorkspace,
} from "./describe";
import type { WorkspaceRegistry } from "../workspace-registry-module";
import type { WorktreePicker } from "./worktree-picker";
import { gitCreateOptions, gitDeleteOptions } from "./options";

export interface GitWorktreesDeps {
  readonly gitWorktreeProvider: GitWorktreeProvider;
  /** Where each project's worktrees are created. */
  readonly workspacesRoot: Pick<WorkspacesRoot, "workspacesDir" | "previousWorkspacesDirs">;
  readonly logger: Logger;
  /** The add-project worktree picker. */
  readonly pickWorktrees: WorktreePicker;
  /** For the picker's failure notice (`notification:show`). */
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  /** The core workspace registry, told what exists. */
  readonly registry: WorkspaceRegistry;
}

export interface GitWorktrees {
  /** project:open prepare: offer the project's pre-existing worktrees for adoption. */
  offerWorktrees(payload: OpenProjectPayload): Promise<PrepareHookResult>;
  /** project:open discover: the project's worktrees, told to the registry. */
  discover(ctx: DiscoverHookInput): Promise<DiscoverHookResult>;
  /** project:close close: forget the project. */
  forget(projectPath: string): void;
  /** workspace:open create: a new worktree, or a discovered one reopened. */
  create(ctx: CreateHookInput, payload: OpenWorkspacePayload): Promise<CreateHookResult>;
  /**
   * project:get-option-choices list: the branches as `base`'s choices and as
   * name suggestions. Without `fresh`, the last answer for the project when
   * there is one, so the form paints without a git round-trip.
   */
  listChoices(projectPath: string, fresh: boolean): Promise<ListChoicesHookResult>;
  /** project:refresh refresh: fetch. */
  refreshBases(projectPath: string): Promise<void>;
  /** workspace:delete preflight: what a worktree removal would lose. */
  preflight(
    ctx: DeletePipelineHookInput,
    payload: DeleteWorkspacePayload
  ): Promise<PreflightHookResult>;
  /** workspace:delete delete: remove the worktree, or only let go of it. */
  remove(ctx: DeletePipelineHookInput, payload: DeleteWorkspacePayload): Promise<DeleteHookResult>;
  /** workspace:get-status get. */
  status(ctx: GetStatusHookInput): Promise<GetStatusHookResult>;
  /** list-projects list-workspaces: each open project's default base branch. */
  defaultBases(): ListWorkspacesHookResult;
}

export function createGitWorktrees(deps: GitWorktreesDeps): GitWorktrees {
  const { gitWorktreeProvider, workspacesRoot, logger, pickWorktrees, dispatcher, registry } = deps;

  /** Where a worktree's metadata file is, found when the registry first writes it. */
  const locatorOf =
    (worktreePath: Path): (() => Promise<Path>) =>
    () =>
      gitWorktreeProvider.metadataFileOf(worktreePath);

  /** The base a workspace recorded in its metadata, if the registry holds it. */
  const recordedBase = (worktreePath: Path): string | undefined => {
    try {
      return registry.metadata(worktreePath)[BASE_METADATA_KEY];
    } catch {
      return undefined;
    }
  };

  // Per-project default base branch, computed at project:open (discover) and
  // refreshed by every choices list. Surfaced via list-workspaces for the
  // project's repository automations (plugin-module).
  const projectDefaults = new Map<ProjectPath, string>();

  // The last choices answer per project, so a form opened again paints at once;
  // the refresh that follows corrects it (`fresh`).
  const lastChoices = new Map<ProjectPath, ListChoicesHookResult>();

  /**
   * Normalize a path and keep its brand. `new Path(p).toString()` is how this part
   * canonicalizes its map keys, but it returns a plain string — parsing re-mints the brand so
   * a key can go straight back onto a hook result without a cast.
   */
  const projectKey = (p: string): ProjectPath => projectPathSchema.parse(new Path(p).toString());
  const workspaceKey = (p: string): WorkspacePath =>
    workspacePathSchema.parse(new Path(p).toString());

  return {
    // Only for an interactive add of a local path. Startup restore and
    // auto-workspace re-run this same operation with the same payload, and must
    // never interrupt with a dialog — `initial` is what separates them.
    async offerWorktrees(payload) {
      const { path, git, initial } = payload;

      // Self-select: interactive add, local path only. A fresh clone has no
      // pre-existing worktrees, so the picker would always be empty for one.
      if (!initial || git || !path) return {};

      const projectPathObj = new Path(path);
      const workspacesDir = workspacesRoot.workspacesDir(projectPathObj);

      let unmanaged: readonly UnmanagedWorktree[];
      try {
        unmanaged = await gitWorktreeProvider.listUnmanagedWorktrees(
          projectPathObj,
          workspacesDir,
          workspacesRoot.previousWorkspacesDirs()
        );
      } catch (error: unknown) {
        // Not a repository, or git is unhappy — either way the open proceeds and
        // resolve reports it.
        logger.warn("Failed to list worktrees for the add-project picker", {
          projectPath: path,
          error: getErrorMessage(error),
        });
        return {};
      }

      // Nothing the user could act on: say nothing. discover() logs the
      // worktrees it skips, so agent scratch worktrees stay diagnosable
      // without putting a dialog in the way of adding a project.
      if (unmanaged.length === 0) return {};

      const picked = await pickWorktrees(path, unmanaged);
      if (picked === null) return { canceled: true };

      const failed: string[] = [];
      for (const wt of picked) {
        try {
          await gitWorktreeProvider.adoptWorktree(projectPathObj, wt.path, wt.branch);
        } catch (error: unknown) {
          failed.push(wt.name);
          logger.scoped({ path: wt.path.toString() }).warn("Failed to adopt worktree", {
            branch: wt.branch,
            error: getErrorMessage(error),
          });
        }
      }

      // The tag IS the ownership record, so a failed write means the worktree
      // is not a workspace — say so rather than let it silently disappear on
      // the next restart.
      if (failed.length > 0) {
        notify(dispatcher, {
          title: "Could not open some worktrees",
          message: `${failed.join(", ")} could not be marked as CodeHydra workspaces.`,
          type: "error",
          dismissible: true,
        });
      }

      return {};
    },

    async discover(ctx) {
      const { projectPath, projectRef } = ctx;
      const projectPathObj = new Path(projectPath);
      const workspacesDir = workspacesRoot.workspacesDir(projectPathObj);

      const key = projectKey(projectPathObj.toString());
      const project = { ref: projectRef, path: key };

      // Already open: report the list the app holds rather than re-read git.
      // project:open runs again for an open project (an automation naming it
      // by URL), and a fresh discover can skip a worktree the sidebar, agent
      // and views still hold, leaving a workspace nothing can resolve.
      const known = registry.workspacesOf(projectRef);
      if (known !== undefined) {
        const defaultBaseBranch = projectDefaults.get(key);
        return {
          workspaces: toDiscoveredWorkspaces(known),
          ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
        };
      }

      gitWorktreeProvider.registerProject(
        projectPathObj,
        workspacesDir,
        workspacesRoot.previousWorkspacesDirs()
      );

      const discovered = (await gitWorktreeProvider.discover(projectPathObj)).map(
        registeredWorkspace
      );
      registry.openProject(project);
      await Promise.all(discovered.map((ws) => registry.track(project, ws, locatorOf(ws.path))));

      // Fire-and-forget cleanup
      void gitWorktreeProvider.cleanupOrphanedWorkspaces(projectPathObj).catch((err: unknown) => {
        logger.warn("Workspace cleanup failed", { projectPath, error: getErrorMessage(err) });
      });

      const defaultBaseBranch = await gitWorktreeProvider.defaultBase(projectPathObj);
      if (defaultBaseBranch !== undefined) {
        projectDefaults.set(key, defaultBaseBranch);
      }

      return {
        workspaces: toDiscoveredWorkspaces(discovered),
        ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
      };
    },

    forget(projectPath) {
      const projectPathObj = new Path(projectPath);
      gitWorktreeProvider.unregisterProject(projectPathObj);
      projectDefaults.delete(projectKey(projectPathObj.toString()));
      lastChoices.delete(projectKey(projectPathObj.toString()));
    },

    async create(ctx, payload) {
      const { projectPath, projectRef, fresh } = ctx;
      const project = { ref: projectRef, path: projectKey(projectPath) };

      // Reopen: populate from the existing workspace's data, skip worktree creation
      const existing = payload.existingWorkspace;
      if (!fresh && existing !== undefined) {
        const workspacePath = existing.path;
        const metadata = existing.metadata;
        // Described afresh from its metadata and the branch git told core at
        // discovery: the base is the recorded one, never the payload's, and
        // one never recorded stays absent rather than invented.
        const description = describeWorktree(branchOf(existing.details), metadata);

        await registry.track(
          project,
          { name: existing.name, path: new Path(workspacePath), metadata, ...description },
          locatorOf(new Path(workspacePath))
        );

        return { workspacePath, metadata, ...description };
      }

      // New workspace: create via provider
      const projectPathObj = new Path(projectPath);

      // Resolve base: explicit or default
      const options = gitCreateOptions(payload.options);
      const base = options.base ?? (await gitWorktreeProvider.defaultBase(projectPathObj));
      if (!base) {
        throw new WorkspaceError(
          "No base branch specified and no default branch could be detected"
        );
      }

      let internalWorkspace;
      try {
        internalWorkspace = await gitWorktreeProvider.createWorkspace(
          projectPathObj,
          payload.workspaceName!,
          base,
          options.tracking
        );
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        throw new WorkspaceError(`${message} (base: '${base}')`);
      }

      // The registry writes its metadata file: the base, and the name.
      const created = registeredWorkspace(internalWorkspace);
      await registry.trackCreated(project, created, locatorOf(created.path));

      return {
        workspacePath: workspaceKey(created.path.toString()),
        metadata: created.metadata,
        ...descriptionOf(created),
      };
    },

    async listChoices(projectPath, fresh) {
      const projectPathObj = new Path(projectPath);
      const key = projectKey(projectPathObj.toString());
      const cached = fresh ? undefined : lastChoices.get(key);
      if (cached !== undefined) return cached;

      // Enumerate once and reuse for the default (avoids a second full
      // branch enumeration inside defaultBase).
      const bases = await gitWorktreeProvider.listBases(projectPathObj, recordedBase);
      const defaultBaseBranch = await gitWorktreeProvider.defaultBase(projectPathObj, bases);
      if (defaultBaseBranch !== undefined) projectDefaults.set(key, defaultBaseBranch);

      const choices = branchChoices(bases, defaultBaseBranch);
      lastChoices.set(key, choices);
      return choices;
    },

    async refreshBases(projectPath) {
      await gitWorktreeProvider.updateBases(new Path(projectPath));
    },

    async preflight(ctx, payload) {
      const { projectPath, workspacePath: wsPath } = ctx;

      // Only a worktree removal can lose work; force is an explicit
      // teardown and ignoreWarnings the caller's opt-out. A failing read
      // throws: the gate fails closed rather than reporting "nothing to
      // object to" for a workspace it could not inspect.
      if (!payload.removeWorktree || payload.force || payload.ignoreWarnings) {
        return {};
      }

      const reasons: string[] = [];
      if (await gitWorktreeProvider.isDirty(new Path(wsPath))) {
        reasons.push("Workspace has uncommitted changes");
      }

      // Unmerged commits only go missing when the branch goes with the
      // worktree — a kept branch keeps them reachable. Skipping the check
      // also skips the fetch, which is the expensive part of this gate.
      if (!gitDeleteOptions(payload.options).keepBranch) {
        // Fetch first so the count is measured against current refs;
        // without it a delete right after a server-side merge (e.g.
        // /ship) compares against a stale origin/main and rejects the
        // just-merged commits as unmerged. Best-effort — a fetch failure
        // falls through to the stale-ref read rather than blocking.
        try {
          await gitWorktreeProvider.updateBases(new Path(projectPath));
        } catch {
          // Stale refs beat no answer.
        }

        const unmerged = await gitWorktreeProvider.countUnmergedCommits(
          new Path(wsPath),
          recordedBase(new Path(wsPath))
        );
        if (unmerged > 0) {
          reasons.push(`Workspace has ${unmerged} unmerged commit${unmerged === 1 ? "" : "s"}`);
        }
      }

      if (reasons.length === 0) return {};
      return { blocked: true, reason: reasons.join("; ") };
    },

    async remove(ctx, payload) {
      const { projectPath, workspacePath: wsPath } = ctx;

      if (!payload.removeWorktree) {
        // Runtime teardown only: the worktree stays, the registry lets go of it.
        registry.untrack(new Path(wsPath), "closed");
        return {};
      }

      try {
        await gitWorktreeProvider.removeWorkspace(
          new Path(projectPath),
          new Path(wsPath),
          !gitDeleteOptions(payload.options).keepBranch
        );
      } catch (error) {
        if (payload.force) {
          logger.warn("WorktreeModule: error in force mode (ignored)", {
            error: getErrorMessage(error),
          });
          // Dismissed: the workspace goes, whatever is left on disk
          registry.untrack(new Path(wsPath), "deleted");
        }
        // Non-force: the workspace stays registered, so the user can retry
        return { error: getErrorMessage(error) };
      }

      registry.untrack(new Path(wsPath), "deleted");
      return {};
    },

    async status(ctx) {
      const { workspacePath: wsPath, closing: closingReason } = ctx;

      // Both reads below spawn a git subprocess with the workspace as its
      // CWD. On Windows that alone is enough to make `git worktree remove`
      // fail with "Permission denied" on the directory, so never run them
      // against a workspace a teardown pipeline owns. The operation
      // re-reads `closing` immediately before this hook point, so it is
      // fresh even when a slow refresh preceded us.
      if (closingReason !== null) {
        // Same answer isDirty already gives for a torn-down worktree
        // (see GitWorktreeProvider.isDirty) — a workspace on its way out
        // has no uncommitted work to report.
        logger
          .scoped({ path: wsPath })
          .debug("Skipping git status for closing workspace", { reason: closingReason });
        return describeWorkStatus(false, 0, undefined);
      }

      const base = recordedBase(new Path(wsPath));
      const isDirty = await gitWorktreeProvider.isDirty(new Path(wsPath));
      const unmergedCommits = await gitWorktreeProvider.countUnmergedCommits(
        new Path(wsPath),
        base
      );
      return describeWorkStatus(isDirty, unmergedCommits, base);
    },

    defaultBases() {
      const entries: ListWorkspacesHookEntry[] = [];
      for (const [projectPath, defaultBaseBranch] of projectDefaults) {
        entries.push({ projectPath, workspaces: [], defaultBaseBranch });
      }
      return { entries };
    },
  };
}
