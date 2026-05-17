/**
 * ThemeModule - Pushes the resolved OS theme to the renderer.
 *
 * Main owns theme state (via WindowManager + nativeTheme) so the native
 * window backgroundColor stays in sync with the renderer's CSS. The module
 * sends the initial theme after the UI HTML loads and pushes updates
 * whenever the OS theme changes.
 */

import type { IntentModule } from "../intents/lib/module";
import { ANY_VALUE } from "../intents/lib/operation";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import type { IViewManager } from "../boundaries/shell/view-manager.interface";
import type { Theme } from "../boundaries/shell/window-manager";
import type { Unsubscribe } from "../shared/api/interfaces";
import { ApiIpcChannels } from "../shared/ipc";

export interface ThemeModuleDeps {
  readonly viewManager: Pick<IViewManager, "sendToUI">;
  readonly windowManager: {
    getTheme(): Theme;
    onThemeChange(callback: (theme: Theme) => void): Unsubscribe;
  };
}

export function createThemeModule(deps: ThemeModuleDeps): IntentModule {
  let unsubscribe: Unsubscribe | null = null;

  return {
    name: "theme-module",
    hooks: {
      [APP_START_OPERATION_ID]: {
        init: {
          requires: { "ui-ready": ANY_VALUE },
          handler: async (): Promise<void> => {
            deps.viewManager.sendToUI(ApiIpcChannels.UI_THEME, deps.windowManager.getTheme());
            unsubscribe = deps.windowManager.onThemeChange((theme) => {
              deps.viewManager.sendToUI(ApiIpcChannels.UI_THEME, theme);
            });
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
          },
        },
      },
    },
  };
}
