/**
 * Behavioral mock for PostHog client with in-memory state.
 *
 * Provides a stateful mock that simulates PostHog behavior:
 * - In-memory event storage
 * - Shutdown tracking
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const { factory, getMock } = createMockPostHogClientFactory();
 * const service = new PostHogTelemetryService({ postHogClientFactory: factory, ... });
 *
 * service.capture('app_launched', { version: '1.0.0' });
 * expect(getMock()).toHaveCaptured('app_launched');
 */

import { expect } from "vitest";
import type { PostHogClient, PostHogClientFactory } from "./types";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// Types
// =============================================================================

/**
 * Captured event in the mock.
 */
export interface CapturedEvent {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: Record<string, unknown> | undefined;
  readonly timestamp: number;
}

/**
 * State interface for the PostHog client mock.
 */
export interface PostHogClientMockState extends MockState {
  /** All captured events */
  readonly capturedEvents: readonly CapturedEvent[];

  /** Whether shutdown() has been called */
  readonly shutdownCalled: boolean;

  /** Reset state for next test */
  reset(): void;

  snapshot(): Snapshot;
  toString(): string;
}

/**
 * PostHog client with behavioral mock state access via `$` property.
 */
export type MockPostHogClient = PostHogClient & MockWithState<PostHogClientMockState>;

// =============================================================================
// State Implementation
// =============================================================================

class PostHogClientMockStateImpl implements PostHogClientMockState {
  private _capturedEvents: CapturedEvent[] = [];
  private _shutdownCalled: boolean = false;

  get capturedEvents(): readonly CapturedEvent[] {
    return [...this._capturedEvents];
  }

  get shutdownCalled(): boolean {
    return this._shutdownCalled;
  }

  addEvent(event: CapturedEvent): void {
    this._capturedEvents.push(event);
  }

  markShutdown(): void {
    this._shutdownCalled = true;
  }

  reset(): void {
    this._capturedEvents = [];
    this._shutdownCalled = false;
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    const events = this._capturedEvents
      .map((e) => `  ${e.event}: ${JSON.stringify(e.properties ?? {})}`)
      .join("\n");
    return [
      `PostHogClient (shutdown: ${this._shutdownCalled})`,
      `Events (${this._capturedEvents.length}):`,
      events || "  (none)",
    ].join("\n");
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Result of createMockPostHogClientFactory.
 */
export interface MockPostHogClientFactoryResult {
  /** Factory function to pass to TelemetryServiceDeps */
  factory: PostHogClientFactory;

  /**
   * Get the mock client instance.
   * Returns null if factory hasn't been called yet.
   */
  getMock(): MockPostHogClient | null;
}

/**
 * Create a mock PostHog client factory for testing.
 *
 * @example
 * const { factory, getMock } = createMockPostHogClientFactory();
 * const service = new PostHogTelemetryService({
 *   postHogClientFactory: factory,
 *   apiKey: 'test-key',
 *   ...
 * });
 *
 * service.capture('app_launched', { version: '1.0.0' });
 *
 * const mock = getMock();
 * expect(mock).toHaveCaptured('app_launched');
 */
export function createMockPostHogClientFactory(): MockPostHogClientFactoryResult {
  let mockClient: MockPostHogClient | null = null;

  const factory: PostHogClientFactory = (_apiKey: string, _options: { host: string }) => {
    const state = new PostHogClientMockStateImpl();

    const client: PostHogClient = {
      capture(params: {
        distinctId: string;
        event: string;
        properties?: Record<string, unknown>;
      }): void {
        state.addEvent({
          distinctId: params.distinctId,
          event: params.event,
          properties: params.properties,
          timestamp: Date.now(),
        });
      },

      async shutdown(): Promise<void> {
        state.markShutdown();
      },
    };

    mockClient = Object.assign(client, { $: state });
    return mockClient;
  };

  return {
    factory,
    getMock: () => mockClient,
  };
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Custom matchers for PostHog client mock assertions.
 */
interface PostHogClientMatchers {
  /**
   * Assert that an event was captured.
   *
   * @param eventName - Event name to check
   * @param properties - Optional properties to match (partial match)
   */
  toHaveCaptured(eventName: string, properties?: Record<string, unknown>): void;

  /**
   * Assert that an error event was captured.
   */
  toHaveCapturedError(): void;

  /**
   * Assert that shutdown was called.
   */
  toHaveBeenShutdown(): void;
}

declare module "vitest" {
  interface Assertion<T> extends PostHogClientMatchers {}
}

export const postHogClientMatchers: MatcherImplementationsFor<
  MockPostHogClient,
  PostHogClientMatchers
> = {
  toHaveCaptured(received, eventName, properties?) {
    const events = received.$.capturedEvents;
    const matchingEvent = events.find((e) => {
      if (e.event !== eventName) return false;
      if (properties) {
        // Partial match on properties
        for (const [key, value] of Object.entries(properties)) {
          if (e.properties?.[key] !== value) return false;
        }
      }
      return true;
    });

    if (!matchingEvent) {
      const eventsList = events.map((e) => `  - ${e.event}`).join("\n") || "  (none)";
      return {
        pass: false,
        message: () =>
          properties
            ? `Expected to capture event "${eventName}" with properties ${JSON.stringify(properties)}, but it was not found.\nCaptured events:\n${eventsList}`
            : `Expected to capture event "${eventName}", but it was not found.\nCaptured events:\n${eventsList}`,
      };
    }

    return {
      pass: true,
      message: () => `Expected not to capture event "${eventName}", but it was found`,
    };
  },

  toHaveCapturedError(received) {
    const events = received.$.capturedEvents;
    const errorEvent = events.find((e) => e.event === "error");

    if (!errorEvent) {
      const eventsList = events.map((e) => `  - ${e.event}`).join("\n") || "  (none)";
      return {
        pass: false,
        message: () =>
          `Expected to capture an error event, but none was found.\nCaptured events:\n${eventsList}`,
      };
    }

    return {
      pass: true,
      message: () => `Expected not to capture an error event, but one was found`,
    };
  },

  toHaveBeenShutdown(received) {
    if (!received.$.shutdownCalled) {
      return {
        pass: false,
        message: () =>
          `Expected PostHog client to have been shut down, but shutdown() was not called`,
      };
    }

    return {
      pass: true,
      message: () =>
        `Expected PostHog client not to have been shut down, but shutdown() was called`,
    };
  },
};

// Register matchers with expect
expect.extend(postHogClientMatchers);
