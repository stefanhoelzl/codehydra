/**
 * TelemetryModule - PostHog analytics lifecycle + passive event capture.
 *
 * Owns the telemetry identity and drives the PostHogBoundary, but does NOT
 * handle crashes or bug reports — those live in error-report-module, which
 * shares the same boundary instance.
 *
 * Hooks:
 * - app:start → "before-ready": configure the boundary with commonProps only, as
 *   early as possible, so a bug report or crash during the setup/boot phases (before
 *   "start" runs) still carries version/platform/arch/agent. The distinct id is not
 *   resolved yet → anonymous fallback at send time, which is correct for first-run
 *   (no id exists yet anyway).
 * - app:start → "start": resolve distinct id (generate+persist if needed),
 *   re-configure the boundary (commonProps + distinct id), capture "app_launched"
 *   with how the previous session ended, and sync config overrides as person
 *   properties.
 * - app:shutdown → "stop": record the session's end, flush + close the boundary
 *   (best-effort).
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
import type { IntentModule } from "../intents/lib/module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_WORKSPACE_CREATED } from "../intents/open-workspace";
import { EVENT_APP_RESUMED } from "../intents/app-resume";
import { storeCustom, storeString } from "../boundaries/platform/store-definition";
import type { Config, ConfigAgentType } from "../boundaries/platform/config";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import { defineEvents, defineHooks } from "../intents/declarations";

// =============================================================================
// Dependencies
// =============================================================================

export interface TelemetryModuleDeps {
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly configService: Config;
  /** Persisted app state (state.json) — owns the auto-generated distinct-id. */
  readonly stateService: StateService;
  /** Accessor for the user's agent selection (registered in the composition root). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
  /** Accessor for telemetry.enabled (registered in the composition root). */
  readonly telemetryEnabled: PersistedAccessor<boolean>;
  /** The shared PostHog sink. */
  readonly boundary: PostHogBoundary;
  readonly logger: Logger;
}

// =============================================================================
// Session record
// =============================================================================

/** ISO timestamps of a session; `endedAt` is null until its shutdown hook has run. */
interface LastSession {
  readonly startedAt: string;
  readonly endedAt: string | null;
}

function isLastSession(value: unknown): value is LastSession {
  if (typeof value !== "object" || value === null) return false;
  const { startedAt, endedAt } = value as Record<string, unknown>;
  return typeof startedAt === "string" && (endedAt === null || typeof endedAt === "string");
}

/** How the previous session ended, for `app_launched`; nothing on a first launch. */
function previousSessionProps(previous: LastSession | null): Record<string, unknown> {
  if (previous === null) return {};
  return {
    previous_session_clean_exit: previous.endedAt !== null,
    previous_session_started_at: previous.startedAt,
    previous_session_ended_at: previous.endedAt,
  };
}

// =============================================================================
// Module
// =============================================================================

export function createTelemetryModule(deps: TelemetryModuleDeps): IntentModule {
  // The auto-generated telemetry id is app-written state, not user config: it
  // lives in state.json.
  const telemetryDistinctIdState = deps.stateService.register("telemetry.distinct-id", {
    default: null,
    description: "Telemetry user ID (auto-generated)",
    redact: true,
    ...storeString({ nullable: true }),
  });

  // Quits send nothing, so how a session ended is only known at the next launch:
  // `endedAt` stays null for a session that never reached its shutdown hook.
  const lastSessionState = deps.stateService.register("telemetry.last-session", {
    default: null,
    description: "When the latest session started and ended",
    ...storeCustom<LastSession | null>({
      parse: () => undefined,
      validate: (value) => (value === null || isLastSession(value) ? value : undefined),
    }),
  });

  let session: LastSession | null = null;
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
    hooks: defineHooks({
      [APP_START_OPERATION_ID]: {
        // Stamp commonProps onto the boundary before any dependency check or setup
        // screen, so early reports/crashes are triageable (build + OS). distinctId
        // stays null here; "start" resolves and re-configures it below.
        "before-ready": {
          handler: async (): Promise<void> => {
            deps.boundary.configure({ commonProps: commonProps() });
          },
        },
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
              deps.boundary.capture("app_launched", previousSessionProps(lastSessionState.get()));
            }

            session = { startedAt: new Date().toISOString(), endedAt: null };
            await lastSessionState.set(session);

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
            try {
              if (session !== null) {
                await lastSessionState.set({ ...session, endedAt: new Date().toISOString() });
              }
            } finally {
              await deps.boundary.shutdown();
            }
          },
        },
      },
    }),
    events: defineEvents({
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event): Promise<void> => {
          const { fresh } = event.payload;
          if (enabled && fresh) {
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
    }),
  };
}
