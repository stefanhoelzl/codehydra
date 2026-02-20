/**
 * TelemetryModule - Lifecycle module for telemetry capture and shutdown.
 *
 * Hooks:
 * - app:start → "configure": registers global error handlers (uncaughtException, unhandledRejection)
 * - app:start → "start": captures "app_launched" event with platform/agent info
 * - app:shutdown → "stop": flushes and shuts down telemetry service (best-effort)
 */

import type { IntentModule } from "../intents/infrastructure/module";
import {
  APP_START_OPERATION_ID,
  type ConfigureResult,
  type StartHookResult,
} from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import type { TelemetryService } from "../../services/telemetry/types";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
import type { ConfigService } from "../../services/config/config-service";
import type { Logger } from "../../services/logging/types";

interface TelemetryModuleDeps {
  readonly telemetryService: TelemetryService | null;
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly configService: Pick<ConfigService, "load">;
  readonly logger: Logger;
}

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        configure: {
          handler: async (): Promise<ConfigureResult> => {
            // Register global error handlers for uncaught exceptions.
            // Uses prependListener to capture errors before other handlers.
            process.prependListener("uncaughtException", (error: Error) => {
              deps.telemetryService?.captureError(error);
              throw error;
            });
            process.prependListener("unhandledRejection", (reason: unknown) => {
              const error = reason instanceof Error ? reason : new Error(String(reason));
              deps.telemetryService?.captureError(error);
              throw error;
            });
            return {};
          },
        },
        start: {
          handler: async (): Promise<StartHookResult> => {
            const config = await deps.configService.load();
            deps.telemetryService?.capture("app_launched", {
              platform: deps.platformInfo.platform,
              arch: deps.platformInfo.arch,
              isDevelopment: deps.buildInfo.isDevelopment,
              agent: config.agent ?? "unknown",
            });
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            try {
              if (deps.telemetryService) {
                await deps.telemetryService.shutdown();
              }
            } catch (error) {
              deps.logger.error(
                "Telemetry lifecycle shutdown failed (non-fatal)",
                {},
                error instanceof Error ? error : undefined
              );
            }
          },
        },
      },
    },
  };
}
