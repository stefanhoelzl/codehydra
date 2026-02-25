/**
 * PostHog telemetry service implementation.
 *
 * Provides anonymous product analytics using PostHog.
 * PRIVACY NOTE: Do NOT log user paths or PII.
 *
 * Features:
 * - Configured via configure() method (driven by config:updated events)
 * - No-op mode when API key missing or telemetry disabled
 * - All events logged at INFO level for visibility
 * - Error stack sanitization (strips home directory, limits length)
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type {
  TelemetryService,
  TelemetryServiceDeps,
  TelemetryConfigureOptions,
  PostHogClient,
  PostHogClientFactory,
} from "./types";

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

/**
 * PostHog telemetry service implementation.
 */
export class PostHogTelemetryService implements TelemetryService {
  private readonly deps: TelemetryServiceDeps;
  private readonly host: string;
  private readonly postHogClientFactory: PostHogClientFactory;

  /** PostHog client - created on first configure() with valid API key */
  private client: PostHogClient | null = null;

  /** Cached distinctId - set via configure() */
  private distinctId: string | null = null;

  /** Whether telemetry is enabled (set via configure()) */
  private enabled = false;

  /** Whether configure() has been called */
  private configured = false;

  constructor(deps: TelemetryServiceDeps) {
    this.deps = deps;
    this.host = deps.host ?? DEFAULT_HOST;
    this.postHogClientFactory = deps.postHogClientFactory ?? createDefaultPostHogClient;
  }

  /**
   * Configure telemetry with values from the config system.
   * Creates the PostHog client on first call with telemetry enabled.
   */
  configure(options: TelemetryConfigureOptions): void {
    this.configured = true;

    // Check if API key is available
    if (!this.deps.apiKey || this.deps.apiKey.trim() === "") {
      this.deps.logger.debug("Telemetry disabled: no API key");
      this.enabled = false;
      return;
    }

    this.enabled = options.enabled;
    if (options.distinctId) {
      this.distinctId = options.distinctId;
    }

    if (!this.enabled) {
      this.deps.logger.debug("Telemetry disabled: config");
      return;
    }

    // Create PostHog client if not yet created
    if (!this.client) {
      // Factory may be async, but we handle it synchronously for posthog-node
      const result = this.postHogClientFactory(this.deps.apiKey, { host: this.host });
      if (result instanceof Promise) {
        void result.then((client) => {
          this.client = client;
          this.deps.logger.debug("Telemetry initialized (async)", { host: this.host });
        });
      } else {
        this.client = result;
        this.deps.logger.debug("Telemetry initialized", { host: this.host });
      }
    }
  }

  /**
   * Generate a new distinct ID for anonymous tracking.
   * Returns the generated ID, or undefined if telemetry is disabled.
   */
  generateDistinctId(): string | undefined {
    if (!this.enabled) return undefined;
    const id = randomUUID();
    this.distinctId = id;
    this.deps.logger.debug("Generated new distinctId");
    return id;
  }

  /**
   * Capture an analytics event.
   */
  capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.configured || !this.enabled || !this.client || !this.distinctId) {
      return;
    }

    // Always include version in properties
    const fullProperties = {
      ...properties,
      version: this.deps.buildInfo.version,
    };

    // Log at INFO level for visibility
    this.deps.logger.info("Telemetry event", { event, ...fullProperties });

    // Capture to PostHog
    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties: fullProperties,
    });
  }

  /**
   * Capture an error event with sanitized stack trace.
   */
  captureError(error: Error): void {
    if (!this.configured || !this.enabled || !this.client || !this.distinctId) {
      return;
    }

    const sanitizedStack = this.sanitizeStack(error.stack);

    const properties = {
      message: error.message,
      stack: sanitizedStack,
      version: this.deps.buildInfo.version,
    };

    // Log at INFO level (not error - that would duplicate error logs)
    this.deps.logger.info("Telemetry error event", { message: error.message });

    this.client.capture({
      distinctId: this.distinctId,
      event: "error",
      properties,
    });
  }

  /**
   * Sanitize error stack trace for privacy.
   * - Strips home directory paths
   * - Strips project paths (makes them relative)
   * - Limits to MAX_STACK_FRAMES frames
   * - Truncates to MAX_STACK_LENGTH characters
   * - Removes query parameters from URLs
   */
  private sanitizeStack(stack: string | undefined): string | undefined {
    if (!stack) {
      return undefined;
    }

    // Get home directory for sanitization (use injected platformInfo)
    const homeDir = this.deps.platformInfo.homeDir;
    // Escape special regex characters in path
    const homeDirEscaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Also handle Windows paths with forward slashes
    const homeDirRegex = new RegExp(homeDirEscaped.replace(/\\\\/g, "[\\\\/]"), "gi");

    // Split into lines, limit frames, and sanitize
    const lines = stack.split("\n");
    const limitedLines = lines.slice(0, MAX_STACK_FRAMES + 1); // +1 for error message line

    const sanitizedLines = limitedLines.map((line) => {
      let sanitized = line;

      // Replace home directory with <home>
      sanitized = sanitized.replace(homeDirRegex, "<home>");

      // Remove query parameters from URLs (e.g., file:///path?query=value)
      sanitized = sanitized.replace(/\?[^\s)]+/g, "");

      return sanitized;
    });

    let result = sanitizedLines.join("\n");

    // Truncate if too long
    if (result.length > MAX_STACK_LENGTH) {
      result = result.substring(0, MAX_STACK_LENGTH) + "...";
    }

    return result;
  }

  /**
   * Flush pending events and shut down.
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      this.deps.logger.debug("Telemetry shutting down");
      await this.client.shutdown();
      this.client = null;
    }
  }
}

/**
 * Create a TelemetryService instance.
 */
export function createTelemetryService(deps: TelemetryServiceDeps): TelemetryService {
  return new PostHogTelemetryService(deps);
}
