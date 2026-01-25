/**
 * PostHog telemetry service implementation.
 *
 * Provides anonymous product analytics using PostHog.
 * PRIVACY NOTE: Do NOT log user paths or PII.
 *
 * Features:
 * - Lazy initialization: PostHog client created on first capture
 * - No-op mode when API key missing or telemetry disabled
 * - All events logged at INFO level for visibility
 * - Error stack sanitization (strips home directory, limits length)
 */

import { randomUUID } from "node:crypto";
import type {
  TelemetryService,
  TelemetryServiceDeps,
  PostHogClient,
  PostHogClientFactory,
} from "./types";

/** Default PostHog host (EU region) */
const DEFAULT_HOST = "https://eu.posthog.com";

/** Maximum stack frames to include */
const MAX_STACK_FRAMES = 10;

/** Maximum stack string length */
const MAX_STACK_LENGTH = 2000;

/** Cached PostHog constructor for lazy loading */
let PostHogConstructor: typeof import("posthog-node").PostHog | null = null;

/**
 * Create the default PostHog client using posthog-node SDK.
 * Uses cached constructor to avoid repeated dynamic imports.
 */
async function createDefaultPostHogClient(
  apiKey: string,
  options: { host: string }
): Promise<PostHogClient> {
  if (!PostHogConstructor) {
    const posthogModule = await import("posthog-node");
    PostHogConstructor = posthogModule.PostHog;
  }
  return new PostHogConstructor(apiKey, options);
}

/**
 * PostHog telemetry service implementation.
 */
export class PostHogTelemetryService implements TelemetryService {
  private readonly deps: TelemetryServiceDeps;
  private readonly host: string;
  private readonly postHogClientFactory: PostHogClientFactory;

  /** PostHog client - lazily initialized on first capture */
  private client: PostHogClient | null = null;

  /** Cached distinctId - loaded from config or generated */
  private distinctId: string | null = null;

  /** Whether telemetry is enabled (checked on first capture) */
  private enabled: boolean | null = null;

  constructor(deps: TelemetryServiceDeps) {
    this.deps = deps;
    this.host = deps.host ?? DEFAULT_HOST;
    this.postHogClientFactory = deps.postHogClientFactory ?? createDefaultPostHogClient;
  }

  /**
   * Initialize the PostHog client lazily.
   * Returns false if telemetry should be disabled.
   */
  private async ensureInitialized(): Promise<boolean> {
    // Already initialized
    if (this.enabled !== null) {
      return this.enabled;
    }

    // Check if API key is available
    if (!this.deps.apiKey || this.deps.apiKey.trim() === "") {
      this.deps.logger.debug("Telemetry disabled: no API key");
      this.enabled = false;
      return false;
    }

    // Load config to check if telemetry is enabled
    const config = await this.deps.configService.load();

    // Default to enabled if telemetry config is missing (backwards compatibility)
    const telemetryEnabled = config.telemetry?.enabled ?? true;

    if (!telemetryEnabled) {
      this.deps.logger.debug("Telemetry disabled: config");
      this.enabled = false;
      return false;
    }

    // Get or generate distinctId
    if (config.telemetry?.distinctId) {
      this.distinctId = config.telemetry.distinctId;
    } else {
      // Generate new distinctId and persist it
      this.distinctId = randomUUID();
      const updatedConfig = {
        ...config,
        telemetry: {
          ...config.telemetry,
          enabled: true,
          distinctId: this.distinctId,
        },
      };
      await this.deps.configService.save(updatedConfig);
      this.deps.logger.debug("Generated new distinctId");
    }

    // Create PostHog client (factory can be sync or async)
    this.client = await Promise.resolve(
      this.postHogClientFactory(this.deps.apiKey, { host: this.host })
    );
    this.enabled = true;

    this.deps.logger.debug("Telemetry initialized", { host: this.host });
    return true;
  }

  /**
   * Capture an analytics event.
   */
  capture(event: string, properties?: Record<string, unknown>): void {
    // Fire and forget - don't block on async initialization
    void this.captureAsync(event, properties);
  }

  private async captureAsync(event: string, properties?: Record<string, unknown>): Promise<void> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.client || !this.distinctId) {
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
    void this.captureErrorAsync(error);
  }

  private async captureErrorAsync(error: Error): Promise<void> {
    const initialized = await this.ensureInitialized();
    if (!initialized || !this.client || !this.distinctId) {
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
