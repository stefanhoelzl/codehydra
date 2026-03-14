/**
 * TelemetryModule - Lifecycle module for telemetry capture and shutdown.
 *
 * Hooks:
 * - app:start → "before-ready": registers global error handlers (only if telemetry.enabled)
 * - app:start → "start": generates distinct ID if needed, captures "app_launched" event
 * - app:shutdown → "stop": flushes and shuts down telemetry service (best-effort)
 *
 * Events:
 * - config:updated: configures PosthogTelemetryService when telemetry values arrive,
 *   registers error handlers when telemetry.enabled is true
 * - workspace:created: captures "workspace_created" for new workspaces (not reopened)
 * - app:resumed: captures "app_resume" on system wake from sleep/hibernate
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { StartHookResult, RegisterConfigResult } from "../operations/app-start";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ConfigSetValuesIntent } from "../operations/config-set-values";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { INTENT_CONFIG_SET_VALUES, EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_APP_RESUMED } from "../operations/app-resume";
import { configBoolean, configString } from "../../services/config/config-definition";
import type { TelemetryService } from "../../services/telemetry/types";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { ConfigAgentType } from "../../services/config/config-values";

interface TelemetryModuleDeps {
  readonly telemetryService: TelemetryService | null;
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly dispatcher: Dispatcher;
}

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  // Track config values received via config:updated
  let configuredAgent: ConfigAgentType | undefined;
  let telemetryEnabled: boolean | undefined;
  let distinctId: string | undefined;
  let errorHandlersRegistered = false;

  function eventProperties(): Record<string, unknown> {
    return {
      platform: deps.platformInfo.platform,
      arch: deps.platformInfo.arch,
      isDevelopment: deps.buildInfo.isDevelopment,
      agent: configuredAgent,
    };
  }

  function registerErrorHandlers(): void {
    if (errorHandlersRegistered) return;
    errorHandlersRegistered = true;

    process.on("uncaughtExceptionMonitor", (error: Error) => {
      deps.telemetryService?.captureError(error);
    });
  }

  return {
    name: "telemetry",
    hooks: {
      [APP_START_OPERATION_ID]: {
        "register-config": {
          handler: async (): Promise<RegisterConfigResult> => ({
            definitions: [
              {
                name: "telemetry.enabled",
                default: true,
                description: "Enable telemetry (false in dev/unpackaged)",
                ...configBoolean(),
                computedDefault: (ctx) =>
                  ctx.isDevelopment || !ctx.isPackaged ? false : undefined,
              },
              {
                name: "telemetry.distinct-id",
                default: null,
                description: "Telemetry user ID (auto-generated)",
                ...configString({ nullable: true }),
              },
            ],
          }),
        },
        start: {
          handler: async (): Promise<StartHookResult> => {
            // Generate distinctId if needed (after init has loaded stored config)
            if (telemetryEnabled && !distinctId && deps.telemetryService) {
              const newId = deps.telemetryService.generateDistinctId();
              if (newId) {
                distinctId = newId;
                deps.telemetryService.configure({
                  enabled: telemetryEnabled,
                  distinctId: newId,
                  agent: configuredAgent ?? undefined,
                });
                await deps.dispatcher.dispatch({
                  type: INTENT_CONFIG_SET_VALUES,
                  payload: { values: { "telemetry.distinct-id": newId } },
                } as ConfigSetValuesIntent);
              }
            }

            if (configuredAgent !== undefined) {
              deps.telemetryService?.capture("app_launched", eventProperties());
            }
            return {};
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (deps.telemetryService) {
              await deps.telemetryService.shutdown();
            }
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
        const { reopened } = (event as WorkspaceCreatedEvent).payload;
        if (!reopened) {
          deps.telemetryService?.capture("workspace_created", eventProperties());
        }
      },
      [EVENT_APP_RESUMED]: () => {
        deps.telemetryService?.capture("app_resume", eventProperties());
      },
      [EVENT_CONFIG_UPDATED]: (event: DomainEvent) => {
        const { values } = (event as ConfigUpdatedEvent).payload;

        if (values.agent !== undefined) {
          configuredAgent = values.agent as ConfigAgentType;
        }

        if (values["telemetry.enabled"] !== undefined) {
          telemetryEnabled = values["telemetry.enabled"] as boolean;
        }

        const rawDistinctId = values["telemetry.distinct-id"];
        if (typeof rawDistinctId === "string") {
          distinctId = rawDistinctId;
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
        }
      },
    },
  };
}
