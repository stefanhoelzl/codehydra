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
import { PostHog } from "posthog-node";
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
import { configBoolean, configString } from "../boundaries/platform/config-definition";
import type { Config } from "../boundaries/platform/config";
import type { PlatformInfo } from "../boundaries/platform/platform-info";
import type { BuildInfo } from "../boundaries/platform/build-info";
import type { ConfigAgentType } from "../boundaries/platform/config-values";
import type { Logger } from "../boundaries/platform/logging";

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
  deps.configService.register("telemetry.enabled", {
    name: "telemetry.enabled",
    default: true,
    description: "Enable telemetry (false in dev/unpackaged)",
    ...configBoolean(),
    computedDefault: (ctx) => (ctx.isDevelopment || !ctx.isPackaged ? false : undefined),
  });
  deps.configService.register("telemetry.distinct-id", {
    name: "telemetry.distinct-id",
    default: null,
    description: "Telemetry user ID (auto-generated)",
    sensitive: true,
    ...configString({ nullable: true }),
  });

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
  function captureBugReport(description: string, logs: string): void {
    if (!deps.apiKey || deps.apiKey.trim() === "") return;

    // Lazily create client if telemetry was disabled
    if (!client) {
      const result = clientFactory(deps.apiKey, { host });
      if (result instanceof Promise) {
        void result.then((c) => {
          client = c;
          // Retry after async client creation
          captureBugReport(description, logs);
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

    client.captureException(bugError, id, {
      logs,
      ...eventProperties(),
      version: deps.buildInfo.version,
    });
  }

  // ---------------------------------------------------------------------------
  // Module helpers
  // ---------------------------------------------------------------------------

  function eventProperties(): Record<string, unknown> {
    const configuredAgent = deps.configService.get("agent") as ConfigAgentType;
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
            const telemetryEnabled = deps.configService.get("telemetry.enabled") as boolean;
            const storedDistinctId = deps.configService.get("telemetry.distinct-id") as
              | string
              | null;
            const configuredAgent = deps.configService.get("agent") as ConfigAgentType;

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
                await deps.configService.set("telemetry.distinct-id", newId);
              }
            }

            if (configuredAgent !== undefined) {
              capture("app_launched", eventProperties());
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
          const { description, logs } = (event as BugReportSubmittedEvent).payload;
          captureBugReport(description, logs);
        },
      },
    },
  };
}
