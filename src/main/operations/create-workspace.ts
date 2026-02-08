/**
 * CreateWorkspaceOperation - Orchestrates workspace creation.
 *
 * Runs three hook points:
 * 1. "create" - Creates git worktree via WorktreeModule
 * 2. "setup" - Best-effort setup: KeepFilesModule (keepfiles copying), AgentModule (agent server)
 * 3. "finalize" - Creates .code-workspace file via CodeServerModule
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

// =============================================================================
// Intent Types
// =============================================================================

export interface CreateWorkspacePayload {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly base: string;
  readonly initialPrompt?: InitialPrompt;
  readonly keepInBackground?: boolean;
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

/**
 * Extended hook context for create-workspace.
 *
 * Fields are populated by hook modules across the three hook points:
 * - "create": workspacePath, branch, metadata, projectPath
 * - "setup": envVars (best-effort, may be undefined)
 * - "finalize": workspaceUrl
 */
export interface CreateWorkspaceHookContext extends HookContext {
  // Set by WorktreeModule (create hook)
  workspacePath?: string;
  branch?: string;
  metadata?: Readonly<Record<string, string>>;
  projectPath?: string;

  // Set by AgentModule (setup hook) -- may be undefined if agent fails
  envVars?: Record<string, string>;

  // Set by CodeServerModule (finalize hook)
  workspaceUrl?: string;
}

export class CreateWorkspaceOperation implements Operation<CreateWorkspaceIntent, Workspace> {
  readonly id = CREATE_WORKSPACE_OPERATION_ID;

  async execute(ctx: OperationContext<CreateWorkspaceIntent>): Promise<Workspace> {
    const hookCtx: CreateWorkspaceHookContext = {
      intent: ctx.intent,
    };

    // Hook 1: "create" -- WorktreeModule creates git worktree
    await ctx.hooks.run("create", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Validate required context from "create" hook
    if (!hookCtx.workspacePath) {
      throw new Error("Create hook did not provide workspacePath");
    }
    if (!hookCtx.branch) {
      throw new Error("Create hook did not provide branch");
    }
    if (!hookCtx.metadata) {
      throw new Error("Create hook did not provide metadata");
    }
    if (!hookCtx.projectPath) {
      throw new Error("Create hook did not provide projectPath");
    }

    // Hook 2: "setup" -- AgentModule (best-effort)
    // Reset error before setup since setup is best-effort
    delete hookCtx.error;
    await ctx.hooks.run("setup", hookCtx);
    // Do NOT check hookCtx.error -- setup is best-effort
    // Reset error so it doesn't affect finalize
    delete hookCtx.error;

    // Hook 3: "finalize" -- CodeServerModule creates .code-workspace file
    await ctx.hooks.run("finalize", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Validate required context from "finalize" hook
    if (!hookCtx.workspaceUrl) {
      throw new Error("Finalize hook did not provide workspaceUrl");
    }

    // Build Workspace return value
    const workspaceName = extractWorkspaceName(hookCtx.workspacePath);
    const workspace: Workspace = {
      projectId: ctx.intent.payload.projectId,
      name: workspaceName,
      branch: hookCtx.branch,
      metadata: hookCtx.metadata,
      path: hookCtx.workspacePath,
    };

    // Build and emit domain event
    const eventPayload: WorkspaceCreatedPayload = {
      projectId: ctx.intent.payload.projectId,
      workspaceName,
      workspacePath: hookCtx.workspacePath,
      projectPath: hookCtx.projectPath,
      branch: hookCtx.branch,
      base: ctx.intent.payload.base,
      metadata: hookCtx.metadata,
      workspaceUrl: hookCtx.workspaceUrl,
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

    return workspace;
  }
}
