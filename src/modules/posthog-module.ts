/**
 * PosthogModule - Lifecycle module for PostHog analytics capture and shutdown.
 *
 * Hooks:
 * - app:start → "start": configures PostHog, generates distinct ID if needed, captures "app_launched"
 * - app:shutdown → "stop": flushes and shuts down PostHog client (best-effort)
 *
 * Events:
 * - workspace:created: captures "workspace_created" for new workspaces (not reopened)
 * - app:resumed: captures "app_resume" on system wake from sleep/hibernate
 * - bug-report:submitted: captures "bug_report" (always sends, even when telemetry disabled)
 */

import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { PostHog } from "posthog-node";
import type { StateService } from "../boundaries/platform/state-service";
import type { StateMigrationRegistry } from "./state-module";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../intents/app-shutdown";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../intents/open-workspace";
import { EVENT_APP_RESUMED } from "../intents/app-resume";
import {
  EVENT_BUG_REPORT_SUBMITTED,
  type BugReportSubmittedEvent,
} from "../intents/submit-bug-report";
import { storeBoolean, storeString } from "../boundaries/platform/store-definition";
import type { Config, ConfigAgentType } from "../boundaries/platform/config";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";

// =============================================================================
// Constants
// =============================================================================

/**
 * Per-field compressed cap for log payloads on the bug_report event. With two
 * log streams (app + electron) this gives ~900 KB combined, leaving ~148 KB
 * under PostHog's 1 MB hard cap for description, metadata, and SDK overhead.
 */
const LOG_FIELD_COMPRESSED_CAP = 450_000;
const COMPRESS_SAFETY_FACTOR = 0.95;

/**
 * Compress `raw` with gzip+base64 and, if the result exceeds the cap, trim
 * the raw input from the front (keeping the most recent tail) and re-compress.
 * Each iteration scales the raw size down by the observed overshoot ratio
 * with a safety margin, so we usually converge in 1–2 passes.
 */
function compressAndTrim(raw: string): { compressed: string; rawBytesKept: number } {
  let kept = raw;
  let compressed = kept ? gzipSync(kept).toString("base64") : "";
  while (compressed.length > LOG_FIELD_COMPRESSED_CAP && kept.length > 0) {
    const scaled = Math.floor(
      (kept.length * LOG_FIELD_COMPRESSED_CAP * COMPRESS_SAFETY_FACTOR) / compressed.length
    );
    // Guarantee progress even if rounding/SAFETY_FACTOR don't shrink enough
    const nextLen = Math.max(0, Math.min(scaled, kept.length - 1));
    kept = nextLen > 0 ? kept.slice(kept.length - nextLen) : "";
    compressed = kept ? gzipSync(kept).toString("base64") : "";
  }
  return { compressed, rawBytesKept: kept.length };
}

// =============================================================================
// Types
// =============================================================================

/**
 * PostHog client interface (subset we use).
 * Extracted from posthog-node for dependency injection and testing.
 */
export interface PostHogClient {
  capture(params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;

  captureException(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string | number, unknown>
  ): void;

  /**
   * Update person properties via PostHog's $set. `properties` is sent as the
   * $set payload (this matches posthog-node's `identify` behavior).
   */
  identify(params: { distinctId: string; properties: Record<string, unknown> }): void;

  shutdown(): Promise<void>;
}

/**
 * Factory function to create a PostHog client.
 * Injected for testability - tests provide a mock factory.
 */
export type PostHogClientFactory = (
  apiKey: string,
  options: { host: string }
) => PostHogClient | Promise<PostHogClient>;

// =============================================================================
// Module
// =============================================================================

/** Default PostHog host (EU region) */
const DEFAULT_HOST = "https://eu.posthog.com";

/**
 * Create the default PostHog client using posthog-node SDK.
 */
function createDefaultPostHogClient(apiKey: string, options: { host: string }): PostHogClient {
  return new PostHog(apiKey, options);
}

interface PosthogModuleDeps {
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly configService: Config;
  /** Persisted app state (state.json) — owns the auto-generated distinct-id. */
  readonly stateService: StateService;
  /** Registry the state module drains to migrate distinct-id out of config.json. */
  readonly stateMigrations: StateMigrationRegistry;
  /** Accessor for the user's agent selection (registered in the composition root). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
  readonly logger: Logger;
  /** PostHog API key. If undefined/empty, telemetry is disabled. */
  readonly apiKey?: string | undefined;
  /** PostHog host URL. Defaults to EU region. */
  readonly host?: string | undefined;
  /** Factory to create PostHog client. Defaults to real posthog-node. */
  readonly postHogClientFactory?: PostHogClientFactory | undefined;
}

export function createPosthogModule(deps: PosthogModuleDeps): IntentModule {
  const host = deps.host ?? DEFAULT_HOST;
  const clientFactory = deps.postHogClientFactory ?? createDefaultPostHogClient;

  // Register config keys
  const telemetryEnabledConfig = deps.configService.register("telemetry.enabled", {
    default: true,
    description: "Enable telemetry (false in dev/unpackaged)",
    ...storeBoolean(),
    computedDefault: (ctx) => (ctx.isDevelopment || !ctx.isPackaged ? false : undefined),
  });
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

  // PostHog client state
  let client: PostHogClient | null = null;
  let distinctId: string | null = null;
  let enabled = false;
  let configured = false;
  let errorHandlersRegistered = false;

  // ---------------------------------------------------------------------------
  // Inlined service logic
  // ---------------------------------------------------------------------------

  function configure(options: {
    enabled: boolean;
    distinctId?: string | undefined;
    agent?: string | undefined;
  }): void {
    configured = true;

    if (!deps.apiKey || deps.apiKey.trim() === "") {
      deps.logger.debug("Telemetry disabled: no API key");
      enabled = false;
      return;
    }

    enabled = options.enabled;
    if (options.distinctId) {
      distinctId = options.distinctId;
    }

    if (!enabled) {
      deps.logger.debug("Telemetry disabled: config");
      return;
    }

    // Create PostHog client if not yet created
    if (!client) {
      const result = clientFactory(deps.apiKey, { host });
      if (result instanceof Promise) {
        void result.then((c) => {
          client = c;
          deps.logger.debug("Telemetry initialized (async)", { host });
        });
      } else {
        client = result;
        deps.logger.debug("Telemetry initialized", { host });
      }
    }
  }

  function generateDistinctId(): string | undefined {
    if (!enabled) return undefined;
    const id = randomUUID();
    distinctId = id;
    deps.logger.debug("Generated new distinctId");
    return id;
  }

  function capture(event: string, properties?: Record<string, unknown>): void {
    if (!configured || !enabled || !client || !distinctId) {
      return;
    }

    const fullProperties = {
      ...properties,
      version: deps.buildInfo.version,
    };

    deps.logger.info("Telemetry event", { event, ...fullProperties });

    client.capture({
      distinctId,
      event,
      properties: fullProperties,
    });
  }

  function captureError(error: Error): void {
    if (!configured || !enabled || !client || !distinctId) {
      return;
    }

    deps.logger.info("Telemetry error event", { message: error.message });

    client.captureException(error, distinctId, {
      version: deps.buildInfo.version,
    });
  }

  /**
   * Capture a bug report event. Always sends, even when telemetry is disabled.
   * Bug reports are explicit user actions, not passive telemetry.
   * No-op only if API key is missing.
   */
  function captureBugReport(description: string, logs: string, electronLogs: string): void {
    if (!deps.apiKey || deps.apiKey.trim() === "") return;

    // Lazily create client if telemetry was disabled
    if (!client) {
      const result = clientFactory(deps.apiKey, { host });
      if (result instanceof Promise) {
        void result.then((c) => {
          client = c;
          // Retry after async client creation
          captureBugReport(description, logs, electronLogs);
        });
        return;
      }
      client = result;
    }

    // Use existing distinctId or generate an anonymous one (not persisted)
    const id = distinctId ?? randomUUID();

    // Create a synthetic Error so the SDK formats it as $exception_list
    const bugError = new Error(description);
    bugError.name = "BugReport";
    bugError.stack = ""; // No meaningful stack trace for user reports

    deps.logger.info("Bug report captured");

    // PostHog discards events larger than 1 MB. We carry two log streams (app
    // log + Chromium native log) and cap each independently at 450 KB
    // compressed, leaving ~148 KB headroom under the 1 MB hard cap for
    // description + metadata + SDK overhead.
    const appLogs = compressAndTrim(logs);
    const electronLogsBlob = compressAndTrim(electronLogs);

    client.captureException(bugError, id, {
      logs: appLogs.compressed,
      logs_format: appLogs.compressed ? "gzip+base64" : "none",
      logs_raw_bytes: appLogs.rawBytesKept,
      logs_raw_bytes_dropped: logs.length - appLogs.rawBytesKept,
      electron_logs: electronLogsBlob.compressed,
      electron_logs_format: electronLogsBlob.compressed ? "gzip+base64" : "none",
      electron_logs_raw_bytes: electronLogsBlob.rawBytesKept,
      electron_logs_raw_bytes_dropped: electronLogs.length - electronLogsBlob.rawBytesKept,
      config: deps.configService.getRedactedOverrides(),
      state: deps.stateService.getRedactedOverrides(),
      ...eventProperties(),
      version: deps.buildInfo.version,
    });
  }

  // ---------------------------------------------------------------------------
  // Module helpers
  // ---------------------------------------------------------------------------

  function eventProperties(): Record<string, unknown> {
    const configuredAgent = deps.agentConfig.get();
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
      captureError(error);
    });

    // Electron uses --unhandled-rejections=warn (not throw), so unhandled
    // rejections never trigger uncaughtExceptionMonitor. Capture them directly.
    process.on("unhandledRejection", (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
      captureError(error);
    });
  }

  // ---------------------------------------------------------------------------
  // Module definition
  // ---------------------------------------------------------------------------

  return {
    name: "posthog",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            // Read config values
            const telemetryEnabled = telemetryEnabledConfig.get();
            const storedDistinctId = telemetryDistinctIdState.get();
            const configuredAgent = deps.agentConfig.get();

            if (storedDistinctId) {
              distinctId = storedDistinctId;
            }

            // Configure PostHog
            configure({
              enabled: telemetryEnabled,
              distinctId: distinctId ?? undefined,
              agent: configuredAgent ?? undefined,
            });

            if (telemetryEnabled) {
              registerErrorHandlers();
            }

            // Generate distinctId if needed
            if (telemetryEnabled && !distinctId) {
              const newId = generateDistinctId();
              if (newId) {
                configure({
                  enabled: telemetryEnabled,
                  distinctId: newId,
                  agent: configuredAgent ?? undefined,
                });
                await telemetryDistinctIdState.set(newId);
              }
            }

            if (configuredAgent !== undefined) {
              capture("app_launched", eventProperties());
            }

            // Sync current config overrides to PostHog as person properties.
            // Only `agent` mutates post-launch today, and it lands on next launch.
            if (enabled && client && distinctId) {
              client.identify({
                distinctId,
                properties: { config: deps.configService.getRedactedOverrides() },
              });
            }
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            if (client) {
              deps.logger.debug("Telemetry shutting down");
              await client.shutdown();
              client = null;
            }
          },
        },
      },
    },
    events: {
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { reopened } = (event as WorkspaceCreatedEvent).payload;
          if (!reopened) {
            capture("workspace_created", eventProperties());
          }
        },
      },
      [EVENT_APP_RESUMED]: {
        handler: async (): Promise<void> => {
          capture("app_resume", eventProperties());
        },
      },
      [EVENT_BUG_REPORT_SUBMITTED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { description, logs, electronLogs } = (event as BugReportSubmittedEvent).payload;
          captureBugReport(description, logs, electronLogs);
        },
      },
    },
  };
}
