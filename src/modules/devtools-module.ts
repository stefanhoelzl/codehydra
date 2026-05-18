/**
 * DevtoolsModule - Dev-only DevTools toggling via shortcut keys.
 *
 * Subscribes to shortcut:key-pressed domain event and handles:
 * - "d": Toggle UI DevTools
 * - "w": Toggle active workspace DevTools
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";

export interface DevtoolsModuleDeps {
  readonly viewManager: Pick<
    IViewManager,
    "getUIDevtoolsTarget" | "getActiveWorkspaceDevtoolsTarget"
  >;
}

export function createDevtoolsModule(deps: DevtoolsModuleDeps): IntentModule {
  return {
    name: "devtools",
    requires: { development: true },
    events: {
      [EVENT_SHORTCUT_KEY_PRESSED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { key } = (event as ShortcutKeyPressedEvent).payload;

          if (key === "d") {
            deps.viewManager.getUIDevtoolsTarget().toggle();
            return;
          }

          if (key === "w") {
            deps.viewManager.getActiveWorkspaceDevtoolsTarget()?.toggle();
          }
        },
      },
    },
  };
}
