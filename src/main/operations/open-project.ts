/**
 * OpenProjectOperation - Orchestrates project opening.
 *
 * Runs a single "open" hook point that populates the hook context:
 * 1. ProjectResolverModule: clone if URL, validate git, create provider
 * 2. ProjectDiscoveryModule: discover workspaces, orphan cleanup
 * 3. ProjectRegistryModule: generate ID, load config, store state, persist
 *
 * After the hook, dispatches workspace:create per discovered workspace (best-effort)
 * and emits project:opened. View activation is handled by the projectViewModule
 * event handler (registered in bootstrap).
 *
 * No provider dependencies - hook handlers do the actual work.
 */

import type { Intent, DomainEvent } from "../intents/infrastructure/types";
import type { Operation, OperationContext, HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, Project } from "../../shared/api/types";
import type { Workspace as InternalWorkspace } from "../../services/git/types";
import type { IWorkspaceProvider } from "../../services/git/workspace-provider";
import {
  INTENT_CREATE_WORKSPACE,
  type CreateWorkspaceIntent,
  type ExistingWorkspaceData,
} from "./create-workspace";
import { INTENT_SWITCH_WORKSPACE, type SwitchWorkspaceIntent } from "./switch-workspace";
import { toIpcWorkspaces } from "../api/workspace-conversion";
import { Path } from "../../services/platform/path";
import { extractWorkspaceName } from "../api/id-utils";

// =============================================================================
// Intent Types
// =============================================================================

export interface OpenProjectPayload {
  /** Absolute local filesystem path. Set by projects.open. */
  readonly path?: Path;
  /** Git URL or shorthand (e.g. "org/repo"). Set by projects.clone. */
  readonly git?: string;
}

export interface OpenProjectIntent extends Intent<Project> {
  readonly type: "project:open";
  readonly payload: OpenProjectPayload;
}

export const INTENT_OPEN_PROJECT = "project:open" as const;

// =============================================================================
// Event Types
// =============================================================================

export interface ProjectOpenedPayload {
  readonly project: Project;
}

export interface ProjectOpenedEvent extends DomainEvent {
  readonly type: "project:opened";
  readonly payload: ProjectOpenedPayload;
}

export const EVENT_PROJECT_OPENED = "project:opened" as const;

// =============================================================================
// Hook Context
// =============================================================================

export const OPEN_PROJECT_OPERATION_ID = "open-project";

/**
 * Extended hook context for open-project.
 *
 * Fields are populated by hook modules during the "open" hook point:
 * - ProjectResolverModule: projectPath, provider, remoteUrl
 * - ProjectDiscoveryModule: workspaces
 * - ProjectRegistryModule: projectId, defaultBaseBranch
 */
export interface OpenProjectHookContext extends HookContext {
  /** Resolved project path after clone/normalize */
  projectPath?: string;
  /** Created workspace provider */
  provider?: IWorkspaceProvider;
  /** Discovered workspaces */
  workspaces?: readonly InternalWorkspace[];
  /** Generated project ID */
  projectId?: ProjectId;
  /** Remote URL from clone or config */
  remoteUrl?: string;
  /** Default base branch */
  defaultBaseBranch?: string;
}

// =============================================================================
// Operation
// =============================================================================

export class OpenProjectOperation implements Operation<OpenProjectIntent, Project> {
  readonly id = OPEN_PROJECT_OPERATION_ID;

  async execute(ctx: OperationContext<OpenProjectIntent>): Promise<Project> {
    const hookCtx: OpenProjectHookContext = {
      intent: ctx.intent,
    };

    // Run "open" hook -- populates context
    await ctx.hooks.run("open", hookCtx);

    if (hookCtx.error) {
      throw hookCtx.error;
    }

    // Validate required fields from hook
    if (!hookCtx.projectPath) {
      throw new Error("Open hook did not provide projectPath");
    }
    if (!hookCtx.provider) {
      throw new Error("Open hook did not provide provider");
    }
    if (!hookCtx.projectId) {
      throw new Error("Open hook did not provide projectId");
    }

    const workspaces = hookCtx.workspaces ?? [];

    // Dispatch workspace:create per discovered workspace (best-effort)
    for (const workspace of workspaces) {
      try {
        const existingWorkspace: ExistingWorkspaceData = {
          path: workspace.path.toString(),
          name: workspace.name,
          branch: workspace.branch,
          metadata: workspace.metadata,
        };

        const createIntent: CreateWorkspaceIntent = {
          type: INTENT_CREATE_WORKSPACE,
          payload: {
            projectId: hookCtx.projectId,
            name: workspace.name,
            base: workspace.metadata.base ?? "",
            existingWorkspace,
            projectPath: hookCtx.projectPath,
            keepInBackground: true,
          },
        };

        await ctx.dispatch(createIntent);
      } catch {
        // Best-effort: individual workspace:create failures don't fail the project open
      }
    }

    // Build Project return value
    const project: Project = {
      id: hookCtx.projectId,
      path: hookCtx.projectPath,
      name: new Path(hookCtx.projectPath).basename,
      workspaces: toIpcWorkspaces(workspaces as InternalWorkspace[], hookCtx.projectId),
      ...(hookCtx.defaultBaseBranch !== undefined && {
        defaultBaseBranch: hookCtx.defaultBaseBranch,
      }),
      ...(hookCtx.remoteUrl !== undefined && { remoteUrl: hookCtx.remoteUrl }),
    };

    // Emit project:opened event
    const event: ProjectOpenedEvent = {
      type: EVENT_PROJECT_OPENED,
      payload: { project },
    };
    ctx.emit(event);

    // Dispatch workspace:switch for the first workspace
    if (project.workspaces.length > 0) {
      const firstWorkspace = project.workspaces[0]!;
      const switchIntent: SwitchWorkspaceIntent = {
        type: INTENT_SWITCH_WORKSPACE,
        payload: {
          projectId: hookCtx.projectId,
          workspaceName: extractWorkspaceName(firstWorkspace.path),
        },
      };
      try {
        await ctx.dispatch(switchIntent);
      } catch {
        // Best-effort: switch failure doesn't fail the project open
      }
    }

    return project;
  }
}
