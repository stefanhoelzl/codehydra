/**
 * DevtoolsModule - Dev-only DevTools toggling via shortcut keys.
 *
 * Subscribes to shortcut:key-pressed domain event and handles:
 * - "d": Toggle UI DevTools
 * - "w": Toggle active workspace DevTools
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { IViewManager } from "../boundaries/shell/view/view-manager.interface";
import type { ViewBoundary } from "../boundaries/shell/view/view";
import type { ViewHandle } from "../boundaries/shell/types";
import {
  EVENT_SHORTCUT_KEY_PRESSED,
  type ShortcutKeyPressedEvent,
} from "../intents/shortcut-key";

export interface DevtoolsModuleDeps {
  readonly viewManager: Pick<
    IViewManager,
    "getUIViewHandle" | "getWorkspaceView" | "getActiveWorkspacePath"
  >;
  readonly viewLayer: Pick<ViewBoundary, "openDevTools" | "closeDevTools" | "isDevToolsOpened">;
}

function toggleDevTools(
  viewLayer: Pick<ViewBoundary, "openDevTools" | "closeDevTools" | "isDevToolsOpened">,
  handle: ViewHandle
): void {
  if (viewLayer.isDevToolsOpened(handle)) {
    viewLayer.closeDevTools(handle);
  } else {
    viewLayer.openDevTools(handle, { mode: "detach" });
  }
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
            toggleDevTools(deps.viewLayer, deps.viewManager.getUIViewHandle());
            return;
          }

          if (key === "w") {
            const activePath = deps.viewManager.getActiveWorkspacePath();
            if (activePath) {
              const wsHandle = deps.viewManager.getWorkspaceView(activePath);
              if (wsHandle) {
                toggleDevTools(deps.viewLayer, wsHandle);
              }
            }
          }
        },
      },
    },
  };
}
