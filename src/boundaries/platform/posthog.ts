/**
 * PostHogBoundary - the single abstraction over `posthog-node`.
 *
 * A pure telemetry sink. It owns the client lifecycle (lazy creation), the
 * distinct id, and a `commonProps` bag stamped onto every event/exception. It
 * NEVER decides whether to send — all gating (telemetry on/off, explicit-consent
 * reports) lives in the modules that call it, and it never reads Config/State.
 *
 * External System Access: modules MUST go through this boundary rather than
 * constructing `PostHog` directly (see CLAUDE.md External System Access Rules).
 *
 * Lifecycle:
 *   configure({ distinctId, commonProps })  // pushed in by telemetry-module @ app:start
 *   capture / captureException / identify   // lazily create the client on first use
 *   flush()                                  // force prompt delivery (user bug report)
 *   shutdown()                               // flush + close (app:shutdown, crash exit)
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { Logger } from "./logging-types";

// =============================================================================
// Low-level SDK seam
// =============================================================================

/**
 * The subset of `posthog-node` the boundary depends on. Kept as an injectable
 * seam so the boundary's own boundary-test can assert it maps calls correctly
 * without a real network client. `new PostHog(...)` satisfies this structurally.
 */
export interface PostHogSdkClient {
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

  identify(params: { distinctId: string; properties: Record<string, unknown> }): void;

  flush(): Promise<void>;

  shutdown(): Promise<void>;
}

/** Creates the low-level SDK client. Injected for testability. */
export type PostHogSdkFactory = (apiKey: string, options: { host: string }) => PostHogSdkClient;

// =============================================================================
// Boundary interface
// =============================================================================

export interface PostHogBoundary {
  /**
   * Push the distinct id and/or common properties stamped on every send.
   * `distinctId: undefined` leaves the current id unchanged (so a launch with
   * telemetry disabled can still set commonProps without an id).
   */
  configure(opts: { distinctId?: string | undefined; commonProps?: Record<string, unknown> }): void;

  /** Send a named analytics event (no-op without an api key or distinct id). */
  capture(event: string, properties?: Record<string, unknown>): void;

  /**
   * Send an exception. Uses the configured distinct id, or an anonymous one when
   * none is set (e.g. a user bug report submitted with telemetry disabled).
   */
  captureException(error: unknown, properties?: Record<string, unknown>): void;

  /** Update person properties via $set (no-op without an api key or distinct id). */
  identify(properties: Record<string, unknown>): void;

  /** Flush queued events without closing the client. */
  flush(): Promise<void>;

  /** Flush and close the client. */
  shutdown(): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

/** Default PostHog host (EU region). */
const DEFAULT_HOST = "https://eu.posthog.com";

/** Default factory: the real posthog-node client. */
function createDefaultSdkClient(apiKey: string, options: { host: string }): PostHogSdkClient {
  return new PostHog(apiKey, options);
}

export interface PostHogBoundaryDeps {
  readonly logger: Logger;
  /** PostHog API key. If undefined/empty, the boundary is a silent no-op. */
  readonly apiKey?: string | undefined;
  /** PostHog host URL. Defaults to EU region. */
  readonly host?: string | undefined;
  /** SDK factory. Defaults to real posthog-node. Injected by boundary tests. */
  readonly sdkFactory?: PostHogSdkFactory | undefined;
}

export function createPostHogBoundary(deps: PostHogBoundaryDeps): PostHogBoundary {
  const host = deps.host ?? DEFAULT_HOST;
  const sdkFactory = deps.sdkFactory ?? createDefaultSdkClient;

  let client: PostHogSdkClient | null = null;
  let distinctId: string | null = null;
  let commonProps: Record<string, unknown> = {};

  function hasApiKey(): boolean {
    return deps.apiKey !== undefined && deps.apiKey.trim() !== "";
  }

  /** Lazily create the client. Returns null when no api key is configured. */
  function ensureClient(): PostHogSdkClient | null {
    if (client) return client;
    if (!hasApiKey()) return null;
    client = sdkFactory(deps.apiKey as string, { host });
    deps.logger.debug("PostHog client created", { host });
    return client;
  }

  return {
    configure(opts): void {
      if (opts.distinctId !== undefined) {
        distinctId = opts.distinctId;
      }
      if (opts.commonProps !== undefined) {
        commonProps = opts.commonProps;
      }
    },

    capture(event, properties): void {
      const c = ensureClient();
      if (!c || !distinctId) return;
      c.capture({ distinctId, event, properties: { ...commonProps, ...properties } });
    },

    captureException(error, properties): void {
      const c = ensureClient();
      if (!c) return;
      // Anonymous id when none configured: a forced report (user bug report with
      // telemetry disabled, so no persisted id) should still carry an identity.
      const id = distinctId ?? randomUUID();
      c.captureException(error, id, { ...commonProps, ...properties });
    },

    identify(properties): void {
      const c = ensureClient();
      if (!c || !distinctId) return;
      // Person $set is intentionally NOT stamped with commonProps.
      c.identify({ distinctId, properties });
    },

    async flush(): Promise<void> {
      // Don't create a client just to flush.
      if (client) await client.flush();
    },

    async shutdown(): Promise<void> {
      if (client) {
        await client.shutdown();
        client = null;
      }
    },
  };
}
