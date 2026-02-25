/**
 * TelemetryModule - Lifecycle module for telemetry capture and shutdown.
 *
 * Hooks:
 * - app:start → "before-ready": registers global error handlers (only if telemetry.enabled)
 * - app:start → "start": captures "app_launched" event with platform/agent info
 * - app:shutdown → "stop": flushes and shuts down telemetry service (best-effort)
 *
 * Events:
 * - config:updated: configures PosthogTelemetryService when telemetry values arrive,
 *   registers error handlers when telemetry.enabled is true
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { StartHookResult } from "../operations/app-start";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ConfigSetValuesIntent } from "../operations/config-set-values";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { INTENT_CONFIG_SET_VALUES, EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import type { TelemetryService } from "../../services/telemetry/types";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
import type { Logger } from "../../services/logging/types";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { ConfigAgentType } from "../../services/config/config-values";

interface TelemetryModuleDeps {
  readonly telemetryService: TelemetryService | null;
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly dispatcher: Dispatcher;
  readonly logger: Logger;
}

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  // Track config values received via config:updated
  let configuredAgent: ConfigAgentType | undefined;
  let telemetryEnabled: boolean | undefined;
  let distinctId: string | undefined;
  let errorHandlersRegistered = false;

  function registerErrorHandlers(): void {
    if (errorHandlersRegistered) return;
    errorHandlersRegistered = true;

    process.prependListener("uncaughtException", (error: Error) => {
      deps.telemetryService?.captureError(error);
      throw error;
    });
    process.prependListener("unhandledRejection", (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      deps.telemetryService?.captureError(error);
      throw error;
    });
  }

  return {
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<StartHookResult> => {
            if (configuredAgent !== undefined) {
              deps.telemetryService?.capture("app_launched", {
                platform: deps.platformInfo.platform,
                arch: deps.platformInfo.arch,
                isDevelopment: deps.buildInfo.isDevelopment,
                agent: configuredAgent ?? "unknown",
              });
            }
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
    events: {
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;

        if (values.agent !== undefined) {
          configuredAgent = values.agent;
        }

        if (values["telemetry.enabled"] !== undefined) {
          telemetryEnabled = values["telemetry.enabled"];
        }

        if (values["telemetry.distinctId"] !== undefined) {
          distinctId = values["telemetry.distinctId"];
        }

        // Configure telemetry service when relevant values arrive
        if (telemetryEnabled !== undefined && deps.telemetryService) {
          deps.telemetryService.configure({
            enabled: telemetryEnabled,
            distinctId,
            agent: configuredAgent ?? undefined,
          });

          // Register error handlers when telemetry is enabled
          if (telemetryEnabled) {
            registerErrorHandlers();
          }

          // Generate distinctId if telemetry is enabled but no id yet
          if (telemetryEnabled && !distinctId) {
            const newId = deps.telemetryService.generateDistinctId();
            if (newId) {
              distinctId = newId;
              void deps.dispatcher.dispatch({
                type: INTENT_CONFIG_SET_VALUES,
                payload: { values: { "telemetry.distinctId": newId } },
              } as ConfigSetValuesIntent);
            }
          }
        }
      },
    },
  };
}
