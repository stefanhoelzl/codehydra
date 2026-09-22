/**
 * State module - loads persisted application state.
 *
 * Owns the one place StateService.load() is called: the app:start "init" hook,
 * which runs before "start" where modules consume their state values.
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import type { StateService } from "../boundaries/platform/state-service";

export interface StateModuleDeps {
  readonly stateService: StateService;
}

export function createStateModule(deps: StateModuleDeps): IntentModule {
  return {
    name: "state",
    hooks: {
      [APP_START_OPERATION_ID]: {
        // Run after "app-ready" so the async state.json I/O happens once the
        // AsyncWatcher (which forbids FSREQPROMISE during the pre-ready window)
        // has been disabled. Values are consumed later, in the "start" hook.
        init: {
          requires: { "app-ready": true },
          handler: async (): Promise<void> => {
            await deps.stateService.load();
          },
        },
      },
    },
  };
}
