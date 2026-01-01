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
import type { IApiRegistry, IApiModule } from "./api/registry-types";
import type { ICodeHydraApi } from "../shared/api/interfaces";
import type { Logger } from "../services/logging";
import type { IpcLayer } from "../services/platform/ipc";

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
   * This creates CoreModule and UiModule.
   */
  function startServices(): void {
    if (servicesStarted) return;
    servicesStarted = true;

    // Create remaining modules
    const coreModule = new CoreModule(registry, deps.coreDepsFn());
    modules.push(coreModule);

    const uiModule = new UiModule(registry, deps.uiDepsFn());
    modules.push(uiModule);
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
