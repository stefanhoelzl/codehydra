/**
 * RetryModule - Provides retry-from-UI capability for the app:start flow.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { IpcEventHandler } from "../../services/platform/ipc";
import type { ShowUIHookResult } from "../operations/app-start";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { ApiIpcChannels } from "../../shared/ipc";

export interface RetryModuleDeps {
  readonly ipcLayer: Pick<import("../../services/platform/ipc").IpcLayer, "on" | "removeListener">;
}

export function createRetryModule(deps: RetryModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        "show-ui": {
          handler: async (): Promise<ShowUIHookResult> => {
            return {
              waitForRetry: () =>
                new Promise<void>((resolve) => {
                  const handleRetry: IpcEventHandler = () => {
                    deps.ipcLayer.removeListener(ApiIpcChannels.LIFECYCLE_RETRY, handleRetry);
                    resolve();
                  };
                  deps.ipcLayer.on(ApiIpcChannels.LIFECYCLE_RETRY, handleRetry);
                }),
            };
          },
        },
      },
    },
  };
}
