/**
 * TelemetryModule - Lifecycle module for telemetry capture and shutdown.
 *
 * Hooks:
 * - app:start → "start": captures "app_launched" event with platform/agent info
 * - app:shutdown → "stop": flushes and shuts down telemetry service (best-effort)
 */

import type { IntentModule } from "../intents/infrastructure/module";
import { APP_START_OPERATION_ID, type StartHookResult } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import type { TelemetryService } from "../../services/telemetry/types";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
import type { AgentType } from "../../agents/types";
import type { Logger } from "../../services/logging/types";

interface TelemetryModuleDeps {
  readonly telemetryService: TelemetryService | null;
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly selectedAgentType: AgentType;
  readonly logger: Logger;
}

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            deps.telemetryService?.capture("app_launched", {
              platform: deps.platformInfo.platform,
              arch: deps.platformInfo.arch,
              isDevelopment: deps.buildInfo.isDevelopment,
              agent: deps.selectedAgentType,
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
