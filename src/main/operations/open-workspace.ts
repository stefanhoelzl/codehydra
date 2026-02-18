/**
 * OpenWorkspaceOperation - Orchestrates workspace opening.
 *
 * Replaces CreateWorkspaceOperation with an expanded pipeline that includes
 * project resolution and a fetch-bases path for incomplete payloads.
 *
 * Uses isolated hook contexts with collect() — each hook point returns typed
 * results that are merged field-by-field with conflict detection.
 *
 * Hook points:
 * 1. "resolve-project" → ResolveProjectHookResult — resolves projectId to path (fatal)
 * 2. If incomplete (missing workspaceName or base):
 *    "fetch-bases" → FetchBasesHookResult — returns bases for dialog (fatal, early return)
 * 3. If complete:
 *    "create" → CreateHookResult — worktree creation (fatal)
 *    "setup" → SetupHookResult — keepfiles (best-effort, internal try/catch),
 *     agent server (fatal)
 *    "finalize" → FinalizeHookResult — workspace URL (fatal)
 *
 * On success, builds a Workspace return value and emits a
 * workspace:created domain event.
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type {
  ProjectId,
  WorkspaceName,
  Workspace,
  InitialPrompt,
  NormalizedInitialPrompt,
} from "../../shared/api/types";
import { normalizeInitialPrompt } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";

// =============================================================================
// Intent Types
// =============================================================================

/** Data for activating an existing (discovered) workspace via workspace:open */
export interface ExistingWorkspaceData {
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface OpenWorkspacePayload {
  readonly projectId?: ProjectId;
  readonly workspaceName?: string;
  readonly base?: string;
  readonly initialPrompt?: InitialPrompt;
  readonly keepInBackground?: boolean;
  /** When set, skip worktree creation and populate context from existing workspace data. */
  readonly existingWorkspace?: ExistingWorkspaceData;
  /** Authoritative project path when existingWorkspace is set (avoids re-resolution from projectId). */
  readonly projectPath?: string;
}

export type OpenWorkspaceResult =
  | Workspace
  | { bases: readonly { name: string; isRemote: boolean }[]; defaultBaseBranch?: string };

export interface OpenWorkspaceIntent extends Intent<OpenWorkspaceResult> {
  readonly type: "workspace:open";
  readonly payload: OpenWorkspacePayload;
}

export const INTENT_OPEN_WORKSPACE = "workspace:open" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceCreatedPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly projectPath: string;
  readonly branch: string;
  readonly base: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly workspaceUrl: string;
  readonly initialPrompt?: NormalizedInitialPrompt;
  readonly keepInBackground?: boolean;
}

export interface WorkspaceCreatedEvent extends DomainEvent {
  readonly type: "workspace:created";
  readonly payload: WorkspaceCreatedPayload;
}

export const EVENT_WORKSPACE_CREATED = "workspace:created" as const;

// =============================================================================
// Operation
// =============================================================================

export const OPEN_WORKSPACE_OPERATION_ID = "open-workspace";

// =============================================================================
// Per-hook-point types
// =============================================================================

/** Result from the "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
}

/** Input context for the "fetch-bases" hook point (enriched with resolved project path). */
export interface FetchBasesHookInput extends HookContext {
  readonly projectPath: string;
}

/** Input context for the "create" hook point (enriched with resolved project path). */
export interface CreateHookInput extends HookContext {
  readonly projectPath: string;
}

/** Result from the "create" hook point. Fields are optional — multiple handlers may each contribute a subset. */
export interface CreateHookResult {
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Input context for the "setup" hook point (enriched with merged create results). */
export interface SetupHookInput extends HookContext {
  readonly workspacePath: string;
  readonly projectPath: string;
}

/** Result from the "setup" hook point. */
export interface SetupHookResult {
  readonly envVars?: Record<string, string>;
}

/** Input context for the "finalize" hook point (enriched with create+setup results). */
export interface FinalizeHookInput extends HookContext {
  readonly workspacePath: string;
  readonly envVars: Record<string, string>;
}

/** Result from the "finalize" hook point. */
export interface FinalizeHookResult {
  readonly workspaceUrl?: string;
}

/** Merge hook results field-by-field. Throws if two handlers contribute the same field. */
function mergeHookResults<T extends object>(results: readonly T[], hookPoint: string): Partial<T> {
  const merged: Record<string, unknown> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined) {
        if (key in merged) {
          throw new Error(`${hookPoint} hook conflict: "${key}" provided by multiple handlers`);
        }
        merged[key] = value;
      }
    }
  }
  return merged as Partial<T>;
}

export class OpenWorkspaceOperation implements Operation<OpenWorkspaceIntent, OpenWorkspaceResult> {
  readonly id = OPEN_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<OpenWorkspaceIntent>): Promise<OpenWorkspaceResult> {
    // Hook 1: "resolve-project" — resolve projectId to projectPath (fatal on error)
    const resolveCtx: HookContext = { intent: ctx.intent };
    const { results: resolveResults, errors: resolveErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveCtx);

    if (resolveErrors.length > 0) throw resolveErrors[0]!;

    const resolve = mergeHookResults(resolveResults, "resolve-project");
    const { projectPath } = resolve;
    if (projectPath === undefined) {
      throw new Error("resolve-project hook did not provide projectPath");
    }

    // Check if payload is incomplete (missing workspaceName or base)
    const { workspaceName, base } = ctx.intent.payload;
    if (workspaceName === undefined || base === undefined) {
      // Hook 2: "fetch-bases" — return bases for dialog (fatal, early return)
      const fetchBasesCtx: FetchBasesHookInput = {
        intent: ctx.intent,
        projectPath,
      };
      const { results: fetchBasesResults, errors: fetchBasesErrors } = await ctx.hooks.collect<{
        bases?: readonly { name: string; isRemote: boolean }[];
        defaultBaseBranch?: string;
      }>("fetch-bases", fetchBasesCtx);

      if (fetchBasesErrors.length > 0) throw fetchBasesErrors[0]!;

      const fetchBases = mergeHookResults(fetchBasesResults, "fetch-bases");
      return {
        bases: fetchBases.bases ?? [],
        ...(fetchBases.defaultBaseBranch !== undefined && {
          defaultBaseBranch: fetchBases.defaultBaseBranch,
        }),
      };
    }

    // Hook 3a: "create" — worktree creation (fatal on error)
    const createCtx: CreateHookInput = { intent: ctx.intent, projectPath };
    const { results: createResults, errors: createErrors } =
      await ctx.hooks.collect<CreateHookResult>("create", createCtx);

    if (createErrors.length > 0) throw createErrors[0]!;

    const create = mergeHookResults(createResults, "create");
    const { workspacePath, branch, metadata } = create;
    if (workspacePath === undefined || branch === undefined || metadata === undefined) {
      throw new Error("Create hook did not provide all required fields");
    }

    // Hook 3b: "setup" — keepfiles is best-effort (internal try/catch), agent is fatal
    const setupCtx: SetupHookInput = {
      intent: ctx.intent,
      workspacePath,
      projectPath,
    };
    const { results: setupResults, errors: setupErrors } = await ctx.hooks.collect<SetupHookResult>(
      "setup",
      setupCtx
    );

    if (setupErrors.length > 0) throw setupErrors[0]!;

    // Accumulate env vars from all setup hook results (multiple modules can contribute)
    const envVars: Record<string, string> = {};
    for (const result of setupResults) {
      if (result.envVars) {
        Object.assign(envVars, result.envVars);
      }
    }

    // Hook 3c: "finalize" — workspace URL (fatal on error)
    const finalizeCtx: FinalizeHookInput = {
      intent: ctx.intent,
      workspacePath,
      envVars,
    };
    const { results: finalizeResults, errors: finalizeErrors } =
      await ctx.hooks.collect<FinalizeHookResult>("finalize", finalizeCtx);

    if (finalizeErrors.length > 0) throw finalizeErrors[0]!;

    const finalize = mergeHookResults(finalizeResults, "finalize");
    if (!finalize.workspaceUrl) {
      throw new Error("Finalize hook did not provide workspaceUrl");
    }

    // Build Workspace return value
    const resolvedWorkspaceName = extractWorkspaceName(workspacePath);
    const projectId = ctx.intent.payload.projectId;
    if (!projectId) {
      throw new Error("projectId is required for complete workspace creation");
    }

    const workspace: Workspace = {
      projectId,
      name: resolvedWorkspaceName,
      branch,
      metadata,
      path: workspacePath,
    };

    // Build and emit domain event
    const eventPayload: WorkspaceCreatedPayload = {
      projectId,
      workspaceName: resolvedWorkspaceName,
      workspacePath,
      projectPath,
      branch,
      base,
      metadata,
      workspaceUrl: finalize.workspaceUrl,
      ...(ctx.intent.payload.initialPrompt !== undefined && {
        initialPrompt: normalizeInitialPrompt(ctx.intent.payload.initialPrompt),
      }),
      ...(ctx.intent.payload.keepInBackground !== undefined && {
        keepInBackground: ctx.intent.payload.keepInBackground,
      }),
    };

    const event: WorkspaceCreatedEvent = {
      type: EVENT_WORKSPACE_CREATED,
      payload: eventPayload,
    };
    ctx.emit(event);

    // Dispatch workspace:switch if not keepInBackground
    if (!ctx.intent.payload.keepInBackground) {
      const switchIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          projectId,
          workspaceName: resolvedWorkspaceName,
          focus: true,
        },
      };
      await ctx.dispatch(switchIntent);
    }

    return workspace;
  }
}

// =============================================================================
// Backward-compat re-exports (from create-workspace.ts)
// =============================================================================

export { INTENT_OPEN_WORKSPACE as INTENT_CREATE_WORKSPACE };
export { OPEN_WORKSPACE_OPERATION_ID as CREATE_WORKSPACE_OPERATION_ID };
export type { OpenWorkspacePayload as CreateWorkspacePayload };
export type { OpenWorkspaceIntent as CreateWorkspaceIntent };
