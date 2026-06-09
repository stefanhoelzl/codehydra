/**
 * TelemetryModule - PostHog analytics lifecycle + passive event capture.
 *
 * Owns the telemetry identity and drives the PostHogBoundary, but does NOT
 * handle crashes or bug reports — those live in error-report-module, which
 * shares the same boundary instance.
 *
 * Hooks:
 * - app:start → "start": resolve distinct id (generate+persist if needed),
 *   configure the boundary (commonProps + distinct id), capture "app_launched",
 *   and sync config overrides as person properties.
 * - app:shutdown → "stop": flush + close the boundary (best-effort).
 *
 * Events:
 * - workspace:created → "workspace_created" (new workspaces only)
 * - app:resumed → "app_resume" on wake from sleep
 *
 * Gating: passive events + identify are sent only when telemetry is enabled.
 * The boundary itself never gates — this module is the gate.
 */

import { randomUUID } from "node:crypto";
import type { PostHogBoundary } from "../boundaries/platform/posthog";
import type { StateService } from "../boundaries/platform/state-service";
import type { StateMigrationRegistry } from "./state-module";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../intents/open-workspace";
import { EVENT_APP_RESUMED } from "../intents/app-resume";
import { storeString } from "../boundaries/platform/store-definition";
import type { Config, ConfigAgentType } from "../boundaries/platform/config";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";

// =============================================================================
// Dependencies
// =============================================================================

export interface TelemetryModuleDeps {
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly configService: Config;
  /** Persisted app state (state.json) — owns the auto-generated distinct-id. */
  readonly stateService: StateService;
  /** Registry the state module drains to migrate distinct-id out of config.json. */
  readonly stateMigrations: StateMigrationRegistry;
  /** Accessor for the user's agent selection (registered in the composition root). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
  /** Accessor for telemetry.enabled (registered in the composition root). */
  readonly telemetryEnabled: PersistedAccessor<boolean>;
  /** The shared PostHog sink. */
  readonly boundary: PostHogBoundary;
  readonly logger: Logger;
}

// =============================================================================
// Module
// =============================================================================

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  // The auto-generated telemetry id is app-written state, not user config: it
  // lives in state.json. A read-only `deprecated` shadow in config.json lets the
  // state module migrate an id written by an older build, then strip it.
  const telemetryDistinctIdState = deps.stateService.register("telemetry.distinct-id", {
    default: null,
    description: "Telemetry user ID (auto-generated)",
    redact: true,
    ...storeString({ nullable: true }),
  });
  const telemetryDistinctIdLegacy = deps.configService.register("telemetry.distinct-id", {
    default: null,
    description: "Deprecated: telemetry user ID (migrated to state.json)",
    redact: true,
    deprecated: true,
    ...storeString({ nullable: true }),
  });
  deps.stateMigrations.add({ from: telemetryDistinctIdLegacy, to: telemetryDistinctIdState });

  let distinctId: string | null = null;
  let enabled = false;

  /** Standard properties stamped on every event/exception via the boundary. */
  function commonProps(): Record<string, unknown> {
    return {
      platform: deps.platformInfo.platform,
      arch: deps.platformInfo.arch,
      isDevelopment: deps.buildInfo.isDevelopment,
      agent: deps.agentConfig.get(),
      version: deps.buildInfo.version,
    };
  }

  return {
    name: "telemetry",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            enabled = deps.telemetryEnabled.get();

            const storedDistinctId = telemetryDistinctIdState.get();
            if (storedDistinctId) {
              distinctId = storedDistinctId;
            }

            // Generate + persist an id when telemetry is enabled and none exists.
            if (enabled && !distinctId) {
              distinctId = randomUUID();
              await telemetryDistinctIdState.set(distinctId);
              deps.logger.debug("Generated new distinctId");
            }

            // Configure the boundary regardless of `enabled`: a user bug report
            // (sent even with telemetry off) still needs commonProps. distinctId
            // is null when disabled → anonymous fallback at send time.
            deps.boundary.configure({
              distinctId: distinctId ?? undefined,
              commonProps: commonProps(),
            });

            const configuredAgent = deps.agentConfig.get();
            if (enabled && configuredAgent !== undefined) {
              deps.boundary.capture("app_launched");
            }

            // Sync current config overrides as person properties. Only `agent`
            // mutates post-launch today, and it lands on the next launch.
            if (enabled && distinctId) {
              deps.boundary.identify({ config: deps.configService.getRedactedOverrides() });
            }
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async (): Promise<void> => {
            deps.logger.debug("Telemetry shutting down");
            await deps.boundary.shutdown();
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { reopened } = (event as WorkspaceCreatedEvent).payload;
          if (enabled && !reopened) {
            deps.boundary.capture("workspace_created");
          }
        },
      },
      [EVENT_APP_RESUMED]: {
        handler: async (): Promise<void> => {
          if (enabled) {
            deps.boundary.capture("app_resume");
          }
        },
      },
    },
  };
}
