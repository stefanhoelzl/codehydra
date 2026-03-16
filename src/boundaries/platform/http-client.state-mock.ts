/**
 * Behavioral mock for HttpClient following the mock.$ state pattern.
 *
 * Provides:
 * - Request history tracking
 * - Response configuration per URL
 * - Network error simulation
 * - Custom matchers (toHaveRequested, toHaveRequestCount, toHaveNoRequests)
 *
 * Matchers are auto-registered when this module is imported.
 */

import { expect } from "vitest";
import type { HttpClient, HttpRequestOptions } from "./network";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherResult,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// Type Definitions
// =============================================================================

/** Record of an HTTP request made through the mock. */
export interface HttpRequestRecord {
  readonly url: string;
  readonly options?: HttpRequestOptions;
  readonly timestamp: number; // Date.now() epoch ms
}

/**
 * Response configuration - stores DATA, not Response objects.
 * Fresh Response constructed on each fetch() call.
 * Supports string for text responses, Buffer/Uint8Array for binary content.
 */
export interface ConfiguredResponse {
  readonly body?: string | Buffer | Uint8Array;
  readonly status?: number; // Default: 200
  readonly headers?: Record<string, string>;
  readonly error?: Error; // Throw this instead of returning response
  readonly delayMs?: number; // Simulated delay (use with vi.useFakeTimers())
}

/** Mock state - pure data, logic in matchers. */
export interface HttpClientMockState extends MockState {
  readonly requests: readonly HttpRequestRecord[];
  readonly responses: ReadonlyMap<string, ConfiguredResponse>;
  readonly networkError: Error | null;
}

/** Mock type with state access and setup methods. */
export type MockHttpClient = HttpClient &
  MockWithState<HttpClientMockState> & {
    setResponse(url: string, config: ConfiguredResponse): void;
    simulateNetworkDown(): void;
    simulateNetworkUp(): void;
  };

/** Factory options. */
export interface MockHttpClientOptions {
  /** Pre-configured responses by exact URL. */
  responses?: Record<string, ConfiguredResponse>;
  /** Default for unconfigured URLs. Default: { status: 200, body: "" } */
  defaultResponse?: ConfiguredResponse;
}

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock HttpClient for testing.
 *
 * @example Basic usage - returns 200 OK for all requests
 * const httpClient = createMockHttpClient();
 *
 * @example Return custom default response
 * const httpClient = createMockHttpClient({
 *   defaultResponse: { body: '{"status":"ok"}', status: 200 }
 * });
 *
 * @example Configure responses per URL
 * const httpClient = createMockHttpClient({
 *   responses: {
 *     "http://127.0.0.1:8080/health": { body: "ok", status: 200 },
 *   },
 *   defaultResponse: { status: 404 },
 * });
 *
 * @example Configure responses after creation
 * const mock = createMockHttpClient();
 * mock.setResponse("http://127.0.0.1:8080/health", { body: "ok" });
 *
 * @example Simulate network down
 * const mock = createMockHttpClient();
 * mock.simulateNetworkDown();
 * await mock.fetch("http://example.com"); // throws Error
 *
 * @example Check request history
 * const mock = createMockHttpClient();
 * await mock.fetch("http://example.com/api");
 * expect(mock).toHaveRequested("http://example.com/api");
 * expect(mock).toHaveRequestCount(1);
 */
export function createMockHttpClient(options?: MockHttpClientOptions): MockHttpClient {
  // Internal mutable state
  const requests: HttpRequestRecord[] = [];
  const responses = new Map<string, ConfiguredResponse>(
    options?.responses ? Object.entries(options.responses) : []
  );
  let networkError: Error | null = null;

  const defaultResponse: ConfiguredResponse = options?.defaultResponse ?? { status: 200, body: "" };

  // Helper to record a request
  function recordRequest(url: string, opts?: HttpRequestOptions): void {
    const record: HttpRequestRecord = {
      url,
      timestamp: Date.now(),
    };
    if (opts !== undefined) {
      (record as { options: HttpRequestOptions }).options = opts;
    }
    requests.push(record);
  }

  // Helper to wait with timeout and abort signal support
  async function waitWithTimeoutAndAbort(
    delayMs: number,
    timeout: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Timeout fires AFTER the specified duration
      const effectiveTimeout = timeout ?? Infinity;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let delayId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (delayId !== undefined) clearTimeout(delayId);
        signal?.removeEventListener("abort", abortHandler);
      };

      const abortHandler = () => {
        cleanup();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      // If timeout is less than delay, reject after timeout
      if (effectiveTimeout < delayMs) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }, effectiveTimeout);
      } else {
        // Otherwise resolve after delay
        delayId = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs);
      }
    });
  }

  // State object implementing MockState
  const state: HttpClientMockState = {
    get requests(): readonly HttpRequestRecord[] {
      return requests;
    },
    get responses(): ReadonlyMap<string, ConfiguredResponse> {
      return responses;
    },
    get networkError(): Error | null {
      return networkError;
    },
    snapshot(): Snapshot {
      return {
        __brand: "Snapshot" as const,
        value: this.toString(),
      };
    },
    toString(): string {
      const count = requests.length;
      const urls = requests.map((r) => r.url).join(", ");
      const network = networkError ? ` [NETWORK DOWN: ${networkError.message}]` : "";
      return `${count} request(s): ${urls || "(none)"}${network}`;
    },
  };

  // Create the mock object
  const mock: MockHttpClient = {
    $: state,

    async fetch(url: string, fetchOptions?: HttpRequestOptions): Promise<Response> {
      const { signal, timeout } = fetchOptions ?? {};

      // 1. Check network error first
      if (networkError) {
        recordRequest(url, fetchOptions); // Record even on failure
        throw networkError;
      }

      // 2. Pre-aborted signal throws immediately (no delay, no timeout)
      if (signal?.aborted) {
        recordRequest(url, fetchOptions);
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      // 3. Get configured response (or default)
      const config = responses.get(url) ?? defaultResponse;
      const delayMs = config.delayMs ?? 0;

      // 4. Handle delay with timeout and abort signal support
      if (delayMs > 0 || timeout !== undefined) {
        await waitWithTimeoutAndAbort(delayMs, timeout, signal);
      }

      // 5. Record request and return response
      recordRequest(url, fetchOptions);

      if (config.error) {
        throw config.error;
      }

      // Construct fresh Response (allows multiple reads)
      const responseInit: ResponseInit = {
        status: config.status ?? 200,
      };
      if (config.headers !== undefined) {
        responseInit.headers = config.headers;
      }

      // Convert body to BodyInit-compatible type
      // Buffer/Uint8Array are valid BodyInit but TypeScript's generic types cause issues
      let body: BodyInit | null = null;
      if (config.body !== undefined) {
        if (Buffer.isBuffer(config.body)) {
          // Convert Buffer to Uint8Array for Response constructor compatibility
          body = new Uint8Array(config.body) as BodyInit;
        } else if (config.body instanceof Uint8Array) {
          body = config.body as BodyInit;
        } else {
          body = config.body;
        }
      }

      return new Response(body, responseInit);
    },

    setResponse(url: string, config: ConfiguredResponse): void {
      responses.set(url, config);
    },

    simulateNetworkDown(): void {
      networkError = new Error("Network is down");
    },

    simulateNetworkUp(): void {
      networkError = null;
    },
  };

  return mock;
}

// =============================================================================
// Custom Matchers
// =============================================================================

/** Custom matchers for MockHttpClient assertions. */
interface HttpClientMatchers {
  /** Assert that a specific URL was requested. Supports string or RegExp. */
  toHaveRequested(url: string | RegExp): void;
  /** Assert that exactly N requests were made. */
  toHaveRequestCount(count: number): void;
  /** Assert that no requests were made. */
  toHaveNoRequests(): void;
}

// Module augmentation for vitest
// Matchers are added unconditionally (standard pattern for testing libraries)
// Runtime checks ensure correct usage - matchers check if received has `$` property
declare module "vitest" {
  interface Assertion<T> extends HttpClientMatchers {}
}

/** Matcher implementations. */
export const httpClientMatchers: MatcherImplementationsFor<MockHttpClient, HttpClientMatchers> = {
  toHaveRequested(received, url) {
    const requests = received.$.requests;
    const pass =
      url instanceof RegExp
        ? requests.some((r) => url.test(r.url))
        : requests.some((r) => r.url === url);

    return {
      pass,
      message: (): string => {
        const urls = requests.map((r) => r.url).join(", ") || "(none)";
        return pass
          ? `Expected not to have requested ${url}, but did. Requests: ${urls}`
          : `Expected to have requested ${url}, but didn't. Requests: ${urls}`;
      },
    } satisfies MatcherResult;
  },

  toHaveRequestCount(received, count) {
    const actual = received.$.requests.length;
    const pass = actual === count;

    return {
      pass,
      message: (): string =>
        pass
          ? `Expected not to have ${count} request(s), but did`
          : `Expected ${count} request(s), but got ${actual}`,
    } satisfies MatcherResult;
  },

  toHaveNoRequests(received) {
    const count = received.$.requests.length;
    const pass = count === 0;

    return {
      pass,
      message: (): string => {
        const urls = received.$.requests.map((r) => r.url).join(", ");
        return pass
          ? `Expected to have requests, but had none`
          : `Expected no requests, but had ${count}: ${urls}`;
      },
    } satisfies MatcherResult;
  },
};

// Auto-register matchers when this module is imported
expect.extend(httpClientMatchers);
