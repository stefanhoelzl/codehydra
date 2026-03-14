/**
 * OpenWorkspaceOperation - Orchestrates workspace opening.
 *
 * Uses isolated hook contexts with collect() — each hook point returns typed
 * results that are merged field-by-field with conflict detection.
 *
 * Steps:
 * 1. Dispatch project:resolve to get projectId from projectPath
 * 2. "create" → CreateHookResult — worktree creation (fatal)
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
import type { AgentType } from "../../shared/plugin-protocol";
import { normalizeInitialPrompt } from "../../shared/api/types";
import { extractWorkspaceName } from "../../shared/api/id-utils";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { INTENT_GET_ACTIVE_WORKSPACE, type GetActiveWorkspaceIntent } from "./get-active-workspace";

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
  readonly workspaceName: string;
  readonly base?: string;
  readonly initialPrompt?: InitialPrompt;
  /** If true, switch to the new workspace. If false, don't steal focus but still switch when
   *  no workspace is active. Default behavior (undefined): switch. */
  readonly stealFocus?: boolean;
  /** When set, skip worktree creation and populate context from existing workspace data. */
  readonly existingWorkspace?: ExistingWorkspaceData;
  /** Authoritative project path. */
  readonly projectPath: string;
}

export type OpenWorkspaceResult = Workspace;

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
  readonly base?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly workspaceUrl: string;
  readonly initialPrompt?: NormalizedInitialPrompt;
  readonly stealFocus?: boolean;
  /** True when re-activating a discovered workspace (not a fresh creation). */
  readonly reopened?: boolean;
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

/** Input context for the "create" hook point (enriched with resolved project path). */
export interface CreateHookInput extends HookContext {
  readonly projectPath: string;
}

/** Result from the "create" hook point. Fields are optional — multiple handlers may each contribute a subset. */
export interface CreateHookResult {
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** The resolved base branch (explicit or auto-detected). Used in the event payload. */
  readonly resolvedBase?: string;
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
  readonly agentType: AgentType | null;
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
    const { projectPath } = ctx.intent.payload;

    // Dispatch project:resolve to get projectId from projectPath
    const projResolved = await ctx.dispatch({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    } as ResolveProjectIntent);
    const resolvedProjectId = projResolved.projectId;

    // Hook: "create" — worktree creation (fatal on error)
    const createCtx: CreateHookInput = { intent: ctx.intent, projectPath };
    const { results: createResults, errors: createErrors } =
      await ctx.hooks.collect<CreateHookResult>("create", createCtx);

    if (createErrors.length > 0) throw createErrors[0]!;

    const create = mergeHookResults(createResults, "create");
    const { workspacePath, branch, metadata, resolvedBase } = create;
    if (workspacePath === undefined || branch === undefined || metadata === undefined) {
      throw new Error("Create hook did not provide all required fields");
    }

    // Hook 3b: "setup" — keepfiles is best-effort (internal try/catch), agent is fatal
    const setupCtx: SetupHookInput = {
      intent: ctx.intent,
      workspacePath,
      projectPath,
    };
    const setupResult = await ctx.hooks.collect<SetupHookResult>("setup", setupCtx);

    if (setupResult.errors.length > 0) throw setupResult.errors[0]!;

    // Accumulate env vars from all setup hook results (multiple modules can contribute)
    const envVars: Record<string, string> = {};
    for (const result of setupResult.results) {
      if (result.envVars) {
        Object.assign(envVars, result.envVars);
      }
    }

    // Read agentType from capabilities (provided by active agent module)
    const agentType = (setupResult.capabilities.agentType as AgentType) ?? null;

    // Hook 3c: "finalize" — workspace URL (fatal on error)
    const finalizeCtx: FinalizeHookInput = {
      intent: ctx.intent,
      workspacePath,
      envVars,
      agentType,
    };
    const { errors: finalizeErrors, capabilities: finalizeCaps } = await ctx.hooks.collect<void>(
      "finalize",
      finalizeCtx
    );

    if (finalizeErrors.length > 0) throw finalizeErrors[0]!;

    const workspaceUrl = finalizeCaps.workspaceUrl as string | undefined;
    if (!workspaceUrl) {
      throw new Error("Finalize hook did not provide workspaceUrl");
    }

    // Build Workspace return value
    const resolvedWorkspaceName = extractWorkspaceName(workspacePath);
    const projectId = resolvedProjectId;

    const workspace: Workspace = {
      projectId,
      name: resolvedWorkspaceName,
      branch,
      metadata,
      path: workspacePath,
    };

    // Build and emit domain event
    const eventBase = resolvedBase ?? ctx.intent.payload.base;
    const eventPayload: WorkspaceCreatedPayload = {
      projectId,
      workspaceName: resolvedWorkspaceName,
      workspacePath,
      projectPath,
      branch,
      ...(eventBase !== undefined && { base: eventBase }),
      metadata,
      workspaceUrl,
      ...(ctx.intent.payload.initialPrompt !== undefined && {
        initialPrompt: normalizeInitialPrompt(ctx.intent.payload.initialPrompt),
      }),
      ...(ctx.intent.payload.stealFocus !== undefined && {
        stealFocus: ctx.intent.payload.stealFocus,
      }),
      ...(ctx.intent.payload.existingWorkspace !== undefined && { reopened: true }),
    };

    const event: WorkspaceCreatedEvent = {
      type: EVENT_WORKSPACE_CREATED,
      payload: eventPayload,
    };
    ctx.emit(event);

    // Switch to new workspace unless stealFocus is false with an existing active workspace.
    // When stealFocus is false but no workspace is active, still switch so the user
    // sees the new workspace rather than an empty view.
    let shouldSwitch: boolean;
    if (ctx.intent.payload.stealFocus !== false) {
      shouldSwitch = true;
    } else {
      const activeWorkspace = await ctx.dispatch({
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {},
      } as GetActiveWorkspaceIntent);
      shouldSwitch = activeWorkspace === null;
    }

    if (shouldSwitch) {
      await ctx.dispatch({
        type: INTENT_SWITCH_WORKSPACE,
        payload: { workspacePath, focus: true },
      } as SwitchWorkspaceIntent);
    }

    return workspace;
  }
}
