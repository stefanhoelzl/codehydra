/**
 * PosthogModule - Lifecycle module for PostHog analytics capture and shutdown.
 *
 * Hooks:
 * - app:start → "register-config": registers telemetry config definitions
 * - app:start → "start": generates distinct ID if needed, captures "app_launched" event
 * - app:shutdown → "stop": flushes and shuts down PostHog client (best-effort)
 *
 * Events:
 * - config:updated: configures PostHog client when telemetry values arrive,
 *   registers error handlers when telemetry.enabled is true
 * - workspace:created: captures "workspace_created" for new workspaces (not reopened)
 * - app:resumed: captures "app_resume" on system wake from sleep/hibernate
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { RegisterConfigResult } from "../operations/app-start";
import type { ConfigUpdatedEvent } from "../operations/config-set-values";
import type { ConfigSetValuesIntent } from "../operations/config-set-values";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { INTENT_CONFIG_SET_VALUES, EVENT_CONFIG_UPDATED } from "../operations/config-set-values";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_APP_RESUMED } from "../operations/app-resume";
import { configBoolean, configString } from "../../services/config/config-definition";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
import type { Dispatcher } from "../intents/infrastructure/dispatcher";
import type { ConfigAgentType } from "../../services/config/config-values";
import type { Logger } from "../../services/logging";

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

/** Maximum stack frames to include */
const MAX_STACK_FRAMES = 10;

/** Maximum stack string length */
const MAX_STACK_LENGTH = 2000;

/**
 * Create the default PostHog client using posthog-node SDK.
 */
function createDefaultPostHogClient(apiKey: string, options: { host: string }): PostHogClient {
  return new PostHog(apiKey, options);
}

interface PosthogModuleDeps {
  readonly platformInfo: PlatformInfo;
  readonly buildInfo: BuildInfo;
  readonly dispatcher: Dispatcher;
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

  // PostHog client state
  let client: PostHogClient | null = null;
  let distinctId: string | null = null;
  let enabled = false;
  let configured = false;

  // Config tracking state
  let configuredAgent: ConfigAgentType | undefined;
  let telemetryEnabled: boolean | undefined;
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

    const sanitizedStack = sanitizeStack(error.stack);

    const properties = {
      message: error.message,
      stack: sanitizedStack,
      version: deps.buildInfo.version,
    };

    deps.logger.info("Telemetry error event", { message: error.message });

    client.capture({
      distinctId,
      event: "error",
      properties,
    });
  }

  function sanitizeStack(stack: string | undefined): string | undefined {
    if (!stack) {
      return undefined;
    }

    const homeDir = deps.platformInfo.homeDir;
    const homeDirEscaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const homeDirRegex = new RegExp(homeDirEscaped.replace(/\\\\/g, "[\\\\/]"), "gi");

    const lines = stack.split("\n");
    const limitedLines = lines.slice(0, MAX_STACK_FRAMES + 1); // +1 for error message line

    const sanitizedLines = limitedLines.map((line) => {
      let sanitized = line;
      sanitized = sanitized.replace(homeDirRegex, "<home>");
      sanitized = sanitized.replace(/\?[^\s)]+/g, "");
      return sanitized;
    });

    let result = sanitizedLines.join("\n");

    if (result.length > MAX_STACK_LENGTH) {
      result = result.substring(0, MAX_STACK_LENGTH) + "...";
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Module helpers
  // ---------------------------------------------------------------------------

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
          handler: async (): Promise<void> => {
            // Generate distinctId if needed (after init has loaded stored config)
            if (telemetryEnabled && !distinctId) {
              const newId = generateDistinctId();
              if (newId) {
                configure({
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
      [EVENT_CONFIG_UPDATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
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

          // Configure PostHog client when relevant values arrive
          if (telemetryEnabled !== undefined) {
            configure({
              enabled: telemetryEnabled,
              distinctId: distinctId ?? undefined,
              agent: configuredAgent ?? undefined,
            });

            // Register error handlers when telemetry is enabled
            if (telemetryEnabled) {
              registerErrorHandlers();
            }
          }
        },
      },
    },
  };
}
