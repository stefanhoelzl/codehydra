/**
 * Behavioral mock for PostHogBoundary with in-memory state.
 *
 * Stands in for the real boundary in module integration tests. It mirrors the
 * boundary's observable behavior — lazy identity, commonProps stamping, anon
 * distinctId fallback on exceptions — so assertions see the same merged shape
 * production sends. Logic lives in the matchers; state is plain data.
 *
 * @example
 * const boundary = createMockPostHogBoundary();
 * const module = createTelemetryModule({ boundary, ... });
 * // drive events through the dispatcher, then:
 * expect(boundary).toHaveCaptured("app_launched", { version: "1.0.0" });
 */

import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { PostHogBoundary } from "./posthog";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import { createSnapshot } from "../../test/state-mock";

// =============================================================================
// Types
// =============================================================================

export interface CapturedEvent {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly timestamp: number;
}

export interface IdentifyCall {
  readonly distinctId: string;
  readonly properties: Record<string, unknown>;
  readonly timestamp: number;
}

export interface PostHogBoundaryMockState extends MockState {
  /** All capture() + captureException() events, with commonProps stamped in. */
  readonly capturedEvents: readonly CapturedEvent[];
  /** All identify() calls. */
  readonly identifyCalls: readonly IdentifyCall[];
  /** Number of flush() calls. */
  readonly flushCount: number;
  /** Whether shutdown() has been called. */
  readonly shutdownCalled: boolean;

  reset(): void;
  snapshot(): Snapshot;
  toString(): string;
}

export type MockPostHogBoundary = PostHogBoundary & MockWithState<PostHogBoundaryMockState>;

// =============================================================================
// State Implementation
// =============================================================================

class PostHogBoundaryMockStateImpl implements PostHogBoundaryMockState {
  private _capturedEvents: CapturedEvent[] = [];
  private _identifyCalls: IdentifyCall[] = [];
  private _flushCount = 0;
  private _shutdownCalled = false;

  get capturedEvents(): readonly CapturedEvent[] {
    return [...this._capturedEvents];
  }
  get identifyCalls(): readonly IdentifyCall[] {
    return [...this._identifyCalls];
  }
  get flushCount(): number {
    return this._flushCount;
  }
  get shutdownCalled(): boolean {
    return this._shutdownCalled;
  }

  addEvent(event: CapturedEvent): void {
    this._capturedEvents.push(event);
  }
  addIdentify(call: IdentifyCall): void {
    this._identifyCalls.push(call);
  }
  markFlush(): void {
    this._flushCount += 1;
  }
  markShutdown(): void {
    this._shutdownCalled = true;
  }

  reset(): void {
    this._capturedEvents = [];
    this._identifyCalls = [];
    this._flushCount = 0;
    this._shutdownCalled = false;
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    const events = this._capturedEvents
      .map((e) => `  ${e.event}: ${JSON.stringify(e.properties)}`)
      .join("\n");
    const identifies = this._identifyCalls
      .map((c) => `  ${c.distinctId}: ${JSON.stringify(c.properties)}`)
      .join("\n");
    return [
      `PostHogBoundary (flushes: ${this._flushCount}, shutdown: ${this._shutdownCalled})`,
      `Events (${this._capturedEvents.length}):`,
      events || "  (none)",
      `Identify (${this._identifyCalls.length}):`,
      identifies || "  (none)",
    ].join("\n");
  }
}

// =============================================================================
// Factory
// =============================================================================

/** Create a behavioral mock PostHogBoundary for module integration tests. */
export function createMockPostHogBoundary(): MockPostHogBoundary {
  const state = new PostHogBoundaryMockStateImpl();
  let distinctId: string | null = null;
  let commonProps: Record<string, unknown> = {};

  const boundary: PostHogBoundary = {
    configure(opts): void {
      if (opts.distinctId !== undefined) distinctId = opts.distinctId;
      if (opts.commonProps !== undefined) commonProps = opts.commonProps;
    },

    capture(event, properties): void {
      if (!distinctId) return;
      state.addEvent({
        distinctId,
        event,
        properties: { ...commonProps, ...properties },
        timestamp: Date.now(),
      });
    },

    captureException(error, properties): void {
      const err = error instanceof Error ? error : new Error(String(error));
      const id = distinctId ?? randomUUID();
      state.addEvent({
        distinctId: id,
        event: "$exception",
        properties: {
          $exception_list: [{ type: err.name, value: err.message }],
          ...commonProps,
          ...properties,
        },
        timestamp: Date.now(),
      });
    },

    identify(properties): void {
      if (!distinctId) return;
      state.addIdentify({ distinctId, properties, timestamp: Date.now() });
    },

    async flush(): Promise<void> {
      state.markFlush();
    },

    async shutdown(): Promise<void> {
      state.markShutdown();
    },
  };

  return Object.assign(boundary, { $: state });
}

// =============================================================================
// Custom Matchers
// =============================================================================

interface PostHogBoundaryMatchers {
  /** Assert an event was captured (optionally with partially-matching props). */
  toHaveCaptured(eventName: string, properties?: Record<string, unknown>): void;
  /** Assert an exception ($exception) event was captured. */
  toHaveCapturedError(): void;
  /** Assert shutdown() was called. */
  toHaveBeenShutdown(): void;
}

declare module "vitest" {
  interface Assertion<T> extends PostHogBoundaryMatchers {}
}

export const postHogBoundaryMatchers: MatcherImplementationsFor<
  MockPostHogBoundary,
  PostHogBoundaryMatchers
> = {
  toHaveCaptured(received, eventName, properties?) {
    const events = received.$.capturedEvents;
    const matchingEvent = events.find((e) => {
      if (e.event !== eventName) return false;
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          const actual = e.properties[key];
          if (typeof value === "object" && value !== null) {
            if (JSON.stringify(actual) !== JSON.stringify(value)) return false;
          } else if (actual !== value) {
            return false;
          }
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
    const errorEvent = received.$.capturedEvents.find((e) => e.event === "$exception");
    if (!errorEvent) {
      const eventsList =
        received.$.capturedEvents.map((e) => `  - ${e.event}`).join("\n") || "  (none)";
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
        message: () => `Expected boundary to have been shut down, but shutdown() was not called`,
      };
    }
    return {
      pass: true,
      message: () => `Expected boundary not to have been shut down, but shutdown() was called`,
    };
  },
};

expect.extend(postHogBoundaryMatchers);
