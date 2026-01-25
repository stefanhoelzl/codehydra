/**
 * Telemetry service types and interfaces.
 *
 * Provides types for anonymous product analytics via PostHog.
 * PRIVACY NOTE: No user paths or PII should ever be collected.
 */

import type { BuildInfo } from "../platform/build-info";
import type { PlatformInfo } from "../platform/platform-info";
import type { ConfigService } from "../config/config-service";
import type { Logger } from "../logging";

/**
 * PostHog client interface (subset we use).
 * Extracted from posthog-node for dependency injection and testing.
 */
export interface PostHogClient {
  /**
   * Capture an analytics event.
   */
  capture(params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;

  /**
   * Flush pending events and shut down the client.
   */
  shutdown(): Promise<void>;
}

/**
 * Factory function to create a PostHog client.
 * Injected for testability - tests provide a mock factory.
 * Can be sync (for testing) or async (for lazy-loading the SDK).
 */
export type PostHogClientFactory = (
  apiKey: string,
  options: { host: string }
) => PostHogClient | Promise<PostHogClient>;

/**
 * Dependencies for TelemetryService.
 * Follows the project's dependency injection pattern.
 */
export interface TelemetryServiceDeps {
  readonly buildInfo: BuildInfo;
  readonly platformInfo: PlatformInfo;
  readonly configService: ConfigService;
  readonly logger: Logger;
  /** PostHog API key. If undefined/empty, telemetry is disabled. */
  readonly apiKey?: string | undefined;
  /** PostHog host URL. Defaults to EU region. */
  readonly host?: string | undefined;
  /** Factory to create PostHog client. Defaults to real posthog-node. */
  readonly postHogClientFactory?: PostHogClientFactory | undefined;
}

/**
 * Telemetry service interface for product analytics.
 *
 * All events are also logged at INFO level for visibility.
 * Service operates in no-op mode when:
 * - API key is missing/empty
 * - Telemetry is disabled in config
 */
export interface TelemetryService {
  /**
   * Capture an analytics event.
   * Events are logged at INFO level.
   *
   * @param event - Event name (e.g., "app_launched")
   * @param properties - Optional event properties
   */
  capture(event: string, properties?: Record<string, unknown>): void;

  /**
   * Capture an error event with sanitized stack trace.
   * Stack traces have user paths stripped for privacy.
   *
   * @param error - Error to capture
   */
  captureError(error: Error): void;

  /**
   * Flush pending events and shut down.
   * Call this before app exit to ensure events are sent.
   */
  shutdown(): Promise<void>;
}
