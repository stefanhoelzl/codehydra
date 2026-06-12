/**
 * PresentationModule - owns the renderer→main api:ui:event channel.
 *
 * Phase A of the UI-state architecture (planning/UI_STATE_ARCHITECTURE.md):
 * the module is stateless. It zod-validates incoming UiEvents, drops invalid
 * ones with a warning, routes `log` events to the logging service (the
 * load-bearing replacement for the former api:log:* channels), and
 * debug-logs everything else. Later phases grow this module into the
 * presenter that owns the UiState view-model and the api:ui:state snapshot
 * channel.
 */

import type { IntentModule } from "../intents/lib/module";
import type { IpcBoundary, IpcEventHandler } from "../boundaries/shell/ipc";
import type { Logging, LoggerName, LogContext } from "../boundaries/platform/logging";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { ApiIpcChannels } from "../shared/ipc";
import { uiEventSchema } from "../shared/ui-event";

export interface PresentationModuleDeps {
  readonly ipcLayer: Pick<IpcBoundary, "on" | "removeListener">;
  readonly loggingService: Pick<Logging, "createLogger">;
}

/**
 * Validate and convert logger name from renderer to LoggerName type.
 * Returns "ui" if the provided name is not a valid renderer logger name.
 */
const VALID_RENDERER_LOGGER_NAMES = new Set<string>(["ui", "api"]);
function toLoggerName(name: string): LoggerName {
  return VALID_RENDERER_LOGGER_NAMES.has(name) ? (name as LoggerName) : "ui";
}

export function createPresentationModule(deps: PresentationModuleDeps): IntentModule {
  const logger = deps.loggingService.createLogger("presenter");

  const listener: IpcEventHandler = (_event: unknown, ...args: unknown[]) => {
    const result = uiEventSchema.safeParse(args[0]);
    if (!result.success) {
      logger.warn("Dropped invalid ui event", {
        issue: result.error.issues[0]?.message ?? "unknown",
      });
      return;
    }
    const event = result.data;
    if (event.kind === "log") {
      try {
        const target = deps.loggingService.createLogger(toLoggerName(event.logger));
        target[event.level](event.message, event.context as LogContext | undefined);
      } catch {
        // Swallow errors - logging should never crash the app
      }
      return;
    }
    logger.debug("ui event", { kind: event.kind });
  };

  deps.ipcLayer.on(ApiIpcChannels.UI_EVENT, listener);

  return {
    name: "presentation",
    hooks: {
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            deps.ipcLayer.removeListener(ApiIpcChannels.UI_EVENT, listener);
          },
        },
      },
    },
  };
}
