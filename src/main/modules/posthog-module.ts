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
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { IntentModule } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import { APP_START_OPERATION_ID } from "../operations/app-start";
import { APP_SHUTDOWN_OPERATION_ID } from "../operations/app-shutdown";
import { EVENT_WORKSPACE_CREATED, type WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_APP_RESUMED } from "../operations/app-resume";
import { configBoolean, configString } from "../../services/config/config-definition";
import type { ConfigService } from "../../services/config/config-service";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { BuildInfo } from "../../services/platform/build-info";
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
  readonly configService: ConfigService;
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
    },
  };
}
