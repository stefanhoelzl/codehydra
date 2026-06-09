/**
 * State module - loads persisted application state and runs config→state migrations.
 *
 * Owns the one place StateService.load() is called: the app:start "init" hook,
 * which runs before "start" where modules consume their state values.
 *
 * Migration model (modules own their keys; this module coordinates):
 *   A module that has a value moving from config.json to state.json registers
 *   the live key in StateService AND a read-only `deprecated` shadow in Config,
 *   then contributes a {from, to} pair to the migration registry. After loading
 *   state.json, this module seeds any not-yet-migrated value from the deprecated
 *   shadow and strips it from config.json via reset(). It's a one-shot per key:
 *   once state.json holds the value, the shadow is ignored on subsequent launches.
 */

import type { IntentModule } from "../intents/lib/module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import type { StateService } from "../boundaries/platform/state-service";
import type {
  PersistedAccessor,
  DeprecatedPersistedAccessor,
} from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging-types";

// =============================================================================
// Migration registry
// =============================================================================

/**
 * One config→state migration: read `from` (a deprecated config.json shadow),
 * seed `to` (the live state.json key), then strip the shadow from config.json.
 */
export interface StateMigration {
  readonly from: DeprecatedPersistedAccessor;
  readonly to: PersistedAccessor<unknown>;
}

export interface StateMigrationRegistry {
  add(migration: StateMigration): void;
  list(): readonly StateMigration[];
}

/** Create an empty migration registry. Modules add() during construction. */
export function createStateMigrationRegistry(): StateMigrationRegistry {
  const migrations: StateMigration[] = [];
  return {
    add: (migration) => migrations.push(migration),
    list: () => migrations,
  };
}

// =============================================================================
// Module
// =============================================================================

export interface StateModuleDeps {
  readonly stateService: StateService;
  readonly migrations: StateMigrationRegistry;
  readonly logger: Logger;
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

            for (const { from, to } of deps.migrations.list()) {
              // Already migrated (state.json holds a value): leave the shadow alone.
              if (!to.isDefault()) continue;

              const legacy = from.get();
              if (legacy === null || legacy === undefined) continue;

              try {
                await to.set(legacy);
                await from.reset();
                deps.logger.info("Migrated config value to state.json", { key: to.name });
              } catch (error) {
                // Best-effort: a failed migration just retries next launch (the
                // shadow stays in config.json; state.json keeps its default).
                deps.logger.warn("State migration failed", {
                  key: to.name,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          },
        },
      },
    },
  };
}
