/**
 * CreateWorkspaceOperation - Orchestrates workspace creation.
 *
 * Uses isolated hook contexts with collect() — each hook point returns typed
 * results that are merged field-by-field with conflict detection.
 *
 * Hook points:
 * 1. "create" → CreateHookResult — worktree creation (fatal)
 * 2. "setup" → SetupHookResult — keepfiles (best-effort, internal try/catch),
 *    agent server (fatal)
 * 3. "finalize" → FinalizeHookResult — workspace URL (fatal)
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
import { extractWorkspaceName } from "../api/id-utils";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";

// =============================================================================
// Intent Types
// =============================================================================

/** Data for activating an existing (discovered) workspace via workspace:create */
export interface ExistingWorkspaceData {
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CreateWorkspacePayload {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly base: string;
  readonly initialPrompt?: InitialPrompt;
  readonly keepInBackground?: boolean;
  /** When set, skip worktree creation and populate context from existing workspace data. */
  readonly existingWorkspace?: ExistingWorkspaceData;
  /** Authoritative project path when existingWorkspace is set (avoids re-resolution from projectId). */
  readonly projectPath?: string;
}

export interface CreateWorkspaceIntent extends Intent<Workspace> {
  readonly type: "workspace:create";
  readonly payload: CreateWorkspacePayload;
}

export const INTENT_CREATE_WORKSPACE = "workspace:create" as const;

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

export const CREATE_WORKSPACE_OPERATION_ID = "create-workspace";

// =============================================================================
// Per-hook-point types
// =============================================================================

/** Result from the "create" hook point. Fields are optional — multiple handlers may each contribute a subset. */
export interface CreateHookResult {
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly projectPath?: string;
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

export class CreateWorkspaceOperation implements Operation<CreateWorkspaceIntent, Workspace> {
  readonly id = CREATE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<CreateWorkspaceIntent>): Promise<Workspace> {
    // Hook 1: "create" — worktree creation (fatal on error)
    const createCtx: HookContext = { intent: ctx.intent };
    const { results: createResults, errors: createErrors } =
      await ctx.hooks.collect<CreateHookResult>("create", createCtx);

    if (createErrors.length > 0) throw createErrors[0]!;

    const create = mergeHookResults(createResults, "create");
    const { workspacePath, branch, metadata, projectPath } = create;
    if (
      workspacePath === undefined ||
      branch === undefined ||
      metadata === undefined ||
      projectPath === undefined
    ) {
      throw new Error("Create hook did not provide all required fields");
    }

    // Hook 2: "setup" — keepfiles is best-effort (internal try/catch), agent is fatal
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

    const setup = mergeHookResults(setupResults, "setup");
    const envVars = setup.envVars ?? {};

    // Hook 3: "finalize" — workspace URL (fatal on error)
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
    const workspaceName = extractWorkspaceName(workspacePath);
    const workspace: Workspace = {
      projectId: ctx.intent.payload.projectId,
      name: workspaceName,
      branch,
      metadata,
      path: workspacePath,
    };

    // Build and emit domain event
    const eventPayload: WorkspaceCreatedPayload = {
      projectId: ctx.intent.payload.projectId,
      workspaceName,
      workspacePath,
      projectPath,
      branch,
      base: ctx.intent.payload.base,
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
          projectId: ctx.intent.payload.projectId,
          workspaceName,
          focus: true,
        },
      };
      await ctx.dispatch(switchIntent);
    }

    return workspace;
  }
}
