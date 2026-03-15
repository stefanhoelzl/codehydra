/**
 * Shared test utilities for operation integration tests.
 *
 * Provides a configurable mock IntentModule that handles the common hooks
 * duplicated across operation tests: workspace resolution, project resolution,
 * active workspace queries, and workspace switching.
 *
 * Usage:
 * ```ts
 * const { dispatcher } = createTestSetup();
 * registerTestInfrastructure(dispatcher, {
 *   workspaces: { "/workspaces/feature-x": { projectPath: "/project", workspaceName: "feature-x" as WorkspaceName } },
 *   projects: { "/project": { projectId: "abc" as ProjectId } },
 * });
 * ```
 */

import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "../../shared/api/types";
import {
  ResolveWorkspaceOperation,
  RESOLVE_WORKSPACE_OPERATION_ID,
  INTENT_RESOLVE_WORKSPACE,
} from "./resolve-workspace";
import type { ResolveHookResult as ResolveWorkspaceHookResult } from "./resolve-workspace";
import {
  ResolveProjectOperation,
  RESOLVE_PROJECT_OPERATION_ID,
  INTENT_RESOLVE_PROJECT,
} from "./resolve-project";
import type {
  ResolveHookResult as ResolveProjectHookResult,
  ResolveHookInput as ResolveProjectHookInput,
} from "./resolve-project";
import {
  GetActiveWorkspaceOperation,
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  INTENT_GET_ACTIVE_WORKSPACE,
} from "./get-active-workspace";
import type { GetActiveWorkspaceHookResult } from "./get-active-workspace";
import {
  SwitchWorkspaceOperation,
  SWITCH_WORKSPACE_OPERATION_ID,
  INTENT_SWITCH_WORKSPACE,
} from "./switch-workspace";
import type {
  SwitchWorkspaceIntent,
  SwitchWorkspaceHookResult,
  ActivateHookInput,
} from "./switch-workspace";

// =============================================================================
// Configuration Types
// =============================================================================

export interface MockWorkspaceEntry {
  readonly projectPath: string;
  readonly workspaceName: WorkspaceName;
}

export interface MockProjectEntry {
  readonly projectId: ProjectId;
  readonly projectName?: string;
}

export interface MockViewManager {
  getActiveWorkspacePath(): string | null;
  setActiveWorkspace(path: string | null, focus?: boolean): void;
}

export interface TestMockConfig {
  /** Maps workspacePath → resolution data. */
  readonly workspaces?: Readonly<Record<string, MockWorkspaceEntry>>;
  /** Maps projectPath → resolution data. */
  readonly projects?: Readonly<Record<string, MockProjectEntry>>;
  /** Active workspace ref for get-active-workspace. Default: null. */
  readonly activeWorkspaceRef?: WorkspaceRef | null;
  /** View manager for switch-workspace activate hook. Only wired if provided. */
  readonly viewManager?: MockViewManager;
}

// =============================================================================
// Mock Module Factory
// =============================================================================

/**
 * Creates a single IntentModule with hooks for common infrastructure operations:
 * - resolve-workspace: looks up config.workspaces[workspacePath]
 * - resolve-project: looks up config.projects[projectPath]
 * - get-active-workspace: returns config.activeWorkspaceRef
 * - switch-workspace activate: calls config.viewManager.setActiveWorkspace() (if provided)
 */
export function createTestMockModule(config: TestMockConfig): IntentModule {
  const hooks: Record<
    string,
    Record<string, { handler: (ctx: HookContext) => Promise<unknown> }>
  > = {};

  // -- resolve-workspace --
  if (config.workspaces) {
    const workspaces = config.workspaces;
    hooks[RESOLVE_WORKSPACE_OPERATION_ID] = {
      resolve: {
        handler: async (ctx: HookContext): Promise<ResolveWorkspaceHookResult> => {
          const intent = ctx.intent as { payload: { workspacePath: string } };
          const entry = workspaces[intent.payload.workspacePath];
          return entry ?? {};
        },
      },
    };
  }

  // -- resolve-project --
  if (config.projects) {
    const projects = config.projects;
    hooks[RESOLVE_PROJECT_OPERATION_ID] = {
      resolve: {
        handler: async (ctx: HookContext): Promise<ResolveProjectHookResult> => {
          const { projectPath } = ctx as ResolveProjectHookInput;
          const entry = projects[projectPath];
          if (!entry) return {};
          const result: ResolveProjectHookResult = { projectId: entry.projectId };
          if (entry.projectName !== undefined) {
            return { ...result, projectName: entry.projectName };
          }
          return result;
        },
      },
    };
  }

  // -- get-active-workspace --
  const activeRef = config.activeWorkspaceRef ?? null;
  hooks[GET_ACTIVE_WORKSPACE_OPERATION_ID] = {
    get: {
      handler: async (): Promise<GetActiveWorkspaceHookResult> => {
        return { workspaceRef: activeRef };
      },
    },
  };

  // -- switch-workspace activate --
  if (config.viewManager) {
    const vm = config.viewManager;
    hooks[SWITCH_WORKSPACE_OPERATION_ID] = {
      activate: {
        handler: async (ctx: HookContext): Promise<SwitchWorkspaceHookResult> => {
          const { workspacePath } = ctx as ActivateHookInput;
          const intent = ctx.intent as SwitchWorkspaceIntent;
          if (vm.getActiveWorkspacePath() === workspacePath) {
            return {};
          }
          const focus = intent.payload.focus ?? true;
          vm.setActiveWorkspace(workspacePath, focus);
          return { resolvedPath: workspacePath };
        },
      },
    };
  }

  return { name: "test-mock", hooks };
}

// =============================================================================
// Convenience: Register operations + mock module
// =============================================================================

/**
 * Registers the four shared infrastructure operations on the dispatcher,
 * creates the mock module from config, and registers it.
 *
 * Returns `{ dispatcher, mockModule }` for further customization.
 */
export function registerTestInfrastructure(
  dispatcher: Dispatcher,
  config: TestMockConfig
): { mockModule: IntentModule } {
  dispatcher.registerOperation(INTENT_RESOLVE_WORKSPACE, new ResolveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_RESOLVE_PROJECT, new ResolveProjectOperation());
  dispatcher.registerOperation(INTENT_GET_ACTIVE_WORKSPACE, new GetActiveWorkspaceOperation());
  dispatcher.registerOperation(INTENT_SWITCH_WORKSPACE, new SwitchWorkspaceOperation());

  const mockModule = createTestMockModule(config);
  dispatcher.registerModule(mockModule);

  return { mockModule };
}

/**
 * Creates a fresh Dispatcher + HookRegistry and registers infrastructure.
 * Convenience for tests that don't need custom dispatcher setup.
 */
export function createTestDispatcher(config: TestMockConfig): {
  dispatcher: Dispatcher;
  hookRegistry: HookRegistry;
  mockModule: IntentModule;
} {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);
  const { mockModule } = registerTestInfrastructure(dispatcher, config);
  return { dispatcher, hookRegistry, mockModule };
}
