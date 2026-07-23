/**
 * SwitchWorkspaceOperation - Orchestrates workspace switching.
 *
 * Two modes:
 *
 * **Specific target** (workspacePath):
 * 1. Dispatch workspace:resolve — resolve workspacePath → projectPath + workspaceName
 * 2. Dispatch project:resolve — resolve projectPath → projectId + projectName
 * 3. "activate" hook — call viewManager.setActiveWorkspace()
 *
 * `workspacePath: null` deselects: skips resolution, runs "activate" with a
 * null target (clears main-side bookkeeping), emits workspace:switched(null).
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

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import {
  hookCtxSchema,
  projectIdSchema,
  projectPathSchema,
  workspaceNameSchema,
  workspacePathSchema,
} from "./contract";
import type { WorkspacePath } from "./contract";
import { INTENT_RESOLVE_WORKSPACE, type ResolveWorkspaceIntent } from "./resolve-workspace";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { throwHookErrors, lastDefined } from "./lib/hook-helpers";

export const INTENT_SWITCH_WORKSPACE = "workspace:switch" as const;
export const EVENT_WORKSPACE_SWITCHED = "workspace:switched" as const;
export const SWITCH_WORKSPACE_OPERATION_ID = "switch-workspace";

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

/** Specific-target payload: switch to a known workspace, or deselect.
 *  `workspacePath: null` deselects the active workspace — no workspace is
 *  active afterwards and the creation panel becomes the main view (it is the
 *  ground state when nothing is selected). `focus` is ignored for null. */
export const switchWorkspaceTargetPayloadSchema = z
  .object({
    workspacePath: workspacePathSchema.nullable(),
    focus: z.boolean().optional(),
  })
  .readonly();

/** Auto-select payload: find the best workspace after deletion. */
export const switchWorkspaceAutoPayloadSchema = z
  .object({
    auto: z.literal(true),
    currentPath: workspacePathSchema,
    focus: z.boolean().optional(),
    /** When true, if no other candidate is selectable, switch to currentPath
     *  instead of emitting workspace:switched(null). Used by hibernate so the
     *  user lands on the hibernation overlay rather than the empty backdrop
     *  when the only workspace was just hibernated. */
    fallbackToCurrent: z.boolean().optional(),
  })
  .readonly();

export const switchWorkspacePayloadSchema = z.union([
  switchWorkspaceTargetPayloadSchema,
  switchWorkspaceAutoPayloadSchema,
]);

/** A workspace candidate returned by the "find-candidates" hook. */
export const workspaceCandidateSchema = z
  .object({
    projectPath: projectPathSchema,
    projectName: z.string(),
    workspacePath: workspacePathSchema,
    /** Stored workspace name (original case) — used for alphabetical ordering. */
    workspaceName: z.string(),
    /** True when the candidate is hibernated. Hibernated candidates are excluded
     *  from auto-switch — hibernation is always opt-in to wake. */
    hibernated: z.boolean().optional(),
  })
  .readonly();

export const workspaceSwitchedPayloadSchema = z
  .object({
    projectId: projectIdSchema,
    projectName: z.string(),
    projectPath: projectPathSchema,
    workspaceName: workspaceNameSchema,
    path: workspacePathSchema,
    /** The workspace's raw domain metadata, as resolved at switch time. It is
     *  the baseline consumers can't reconstruct from workspace:metadata-changed
     *  alone: metadata persists in git config across restarts, so a title set in
     *  an earlier run never re-emits as a change. Consumers interpret it (see
     *  `readTitle`/`extractTags`) and keep the meanings, never the raw map. */
    metadata: z.record(z.string(), z.string()).readonly(),
  })
  .readonly();

/**
 * Per-handler result contract for the "activate" hook point.
 * Each handler returns its contribution — the operation merges them.
 * Empty `{}` for no-op case (workspace already active).
 */
export const switchWorkspaceHookResultSchema = z
  .object({
    resolvedPath: workspacePathSchema.optional(),
  })
  .readonly();

/** Per-handler result for the "find-candidates" hook point. */
export const findCandidatesHookResultSchema = z
  .object({
    candidates: z.array(workspaceCandidateSchema).readonly().optional(),
  })
  .readonly();

/** Per-handler result for the "select-next" hook point. */
export const selectNextHookResultSchema = z
  .object({
    selected: workspaceCandidateSchema.optional(),
  })
  .readonly();

/** Operation-added enrichment for the "activate" hook point. `workspacePath: null`
 *  = deselect (clear the active workspace). */
const activateEnrichmentSchema = z.object({
  workspacePath: workspacePathSchema.nullable(),
  active: z.boolean(),
});

/** Runtime whole-context validation schema for the "activate" hook point. */
export const activateHookInputSchema = hookCtxSchema(
  switchWorkspacePayloadSchema,
  activateEnrichmentSchema.shape
);

/** Operation-added enrichment for the "select-next" hook point. */
const selectNextEnrichmentSchema = z.object({
  currentPath: workspacePathSchema,
  candidates: z.array(workspaceCandidateSchema).readonly(),
});

/** Runtime whole-context validation schema for the "select-next" hook point. */
export const selectNextHookInputSchema = hookCtxSchema(
  switchWorkspacePayloadSchema,
  selectNextEnrichmentSchema.shape
);

/** The find-candidates hook point receives the bare intent. */
const bareSwitchHookInputSchema = hookCtxSchema(switchWorkspacePayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_SWITCH_WORKSPACE,
  payload: switchWorkspacePayloadSchema,
  hooks: {
    activate: { input: activateHookInputSchema, result: switchWorkspaceHookResultSchema },
    "find-candidates": { input: bareSwitchHookInputSchema, result: findCandidatesHookResultSchema },
    "select-next": { input: selectNextHookInputSchema, result: selectNextHookResultSchema },
  },
  events: {
    [EVENT_WORKSPACE_SWITCHED]: workspaceSwitchedPayloadSchema.nullable(),
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type SwitchWorkspaceTargetPayload = z.infer<typeof switchWorkspaceTargetPayloadSchema>;
export type SwitchWorkspaceAutoPayload = z.infer<typeof switchWorkspaceAutoPayloadSchema>;
export type SwitchWorkspacePayload = z.infer<typeof switchWorkspacePayloadSchema>;
export type SwitchWorkspaceIntent = IntentOf<typeof schemas>;

export type WorkspaceSwitchedPayload = z.infer<typeof workspaceSwitchedPayloadSchema>;

export interface WorkspaceSwitchedEvent extends DomainEvent {
  readonly type: "workspace:switched";
  readonly payload: WorkspaceSwitchedPayload | null;
}

/** A workspace candidate returned by the "find-candidates" hook. */
export type WorkspaceCandidate = z.infer<typeof workspaceCandidateSchema>;

/** Per-handler result for the "activate" hook point. */
export type SwitchWorkspaceHookResult = z.infer<typeof switchWorkspaceHookResultSchema>;
/** Per-handler result for the "find-candidates" hook point. */
export type FindCandidatesHookResult = z.infer<typeof findCandidatesHookResultSchema>;
/** Per-handler result for the "select-next" hook point. */
export type SelectNextHookResult = z.infer<typeof selectNextHookResultSchema>;

/** Input context for the "activate" hook point. `workspacePath: null` =
 *  deselect (clear the active workspace). */
export type ActivateHookInput = HookContext & z.infer<typeof activateEnrichmentSchema>;

/** Input context for the "select-next" hook point. */
export type SelectNextHookInput = HookContext & z.infer<typeof selectNextEnrichmentSchema>;

/**
 * Agent status scorer function. Given a workspace path, returns a numeric score:
 * 0 = idle (preferred), 1 = busy, 2 = none/unknown.
 */
export type AgentStatusScorer = (workspacePath: WorkspacePath) => number;

/** Type guard for auto-select mode. */
function isAutoSwitch(payload: SwitchWorkspacePayload): payload is SwitchWorkspaceAutoPayload {
  return "auto" in payload && payload.auto === true;
}

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
  scorer: AgentStatusScorer
): WorkspaceCandidate | null {
  // Hibernated workspaces are never auto-selected — wake must be deliberate.
  candidates = candidates.filter((c) => !c.hibernated);
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
    list.sort((a, b) =>
      a.workspaceName.localeCompare(b.workspaceName, undefined, { caseFirst: "upper" })
    );
    sorted.push(...list);
  }

  // Find current workspace index (-1 when currentPath was already de-registered)
  const currentIndex = sorted.findIndex((w) => w.workspacePath === currentWorkspacePath);

  const getKey = (ws: WorkspaceCandidate, index: number): number => {
    const statusKey = scorer(ws.workspacePath as WorkspacePath);
    // When currentPath is not in candidates, use score-only (no positional proximity)
    if (currentIndex === -1) return statusKey;
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

export class SwitchWorkspaceOperation implements Operation<typeof schemas> {
  readonly id = SWITCH_WORKSPACE_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<SwitchWorkspaceIntent, typeof schemas>): Promise<void> {
    const { payload } = ctx.intent;

    if (isAutoSwitch(payload)) {
      return this.executeAutoSelect(ctx, payload);
    }

    return this.executeSpecificTarget(ctx, payload);
  }

  private async executeSpecificTarget(
    ctx: OperationContext<SwitchWorkspaceIntent, typeof schemas>,
    payload: SwitchWorkspaceTargetPayload
  ): Promise<void> {
    // Deselect: no workspace to resolve. Run the activate hooks with a null
    // target so main-side bookkeeping clears (otherwise switching back to the
    // deselected workspace would no-op as already-active), then announce.
    // Deliberately NOT no-op-guarded: switched(null) is emitted even when
    // nothing was active (deselect is idempotent; consumers tolerate it).
    if (payload.workspacePath === null) {
      const deselectCtx: ActivateHookInput = {
        intent: ctx.intent,
        workspacePath: null,
        active: false,
      };
      const { errors } = await ctx.hooks.collect("activate", deselectCtx);
      throwHookErrors(errors, "workspace:switch activate hooks failed");

      const nullEvent: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: null,
      };
      ctx.emit(nullEvent);
      return;
    }

    // 1. Dispatch shared workspace resolution
    const { projectPath, workspaceName, active, metadata } =
      await ctx.dispatch<ResolveWorkspaceIntent>({
        type: INTENT_RESOLVE_WORKSPACE,
        payload: { workspacePath: payload.workspacePath },
      });

    // 2. Dispatch shared project resolution
    const { projectId, projectName } = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectPath },
    });

    // 3. Activate: call setActiveWorkspace
    const activateCtx: ActivateHookInput = {
      intent: ctx.intent,
      workspacePath: payload.workspacePath,
      active,
    };
    const { results: activateResults, errors: activateErrors } = await ctx.hooks.collect(
      "activate",
      activateCtx
    );
    throwHookErrors(activateErrors, "workspace:switch activate hooks failed");

    // Merge results — last-write-wins for resolvedPath
    const resolvedPath = lastDefined(activateResults, (r) => r.resolvedPath);

    // No-op: hook resolved workspace but it was already active
    // (resolvedPath left unset intentionally)
    if (!resolvedPath) {
      return;
    }

    // Emit domain event for subscribers (e.g., UiIpcModule, SwitchTitleModule)
    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: {
        projectId,
        projectName,
        projectPath,
        workspaceName,
        path: resolvedPath,
        metadata,
      },
    };
    ctx.emit(event);
  }

  private async executeAutoSelect(
    ctx: OperationContext<SwitchWorkspaceIntent, typeof schemas>,
    payload: SwitchWorkspaceAutoPayload
  ): Promise<void> {
    // 1. Find candidates via hook
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results } = await ctx.hooks.collect("find-candidates", hookCtx);
    const allCandidates: WorkspaceCandidate[] = [];
    for (const r of results) {
      if (r.candidates) allCandidates.push(...r.candidates);
    }

    // 2. Select best candidate via hook
    const selectCtx: SelectNextHookInput = {
      intent: ctx.intent,
      currentPath: payload.currentPath,
      candidates: allCandidates,
    };
    const { results: selectResults } = await ctx.hooks.collect("select-next", selectCtx);
    let best: WorkspaceCandidate | undefined;
    for (const r of selectResults) {
      if (r.selected !== undefined) best = r.selected;
    }

    const targetPath =
      best?.workspacePath ?? (payload.fallbackToCurrent ? payload.currentPath : undefined);
    if (targetPath !== undefined) {
      const switchIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          workspacePath: targetPath,
          ...(payload.focus !== undefined && { focus: payload.focus }),
        },
      };
      await ctx.dispatch(switchIntent);
    } else {
      // No candidate and no fallback: emit workspace:switched(null)
      const nullEvent: WorkspaceSwitchedEvent = {
        type: EVENT_WORKSPACE_SWITCHED,
        payload: null,
      };
      ctx.emit(nullEvent);
    }
  }
}
