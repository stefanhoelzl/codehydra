/**
 * Wire utility — reads module declarations and registers hooks and event subscribers.
 *
 * Connects IntentModule declarations to the HookRegistry and Dispatcher.
 */

import type { IHookRegistry } from "./hook-registry";
import type { IDispatcher } from "./dispatcher";
import type { IntentModule } from "./module";

/**
 * Wire modules into the intent system.
 *
 * For each module:
 * - Registers all hook handlers into the HookRegistry
 * - Subscribes all event handlers into the Dispatcher
 *
 * Event handler dispatch: the wire utility matches event type to handler,
 * so handlers only receive events they declared for.
 *
 * @param modules - Modules to wire
 * @param hookRegistry - Registry to register hooks into
 * @param dispatcher - Dispatcher to subscribe events into
 */
export function wireModules(
  modules: readonly IntentModule[],
  hookRegistry: IHookRegistry,
  dispatcher: IDispatcher
): void {
  for (const mod of modules) {
    // Register hooks
    if (mod.hooks) {
      for (const [operationId, hookPoints] of Object.entries(mod.hooks)) {
        for (const [hookPointId, handler] of Object.entries(hookPoints)) {
          hookRegistry.register(operationId, hookPointId, handler);
        }
      }
    }

    // Subscribe events
    if (mod.events) {
      for (const [eventType, handler] of Object.entries(mod.events)) {
        dispatcher.subscribe(eventType, (event) => {
          if (event.type === eventType) {
            handler(event);
          }
        });
      }
    }
  }
}
