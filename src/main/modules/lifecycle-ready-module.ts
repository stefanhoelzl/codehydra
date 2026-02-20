/**
 * LifecycleReadyModule - Coordinates the lifecycle.ready IPC signal.
 *
 * Encapsulates the projectsLoadedPromise deferred and the app:started
 * event subscription. Provides the lifecycle.ready handler that resolves
 * the mount signal and waits for initial project:open dispatches to complete.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { EVENT_APP_STARTED } from "../operations/app-start";
import type { MountSignal } from "./view-module";

export interface LifecycleReadyModuleDeps {
  readonly mountSignal: MountSignal;
}

export interface LifecycleReadyModuleResult {
  readonly module: IntentModule;
  /** Handler for the lifecycle.ready API method. Call from registry.register(). */
  readonly readyHandler: () => Promise<void>;
}

export function createLifecycleReadyModule(
  deps: LifecycleReadyModuleDeps
): LifecycleReadyModuleResult {
  let projectsLoadedResolve: (() => void) | null = null;
  const projectsLoadedPromise = new Promise<void>((resolve) => {
    projectsLoadedResolve = resolve;
  });

  const module: IntentModule = {
    events: {
      [EVENT_APP_STARTED]: () => {
        if (projectsLoadedResolve) {
          projectsLoadedResolve();
          projectsLoadedResolve = null;
        }
      },
    },
  };

  const readyHandler = async (): Promise<void> => {
    if (deps.mountSignal.resolve) {
      deps.mountSignal.resolve();
      deps.mountSignal.resolve = null;
      await projectsLoadedPromise;
    }
  };

  return { module, readyHandler };
}
