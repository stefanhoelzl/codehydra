/**
 * ShortcutModule - Owns the ShortcutController lifecycle as an IntentModule.
 *
 * Hooks:
 * - app-start/init: Create ShortcutController, register UI view
 * - app-shutdown/stop: Dispose ShortcutController
 *
 * Events:
 * - workspace:created: Register new workspace view with ShortcutController
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IViewManager } from "../managers/view-manager.interface";
import type { Logger } from "../../services/logging";
import type { KeyboardInput, Unsubscribe, ViewLayer } from "../../services/shell/view";
import type { WindowLayer } from "../../services/shell/window";
import type { ViewHandle, WindowHandle } from "../../services/shell/types";
import { ShortcutController } from "../shortcut-controller";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { INTENT_SET_MODE, type SetModeIntent } from "../operations/set-mode";
import { ApiIpcChannels } from "../../shared/ipc";

export interface ShortcutModuleDeps {
  readonly viewManager: Pick<
    IViewManager,
    "focusUI" | "getUIViewHandle" | "getMode" | "sendToUI" | "getWorkspaceView"
  >;
  readonly viewLayer: Pick<ViewLayer, "onBeforeInputEvent" | "onDestroyed">;
  readonly windowLayer: Pick<WindowLayer, "onBlur">;
  readonly getWindowHandle: () => WindowHandle;
  readonly dispatch: (intent: { type: string; payload: unknown }) => PromiseLike<unknown>;
  readonly logger: Logger;
}

export function createShortcutModule(deps: ShortcutModuleDeps): IntentModule {
  let controller: ShortcutController | null = null;

  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          handler: async (): Promise<void> => {
            controller = new ShortcutController({
              focusUI: () => deps.viewManager.focusUI(),
              setMode: (mode) => {
                void deps.dispatch({
                  type: INTENT_SET_MODE,
                  payload: { mode },
                } as SetModeIntent);
              },
              getMode: () => deps.viewManager.getMode(),
              onShortcut: (key) => {
                deps.viewManager.sendToUI(ApiIpcChannels.SHORTCUT_KEY, key);
              },
              logger: deps.logger,
              viewLayer: deps.viewLayer as {
                onBeforeInputEvent(
                  handle: ViewHandle,
                  callback: (input: KeyboardInput, preventDefault: () => void) => void
                ): Unsubscribe;
                onDestroyed(handle: ViewHandle, callback: () => void): Unsubscribe;
              },
              windowLayer: deps.windowLayer as {
                onBlur(handle: WindowHandle, callback: () => void): Unsubscribe;
              },
              windowHandle: deps.getWindowHandle(),
            });

            // Register UI view
            controller.registerView(deps.viewManager.getUIViewHandle());
          },
        },
      },

      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            try {
              controller?.dispose();
            } catch {
              // Best-effort: shutdown disposal is non-fatal
            }
            controller = null;
          },
        },
      },
    },

    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        if (!controller) return;
        const payload = (event as WorkspaceCreatedEvent).payload;
        const handle = deps.viewManager.getWorkspaceView(payload.workspacePath);
        if (handle) {
          controller.registerView(handle);
        }
      },
    },
  };
}
