/**
 * Bootstrap - Application bootstrap using ApiRegistry pattern.
 *
 * This module provides the main bootstrap path that uses the ApiRegistry
 * pattern from planning/API_REGISTRY_REFACTOR.md.
 *
 * The bootstrap flow:
 * 1. initializeBootstrap() - Creates registry + lifecycle module
 * 2. startServices() - Called when setup completes, creates remaining modules
 */

import { ApiRegistry } from "./api/registry";
import { LifecycleModule, type LifecycleModuleDeps } from "./modules/lifecycle";
import { CoreModule, type CoreModuleDeps } from "./modules/core";
import { UiModule, type UiModuleDeps } from "./modules/ui";
import type {
  IApiRegistry,
  IApiModule,
  WorkspaceSetMetadataPayload,
  WorkspaceRefPayload,
} from "./api/registry-types";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { Logger } from "../services/logging";
import type { IpcLayer } from "../services/platform/ipc";
import { ApiIpcChannels } from "../shared/ipc";
import { HookRegistry } from "./intents/infrastructure/hook-registry";
import { Dispatcher } from "./intents/infrastructure/dispatcher";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  INTENT_SET_METADATA,
} from "./operations/set-metadata";
import type { SetMetadataIntent } from "./operations/set-metadata";
import {
  GetMetadataOperation,
  GET_METADATA_OPERATION_ID,
  INTENT_GET_METADATA,
} from "./operations/get-metadata";
import type { GetMetadataIntent, GetMetadataHookContext } from "./operations/get-metadata";
import { createIpcEventBridge } from "./modules/ipc-event-bridge";
import { wireModules } from "./intents/infrastructure/wire";
import { resolveWorkspace } from "./api/id-utils";
import type { HookContext } from "./intents/infrastructure/operation";
import type { GitWorktreeProvider } from "../services/git/git-worktree-provider";
import { Path } from "../services/platform/path";

// =============================================================================
// Types
// =============================================================================

/**
 * Dependencies required to create and start the registry-based API.
 */
export interface BootstrapDeps {
  /** Logger for the registry */
  readonly logger: Logger;
  /** IPC layer for handler registration */
  readonly ipcLayer: IpcLayer;
  /** Lifecycle module dependencies */
  readonly lifecycleDeps: LifecycleModuleDeps;
  /** Core module dependencies (provided after setup completes) */
  readonly coreDepsFn: () => CoreModuleDeps;
  /** UI module dependencies (provided after setup completes) */
  readonly uiDepsFn: () => UiModuleDeps;
  /** Global worktree provider for metadata operations (provided after setup completes) */
  readonly globalWorktreeProviderFn: () => GitWorktreeProvider;
}

/**
 * Result of bootstrap initialization.
 */
export interface BootstrapResult {
  /** The API registry */
  readonly registry: IApiRegistry;
  /** The typed API interface (throws if not all methods registered) */
  readonly getInterface: () => ICodeHydraApi;
  /** Dispose all modules and the registry */
  readonly dispose: () => Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Initialize the bootstrap with lifecycle module only.
 *
 * This is the first phase of the two-phase startup:
 * 1. initializeBootstrap() - Creates registry + lifecycle module
 * 2. startServices() - Called when setup completes, creates remaining modules
 *
 * @param deps Bootstrap dependencies
 * @returns Bootstrap result with registry and interface getter
 */
export function initializeBootstrap(deps: BootstrapDeps): BootstrapResult {
  // 1. Create registry FIRST (before any modules)
  const registry = new ApiRegistry({
    logger: deps.logger,
    ipcLayer: deps.ipcLayer,
  });

  // 2. Track modules for disposal (reverse order)
  const modules: IApiModule[] = [];

  // 3. Create LifecycleModule - must be ready before UI loads
  const lifecycleModule = new LifecycleModule(registry, deps.lifecycleDeps);
  modules.push(lifecycleModule);

  // 4. Services started flag
  let servicesStarted = false;

  // 5. The onSetupComplete callback triggers startServices
  // This is wired through deps.lifecycleDeps.onSetupComplete

  /**
   * Start remaining services after setup completes.
   * This creates CoreModule, UiModule, and intent dispatcher.
   */
  function startServices(): void {
    if (servicesStarted) return;
    servicesStarted = true;

    const coreDeps = deps.coreDepsFn();

    // Create remaining modules
    const coreModule = new CoreModule(registry, coreDeps);
    modules.push(coreModule);

    const uiModule = new UiModule(registry, deps.uiDepsFn());
    modules.push(uiModule);

    // Wire intent dispatcher for metadata operations
    wireMetadataDispatcher(registry, deps.globalWorktreeProviderFn(), coreDeps.appState);
  }

  /**
   * Get the typed API interface.
   * Throws if not all methods are registered.
   */
  function getInterface(): ICodeHydraApi {
    // If services haven't started, only lifecycle methods are available
    // This will throw with missing methods
    return registry.getInterface();
  }

  /**
   * Dispose all modules and the registry.
   * Modules are disposed in reverse order of creation.
   */
  async function dispose(): Promise<void> {
    // Dispose modules in reverse order
    for (let i = modules.length - 1; i >= 0; i--) {
      const module = modules[i];
      if (module) {
        module.dispose();
      }
    }
    modules.length = 0;

    // Dispose registry
    await registry.dispose();
  }

  // Return bootstrap result with start function attached
  const result: BootstrapResult & { startServices: () => void } = {
    registry,
    getInterface,
    dispose,
    startServices,
  };

  return result;
}

// =============================================================================
// Intent Dispatcher Wiring
// =============================================================================

/**
 * Wire metadata operations into the intent dispatcher and register
 * bridge handlers in the API registry.
 *
 * This replaces the metadata methods that were previously in CoreModule.
 */
function wireMetadataDispatcher(
  registry: IApiRegistry,
  globalProvider: GitWorktreeProvider,
  appState: CoreModuleDeps["appState"]
): void {
  const hookRegistry = new HookRegistry();
  const dispatcher = new Dispatcher(hookRegistry);

  // Register operations
  dispatcher.registerOperation(INTENT_SET_METADATA, new SetMetadataOperation());
  dispatcher.registerOperation(INTENT_GET_METADATA, new GetMetadataOperation());

  // Register provider hook handlers
  hookRegistry.register(SET_METADATA_OPERATION_ID, "set", {
    handler: async (ctx: HookContext) => {
      const intent = ctx.intent as SetMetadataIntent;
      const { workspace } = await resolveWorkspace(intent.payload, appState);
      await globalProvider.setMetadata(
        new Path(workspace.path),
        intent.payload.key,
        intent.payload.value
      );
    },
  });

  hookRegistry.register(GET_METADATA_OPERATION_ID, "get", {
    handler: async (ctx: GetMetadataHookContext) => {
      const intent = ctx.intent as GetMetadataIntent;
      const { workspace } = await resolveWorkspace(intent.payload, appState);
      const metadata = await globalProvider.getMetadata(new Path(workspace.path));
      ctx.metadata = metadata;
    },
  });

  // Wire IpcEventBridge (forwards domain events to ApiRegistry.emit)
  const ipcEventBridge = createIpcEventBridge(registry);
  wireModules([ipcEventBridge], hookRegistry, dispatcher);

  // Register dispatcher bridge handlers in the API registry
  registry.register(
    "workspaces.setMetadata",
    async (payload: WorkspaceSetMetadataPayload) => {
      const intent: SetMetadataIntent = {
        type: INTENT_SET_METADATA,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          key: payload.key,
          value: payload.value,
        },
      };
      await dispatcher.dispatch(intent);
    },
    { ipc: ApiIpcChannels.WORKSPACE_SET_METADATA }
  );

  registry.register(
    "workspaces.getMetadata",
    async (payload: WorkspaceRefPayload) => {
      const intent: GetMetadataIntent = {
        type: INTENT_GET_METADATA,
        payload: {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
        },
      };
      const result = await dispatcher.dispatch(intent);
      if (!result) {
        throw new Error("Get metadata dispatch returned no result");
      }
      return result;
    },
    { ipc: ApiIpcChannels.WORKSPACE_GET_METADATA }
  );
}
