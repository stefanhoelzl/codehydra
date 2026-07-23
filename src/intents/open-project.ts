/**
 * OpenProjectOperation - Orchestrates project opening.
 *
 * Runs 3 sequential hook points using collect() for isolated contexts:
 * 1. "resolve": clone if URL, validate git → ResolveHookResult
 * 2. "register": generate ID, store state, persist → RegisterHookResult
 * 3. "discover": find existing workspaces → DiscoverHookResult
 *
 * The operation mediates data flow between hook points — only pure data
 * flows through contexts. Providers are module dependencies via closure.
 *
 * After hooks, dispatches workspace:open per discovered workspace (best-effort)
 * and emits project:opened. View activation is handled by the projectViewModule
 * event handler (registered in bootstrap).
 *
 * Contract schemas (item 2): zod is the single source of truth. The payload/result/hook/event
 * schemas are declared once and hung on the operation's `schemas` field; the `Intent` and
 * result types are **derived** from that bundle via `IntentOf`/`z.infer` — never restated.
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import type { ProjectId, Project } from "../shared/api/types";
import {
  projectSchema,
  projectIdSchema,
  projectPathSchema,
  discoveredWorkspaceSchema,
  hookCtxSchema,
} from "./contract";
import type { ProjectPath, DiscoveredWorkspace } from "./contract";
import {
  INTENT_OPEN_WORKSPACE,
  type OpenWorkspaceIntent,
  type ExistingWorkspaceData,
} from "./open-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { INTENT_GET_ACTIVE_WORKSPACE, type GetActiveWorkspaceIntent } from "./get-active-workspace";
import { HIBERNATED_METADATA_KEY } from "./hibernate-workspace";
import { toIpcWorkspaces } from "../utils/workspace-conversion";
import { Path } from "../utils/path/path";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_OPEN_PROJECT = "project:open" as const;
export const OPEN_PROJECT_OPERATION_ID = "open-project";

export const EVENT_PROJECT_OPENED = "project:opened" as const;
export const EVENT_PROJECT_OPEN_FAILED = "project:open-failed" as const;
export const EVENT_CLONE_PROGRESS = "clone:progress" as const;

// =============================================================================
// Contract schemas (single source of truth)
// =============================================================================

export const openProjectPayloadSchema = z
  .object({
    /** Absolute local filesystem path. Set by projects.open. */
    path: projectPathSchema.optional(),
    /** Git URL or shorthand (e.g. "org/repo"). Set by the creation module's clone sub-dialog. */
    git: z.string().optional(),
  })
  .readonly();

/** `null` result = user canceled the folder dialog (select-folder returned no path). */
export const openProjectResultSchema = projectSchema.nullable();

// -----------------------------------------------------------------------------
// Hook result schemas
// -----------------------------------------------------------------------------

/** Result returned by handlers on the "select-folder" hook point. */
export const selectFolderHookResultSchema = z
  .object({
    folderPath: projectPathSchema.nullable(),
  })
  .readonly();

/** Result returned by handlers on the "prepare" hook point. */
export const prepareHookResultSchema = z
  .object({
    /** If true, user canceled — abort the open operation. */
    canceled: z.boolean().optional(),
  })
  .readonly();

/** Result returned by handlers on the "resolve" hook point. */
export const resolveHookResultSchema = z
  .object({
    /** Optional when using collect() — handler may skip via self-selection. */
    projectPath: projectPathSchema.optional(),
    remoteUrl: z.string().optional(),
    /** If true, the project is already open — skip workspace:open and event emission. */
    alreadyOpen: z.boolean().optional(),
  })
  .readonly();

/** Result returned by handlers on the "discover" hook point. */
export const discoverHookResultSchema = z
  .object({
    workspaces: z.array(discoveredWorkspaceSchema).readonly(),
    defaultBaseBranch: z.string().optional(),
  })
  .readonly();

/** Result returned by handlers on the "register" hook point. */
export const registerHookResultSchema = z
  .object({
    /** Optional when using collect() — handler may skip via self-selection. */
    projectId: projectIdSchema.optional(),
    name: z.string().optional(),
    /** If true, the project is already open — skip workspace:open and event emission. */
    alreadyOpen: z.boolean().optional(),
  })
  .readonly();

// -----------------------------------------------------------------------------
// Hook input enrichment + whole-context schemas
// -----------------------------------------------------------------------------

/** Operation-added enrichment for the "discover" hook point. */
const discoverEnrichmentSchema = z.object({ projectPath: projectPathSchema });

/** Runtime whole-context validation schema for "discover". */
export const discoverHookInputSchema = hookCtxSchema(
  openProjectPayloadSchema,
  discoverEnrichmentSchema.shape
);

/** Operation-added enrichment for the "register" hook point. */
const registerEnrichmentSchema = z.object({
  projectPath: projectPathSchema,
  remoteUrl: z.string().optional(),
});

/** Runtime whole-context validation schema for "register". */
export const registerHookInputSchema = hookCtxSchema(
  openProjectPayloadSchema,
  registerEnrichmentSchema.shape
);

// -----------------------------------------------------------------------------
// Event payload schemas (events this file owns)
// -----------------------------------------------------------------------------

export const projectOpenedPayloadSchema = z
  .object({
    project: projectSchema,
    /** Original intent path, for idempotency reset. */
    path: projectPathSchema.optional(),
    /** Original intent git URL, for idempotency reset. */
    git: z.string().optional(),
  })
  .readonly();

export const projectOpenFailedPayloadSchema = z
  .object({
    /** Original intent path, for idempotency reset. */
    path: projectPathSchema.optional(),
    /** Original intent git URL, for idempotency reset. */
    git: z.string().optional(),
    /** Reason the open failed (error message or "already-open"). */
    reason: z.string(),
  })
  .readonly();

export const cloneProgressPayloadSchema = z
  .object({
    stage: z.string(),
    progress: z.number(),
    name: z.string(),
    url: z.string(),
  })
  .readonly();

/** These hook points receive the bare (possibly folder-resolved) intent. */
const bareOpenHookInputSchema = hookCtxSchema(openProjectPayloadSchema, {});

/**
 * This operation's contract bundle. Exported so consumers (and tests) can take a typed view
 * of its hook points and events via `ResolvedHooks<typeof schemas>` / `EventOf<typeof schemas>`.
 */
export const schemas = {
  type: INTENT_OPEN_PROJECT,
  payload: openProjectPayloadSchema,
  result: openProjectResultSchema,
  hooks: {
    "select-folder": { input: bareOpenHookInputSchema, result: selectFolderHookResultSchema },
    prepare: { input: bareOpenHookInputSchema, result: prepareHookResultSchema },
    resolve: { input: bareOpenHookInputSchema, result: resolveHookResultSchema },
    register: { input: registerHookInputSchema, result: registerHookResultSchema },
    discover: { input: discoverHookInputSchema, result: discoverHookResultSchema },
  },
  events: {
    [EVENT_PROJECT_OPENED]: projectOpenedPayloadSchema,
    [EVENT_PROJECT_OPEN_FAILED]: projectOpenFailedPayloadSchema,
    [EVENT_CLONE_PROGRESS]: cloneProgressPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type OpenProjectPayload = z.infer<typeof openProjectPayloadSchema>;
export type OpenProjectIntent = IntentOf<typeof schemas>;

export type SelectFolderHookResult = z.infer<typeof selectFolderHookResultSchema>;
export type PrepareHookResult = z.infer<typeof prepareHookResultSchema>;
export type ResolveHookResult = z.infer<typeof resolveHookResultSchema>;
export type DiscoverHookResult = z.infer<typeof discoverHookResultSchema>;
export type RegisterHookResult = z.infer<typeof registerHookResultSchema>;

/** Input context for the "discover" hook point. */
export type DiscoverHookInput = HookContext & z.infer<typeof discoverEnrichmentSchema>;

/** Input context for the "register" hook point. */
export type RegisterHookInput = HookContext & z.infer<typeof registerEnrichmentSchema>;

export type ProjectOpenedPayload = z.infer<typeof projectOpenedPayloadSchema>;
export type ProjectOpenFailedPayload = z.infer<typeof projectOpenFailedPayloadSchema>;
export type CloneProgressPayload = z.infer<typeof cloneProgressPayloadSchema>;

export interface ProjectOpenedEvent extends DomainEvent {
  readonly type: "project:opened";
  readonly payload: ProjectOpenedPayload;
}

export interface ProjectOpenFailedEvent extends DomainEvent {
  readonly type: typeof EVENT_PROJECT_OPEN_FAILED;
  readonly payload: ProjectOpenFailedPayload;
}

export interface CloneProgressEvent extends DomainEvent {
  readonly type: typeof EVENT_CLONE_PROGRESS;
  readonly payload: CloneProgressPayload;
}

// =============================================================================
// Clone progress streaming frame (yielded by the "resolve" hook; not schematized —
// yield frames are pure data forwarded to onYield, not validated at the boundary).
// =============================================================================

/**
 * Progress frame yielded by the "resolve" hook while cloning (data only, no closure).
 * The operation adds the `url` it knows and emits `clone:progress`.
 */
export interface CloneProgressFrame {
  readonly stage: string;
  readonly progress: number;
  readonly name: string;
}

/** Narrow an onYield frame to a CloneProgressFrame (plain-typed fields → cast-free). */
export function isCloneProgressFrame(frame: unknown): frame is CloneProgressFrame {
  return (
    typeof frame === "object" &&
    frame !== null &&
    "stage" in frame &&
    typeof frame.stage === "string" &&
    "progress" in frame &&
    typeof frame.progress === "number" &&
    "name" in frame &&
    typeof frame.name === "string"
  );
}

// =============================================================================
// Operation
// =============================================================================

export class OpenProjectOperation implements Operation<typeof schemas> {
  readonly id = OPEN_PROJECT_OPERATION_ID;
  readonly schemas = schemas;

  async execute(ctx: OperationContext<OpenProjectIntent, typeof schemas>): Promise<Project | null> {
    const { intent } = ctx;

    // Intent-origin fields for idempotency reset events
    const origin = {
      ...(intent.payload.path !== undefined && { path: intent.payload.path }),
      ...(intent.payload.git !== undefined && { git: intent.payload.git }),
    };

    // 0. Select folder: when no path or git URL provided, run "select-folder" hook
    let effectiveIntent = intent;
    if (!intent.payload.path && !intent.payload.git) {
      const selectCtx: HookContext = { intent };
      const { results: selectResults, errors: selectErrors } = await ctx.hooks.collect(
        "select-folder",
        selectCtx
      );
      throwHookErrors(selectErrors, "project:open select-folder hooks failed");
      let folderPath: ProjectPath | null = null;
      for (const r of selectResults) {
        if (r.folderPath) folderPath = r.folderPath;
      }
      if (!folderPath) {
        return null; // User canceled dialog
      }
      // Construct effective intent with the selected path
      effectiveIntent = {
        ...intent,
        payload: { ...intent.payload, path: folderPath },
      };
    }

    // 0.5. Prepare: give modules a chance to prepare the directory (e.g., git init)
    // Only runs for local paths, not git URLs
    if (effectiveIntent.payload.path && !effectiveIntent.payload.git) {
      const prepareCtx: HookContext = { intent: effectiveIntent };
      const { results: prepareResults, errors: prepareErrors } = await ctx.hooks.collect(
        "prepare",
        prepareCtx
      );
      throwHookErrors(prepareErrors, "project:open prepare hooks failed");
      for (const r of prepareResults) {
        if (r.canceled) return null;
      }
    }

    try {
      // The resolve hook streams clone progress by yielding CloneProgressFrame data;
      // the operation adds the url it knows and emits clone:progress (operation owns emits).
      const gitUrl = effectiveIntent.payload.git ?? "";
      const emitCloneProgress = (frame: unknown): void => {
        if (isCloneProgressFrame(frame)) {
          void ctx.emit({
            type: EVENT_CLONE_PROGRESS,
            payload: {
              stage: frame.stage,
              progress: frame.progress,
              name: frame.name,
              url: gitUrl,
            },
          } satisfies CloneProgressEvent);
        }
      };

      // 1. Resolve: clone if URL, validate git, return projectPath + remoteUrl
      const resolveCtx: HookContext = { intent: effectiveIntent };
      const { results: resolveResults, errors: resolveErrors } = await ctx.hooks.collect(
        "resolve",
        resolveCtx,
        {
          onYield: emitCloneProgress,
        }
      );
      throwHookErrors(resolveErrors, "project:open resolve hooks failed");
      let projectPath: ProjectPath | undefined;
      let resolvedRemoteUrl: string | undefined;
      let alreadyOpen = false;
      for (const r of resolveResults) {
        if (r.projectPath && !projectPath) projectPath = r.projectPath;
        if (r.remoteUrl !== undefined) resolvedRemoteUrl = r.remoteUrl;
        if (r.alreadyOpen) alreadyOpen = true;
      }
      if (!projectPath) {
        throw new Error("Resolve hook did not provide projectPath");
      }

      // 2. Register: generate ID, store state, persist
      const registerCtx: RegisterHookInput = {
        intent: effectiveIntent,
        projectPath,
        ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
      };
      const { results: registerResults, errors: registerErrors } = await ctx.hooks.collect(
        "register",
        registerCtx
      );
      throwHookErrors(registerErrors, "project:open register hooks failed");
      let projectId: ProjectId | undefined;
      let name: string | undefined;
      for (const r of registerResults) {
        if (r.projectId) projectId = r.projectId;
        if (r.name !== undefined) name = r.name;
        if (r.alreadyOpen) alreadyOpen = true;
      }
      if (!projectId) {
        throw new Error("Register hook did not provide projectId");
      }

      // 3. Discover: find existing workspaces
      const discoverCtx: DiscoverHookInput = { intent: effectiveIntent, projectPath };
      const { results: discoverResults, errors: discoverErrors } = await ctx.hooks.collect(
        "discover",
        discoverCtx
      );
      throwHookErrors(discoverErrors, "project:open discover hooks failed");
      const workspaces: DiscoveredWorkspace[] = [];
      let defaultBaseBranch: string | undefined;
      for (const r of discoverResults) {
        if (r.workspaces) workspaces.push(...r.workspaces);
        if (r.defaultBaseBranch !== undefined) defaultBaseBranch = r.defaultBaseBranch;
      }

      // Build Project return value
      let project: Project = {
        id: projectId,
        path: projectPath,
        name: name ?? new Path(projectPath).basename,
        workspaces: toIpcWorkspaces(workspaces, projectId),
        ...(defaultBaseBranch !== undefined && { defaultBaseBranch }),
        ...(resolvedRemoteUrl !== undefined && { remoteUrl: resolvedRemoteUrl }),
      };

      // When already open, register + discover ran (idempotent) but skip side effects
      if (!alreadyOpen) {
        // Dispatch workspace:open per discovered workspace (best-effort).
        // Hibernated workspaces stay inert at startup — no view + agent init runs;
        // they appear in the sidebar with the hibernation indicator.
        const urlByPath = new Map<string, string>();
        for (const workspace of workspaces) {
          if (workspace.metadata[HIBERNATED_METADATA_KEY] === "true") continue;
          try {
            const existingWorkspace: ExistingWorkspaceData = {
              path: workspace.path,
              name: workspace.name,
              branch: workspace.branch,
              metadata: workspace.metadata,
            };

            const openWsIntent: OpenWorkspaceIntent = {
              type: INTENT_OPEN_WORKSPACE,
              payload: {
                workspaceName: workspace.name,
                base: workspace.metadata.base ?? "",
                existingWorkspace,
                projectPath,
                stealFocus: false,
                source: "open-project",
              },
            };

            const opened = await ctx.dispatch(openWsIntent);
            if (opened?.url !== undefined) {
              urlByPath.set(opened.path, opened.url);
            }
          } catch {
            // Best-effort: individual workspace:open failures don't fail the project open
          }
        }

        // Carry each opened workspace's IDE server URL so the renderer can
        // mount iframes for workspaces it learns about via project:opened
        // (their earlier workspace:created events predate the project in the
        // renderer store). Hibernated workspaces stay URL-less.
        project = {
          ...project,
          workspaces: project.workspaces.map((w) => {
            const url = urlByPath.get(w.path);
            return url !== undefined ? { ...w, url } : w;
          }),
        };

        // Emit project:opened event
        const event: ProjectOpenedEvent = {
          type: EVENT_PROJECT_OPENED,
          payload: { project, ...origin },
        };
        ctx.emit(event);

        // Switch to the first workspace only if no workspace is currently active.
        // During startup, multiple projects open sequentially — only the first
        // should activate a workspace to avoid visual jumping.
        if (project.workspaces.length > 0) {
          const activeWorkspace = await ctx.dispatch<GetActiveWorkspaceIntent>({
            type: INTENT_GET_ACTIVE_WORKSPACE,
            payload: {},
          });

          if (activeWorkspace === null) {
            // Pick the first non-hibernated workspace; if all are hibernated,
            // leave no workspace active so the user lands on the empty backdrop.
            const firstAwake = project.workspaces.find(
              (w) => w.metadata[HIBERNATED_METADATA_KEY] !== "true"
            );
            if (firstAwake) {
              try {
                await ctx.dispatch<SwitchWorkspaceIntent>({
                  type: INTENT_SWITCH_WORKSPACE,
                  payload: { workspacePath: firstAwake.path },
                });
              } catch {
                // Best-effort: switch failure doesn't fail the project open
              }
            }
          }
        }
      } else {
        // Project already open — emit failed event so idempotency key is released
        ctx.emit({
          type: EVENT_PROJECT_OPEN_FAILED,
          payload: { ...origin, reason: "already-open" },
        } satisfies ProjectOpenFailedEvent);
      }

      return project;
    } catch (e) {
      // Emit failed event so idempotency key is released on error
      ctx.emit({
        type: EVENT_PROJECT_OPEN_FAILED,
        payload: {
          ...origin,
          reason: e instanceof Error ? e.message : String(e),
        },
      } satisfies ProjectOpenFailedEvent);
      throw e;
    }
  }
}
