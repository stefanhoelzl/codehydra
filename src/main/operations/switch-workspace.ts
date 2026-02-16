/**
 * SwitchWorkspaceOperation - Orchestrates workspace switching.
 *
 * Two modes:
 *
 * **Specific target** (projectId + workspaceName):
 * 1. "resolve-project": resolve projectId → projectPath + projectName
 * 2. "resolve-workspace": resolve workspaceName → workspacePath
 * 3. "activate": call viewManager.setActiveWorkspace()
 *
 * **Auto-select** ({ auto: true, currentPath }):
 * Used when the active workspace is being deleted. Runs a "find-candidates"
 * hook to gather all available workspaces, applies a selection algorithm
 * (preferring idle workspaces closest to the deleted one), then dispatches
 * a specific-target switch. If no candidate found, emits workspace:switched(null).
 *
 * On success, emits a workspace:switched domain event.
 *
 * No provider dependencies - the hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";
import type { WorkspacePath } from "../../shared/ipc";

// =============================================================================
// Intent Types
// =============================================================================

/** Specific-target payload: switch to a known workspace. */
export interface SwitchWorkspaceTargetPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly focus?: boolean;
}

/** Auto-select payload: find the best workspace after deletion. */
export interface SwitchWorkspaceAutoPayload {
  readonly auto: true;
  readonly currentPath: string;
  readonly focus?: boolean;
}

export type SwitchWorkspacePayload = SwitchWorkspaceTargetPayload | SwitchWorkspaceAutoPayload;

/** Type guard for auto-select mode. */
export function isAutoSwitch(
  payload: SwitchWorkspacePayload
): payload is SwitchWorkspaceAutoPayload {
  return "auto" in payload && payload.auto === true;
}

export interface SwitchWorkspaceIntent extends Intent<void> {
  readonly type: "workspace:switch";
  readonly payload: SwitchWorkspacePayload;
}

export const INTENT_SWITCH_WORKSPACE = "workspace:switch" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface WorkspaceSwitchedPayload {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly projectPath: string;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}

export interface WorkspaceSwitchedEvent extends DomainEvent {
  readonly type: "workspace:switched";
  readonly payload: WorkspaceSwitchedPayload | null;
}

export const EVENT_WORKSPACE_SWITCHED = "workspace:switched" as const;

// =============================================================================
// Hook Result & Input Types
// =============================================================================

export const SWITCH_WORKSPACE_OPERATION_ID = "switch-workspace";

/** Per-handler result for the "resolve-project" hook point. */
export interface ResolveProjectHookResult {
  readonly projectPath?: string;
  readonly projectName?: string;
}

/** Input context for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookInput extends HookContext {
  readonly projectPath: string;
  readonly workspaceName: string;
}

/** Per-handler result for the "resolve-workspace" hook point. */
export interface ResolveWorkspaceHookResult {
  readonly workspacePath?: string;
}

/** Input context for the "activate" hook point. */
export interface ActivateHookInput extends HookContext {
  readonly workspacePath: string;
}

/**
 * Per-handler result contract for the "activate" hook point.
 * Each handler returns its contribution — the operation merges them.
 * Empty `{}` for no-op case (workspace already active).
 */
export interface SwitchWorkspaceHookResult {
  readonly resolvedPath?: string;
}

// =============================================================================
// Auto-Select Types
// =============================================================================

/** A workspace candidate returned by the "find-candidates" hook. */
export interface WorkspaceCandidate {
  readonly projectPath: string;
  readonly projectName: string;
  readonly workspacePath: string;
}

/** Per-handler result for the "find-candidates" hook point. */
export interface FindCandidatesHookResult {
  readonly candidates?: readonly WorkspaceCandidate[];
}

/**
 * Agent status scorer function. Given a workspace path, returns a numeric score:
 * 0 = idle (preferred), 1 = busy, 2 = none/unknown.
 */
export type AgentStatusScorer = (workspacePath: WorkspacePath) => number;

// =============================================================================
// Selection Algorithm
// =============================================================================

/**
 * Prioritized workspace selection algorithm.
 * Returns the best workspace to switch to when the active workspace is being deleted,
 * or null if no other workspace is available.
 *
 * Scoring: combines agent status priority (idle > busy > none) with positional
 * proximity to the deleted workspace in alphabetical order.
 */
export function selectNextWorkspace(
  currentWorkspacePath: string,
  candidates: readonly WorkspaceCandidate[],
  extractName: (path: string) => string,
  scorer?: AgentStatusScorer
): WorkspaceCandidate | null {
  if (candidates.length === 0) return null;

  // Build sorted list (projects alphabetically, workspaces alphabetically)
  const byProject = new Map<string, WorkspaceCandidate[]>();
  for (const c of candidates) {
    const list = byProject.get(c.projectPath) ?? [];
    list.push(c);
    byProject.set(c.projectPath, list);
  }

  const sortedProjectPaths = [...byProject.keys()].sort((a, b) => {
    const nameA = byProject.get(a)![0]!.projectName;
    const nameB = byProject.get(b)![0]!.projectName;
    return nameA.localeCompare(nameB, undefined, { caseFirst: "upper" });
  });

  const sorted: WorkspaceCandidate[] = [];
  for (const pp of sortedProjectPaths) {
    const list = byProject.get(pp)!;
    list.sort((a, b) => {
      const nameA = extractName(a.workspacePath);
      const nameB = extractName(b.workspacePath);
      return nameA.localeCompare(nameB, undefined, { caseFirst: "upper" });
    });
    sorted.push(...list);
  }

  // Find current workspace index
  const currentIndex = sorted.findIndex((w) => w.workspacePath === currentWorkspacePath);
  if (currentIndex === -1) return null;

  const getKey = (ws: WorkspaceCandidate, index: number): number => {
    let statusKey: number;
    if (scorer) {
      statusKey = scorer(ws.workspacePath as WorkspacePath);
    } else {
      statusKey = 2; // No scorer: treat all as "none"
    }
    const positionKey = (index - currentIndex + sorted.length) % sorted.length;
    return statusKey * sorted.length + positionKey;
  };

  // Find best candidate (excluding current)
  let best: WorkspaceCandidate | undefined;
  let bestKey = Infinity;

  for (let i = 0; i < sorted.length; i++) {
    if (i === currentIndex) continue;
    const key = getKey(sorted[i]!, i);
    if (key < bestKey) {
      bestKey = key;
      best = sorted[i];
    }
  }

  return best ?? null;
}

// =============================================================================
// Operation
// =============================================================================

export class SwitchWorkspaceOperation implements Operation<SwitchWorkspaceIntent, void> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;

  constructor(
    private readonly extractName: (path: string) => string,
    private readonly generateId: (path: string) => ProjectId,
    private readonly scorer?: AgentStatusScorer
  ) {}

  async execute(ctx: OperationContext<SwitchWorkspaceIntent>): Promise<void> {
    const { payload } = ctx.intent;

    if (isAutoSwitch(payload)) {
      return this.executeAutoSelect(ctx, payload);
    }

    return this.executeSpecificTarget(ctx, payload);
  }

  private async executeSpecificTarget(
    ctx: OperationContext<SwitchWorkspaceIntent>,
    payload: SwitchWorkspaceTargetPayload
  ): Promise<void> {
    // 1. Resolve project: projectId → projectPath + projectName
    const resolveProjectCtx: HookContext = { intent: ctx.intent };
    const { results: resolveProjectResults, errors: resolveProjectErrors } =
      await ctx.hooks.collect<ResolveProjectHookResult>("resolve-project", resolveProjectCtx);
    if (resolveProjectErrors.length === 1) {
      throw resolveProjectErrors[0]!;
    }
    if (resolveProjectErrors.length > 1) {
      throw new AggregateError(
        resolveProjectErrors,
        "workspace:switch resolve-project hooks failed"
      );
    }
    let projectPath: string | undefined;
    let projectName: string | undefined;
    for (const r of resolveProjectResults) {
      if (r.projectPath !== undefined) projectPath = r.projectPath;
      if (r.projectName !== undefined) projectName = r.projectName;
    }
    if (!projectPath) {
      throw new Error(`Project not found: ${payload.projectId}`);
    }

    // 2. Resolve workspace: workspaceName → workspacePath
    const resolveWorkspaceCtx: ResolveWorkspaceHookInput = {
      intent: ctx.intent,
      projectPath,
      workspaceName: payload.workspaceName,
    };
    const { results: resolveWorkspaceResults, errors: resolveWorkspaceErrors } =
      await ctx.hooks.collect<ResolveWorkspaceHookResult>("resolve-workspace", resolveWorkspaceCtx);
    if (resolveWorkspaceErrors.length === 1) {
      throw resolveWorkspaceErrors[0]!;
    }
    if (resolveWorkspaceErrors.length > 1) {
      throw new AggregateError(
        resolveWorkspaceErrors,
        "workspace:switch resolve-workspace hooks failed"
      );
    }
    let workspacePath: string | undefined;
    for (const r of resolveWorkspaceResults) {
      if (r.workspacePath !== undefined) workspacePath = r.workspacePath;
    }
    if (!workspacePath) {
      throw new Error(`Workspace not found: ${payload.workspaceName}`);
    }

    // 3. Activate: call setActiveWorkspace
    const activateCtx: ActivateHookInput = {
      intent: ctx.intent,
      workspacePath,
    };
    const { results: activateResults, errors: activateErrors } =
      await ctx.hooks.collect<SwitchWorkspaceHookResult>("activate", activateCtx);
    if (activateErrors.length === 1) {
      throw activateErrors[0]!;
    }
    if (activateErrors.length > 1) {
      throw new AggregateError(activateErrors, "workspace:switch activate hooks failed");
    }

    // Merge results — last-write-wins for resolvedPath
    let resolvedPath: string | undefined;
    for (const result of activateResults) {
      if (result.resolvedPath !== undefined) resolvedPath = result.resolvedPath;
    }

    // No-op: hook resolved workspace but it was already active
    // (resolvedPath left unset intentionally)
    if (!resolvedPath) {
      return;
    }

    // Emit domain event for subscribers (e.g., IpcEventBridge, SwitchTitleModule)
    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: {
        projectId: payload.projectId,
        projectName: projectName ?? "",
        projectPath,
        workspaceName: payload.workspaceName,
        path: resolvedPath,
      },
    };
    ctx.emit(event);
  }

  private async executeAutoSelect(
    ctx: OperationContext<SwitchWorkspaceIntent>,
    payload: SwitchWorkspaceAutoPayload
  ): Promise<void> {
    // 1. Find candidates via hook
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results } = await ctx.hooks.collect<FindCandidatesHookResult>(
      "find-candidates",
      hookCtx
    );
    const allCandidates: WorkspaceCandidate[] = [];
    for (const r of results) {
      if (r.candidates) allCandidates.push(...r.candidates);
    }

    // 2. Select best candidate
    const best = selectNextWorkspace(
      payload.currentPath,
      allCandidates,
      this.extractName,
      this.scorer
    );

    if (best) {
      // 3. Dispatch specific-target switch
      const switchIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          projectId: this.generateId(best.projectPath),
          workspaceName: this.extractName(best.workspacePath) as WorkspaceName,
          ...(payload.focus !== undefined && { focus: payload.focus }),
        },
      };
      await ctx.dispatch(switchIntent);
    } else {
      // No candidate: emit workspace:switched(null)
      const nullEvent: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: null,
      };
      ctx.emit(nullEvent);
    }
  }
}
