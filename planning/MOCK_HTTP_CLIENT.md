---
status: COMPLETED
last_updated: 2026-01-02
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# MOCK_HTTP_CLIENT

## Overview

- **Problem**: The current `createMockHttpClient()` is a call-tracking mock that doesn't follow the behavioral mock pattern. It doesn't track request history, has no state inspection via `mock.$`, and doesn't integrate with the `toBeUnchanged(snapshot)` matcher system.

- **Solution**: Migrate `createMockHttpClient()` to the `mock.$` behavioral pattern with:
  - `HttpClientMockState` implementing `MockState` (snapshot, toString)
  - Request history tracking (all requests, including failed ones)
  - Response configuration per URL (store data, construct fresh Response on each call)
  - Network error simulation
  - Custom matchers (`toHaveRequested`, `toHaveRequestCount`, `toHaveNoRequests`)
  - Fake timers integration for delay simulation (uses setTimeout, compatible with `vi.useFakeTimers()`)

- **Risks**:
  - Many test files use the existing mock (46 usages) - mitigated by keeping similar factory signature
  - Response cloning needed for multiple reads - mitigated by storing response data and constructing fresh Response objects

- **Alternatives Considered**:
  - Pattern matching for URLs - rejected (YAGNI, exact match covers current usage)
  - Keep `implementation` option - rejected (behavioral mock with `setResponse` is cleaner)
  - Update existing file - rejected (new `*.state-mock.ts` naming convention)
  - Store Response objects directly - rejected (Response bodies can only be read once)

## Architecture

```
src/services/platform/
├── network.ts                    # HttpClient interface (unchanged)
├── network.test-utils.ts         # Keep: PortManager mock, TestServer, waitForPort
│                                 # Remove: createMockHttpClient
└── http-client.state-mock.ts     # NEW: Behavioral HttpClient mock

src/test/
├── state-mock.ts                 # Base types (MockState, MockWithState, Snapshot)
└── setup-matchers.ts             # Register httpClientMatchers
```

**Note**: This is the first `*.state-mock.ts` implementation, establishing the pattern for future behavioral mocks.

### Type Definitions

```typescript
/** Record of an HTTP request made through the mock. */
interface HttpRequestRecord {
  readonly url: string;
  readonly options?: HttpRequestOptions;
  readonly timestamp: number; // Date.now() epoch ms
}

/**
 * Response configuration - stores DATA, not Response objects.
 * Fresh Response constructed on each fetch() call.
 */
interface ConfiguredResponse {
  readonly body?: string;
  readonly status?: number; // Default: 200
  readonly headers?: Record<string, string>;
  readonly error?: Error; // Throw this instead of returning response
  readonly delayMs?: number; // Simulated delay (use with vi.useFakeTimers())
}

/** Mock state - pure data, logic in matchers. */
interface HttpClientMockState extends MockState {
  readonly requests: readonly HttpRequestRecord[];
  readonly responses: ReadonlyMap<string, ConfiguredResponse>;
  readonly networkError: Error | null;
}

/** Mock type with state access and setup methods. */
type MockHttpClient = HttpClient &
  MockWithState<HttpClientMockState> & {
    setResponse(url: string, config: ConfiguredResponse): void;
    simulateNetworkDown(): void;
    simulateNetworkUp(): void;
  };

/** Factory options. */
interface MockHttpClientOptions {
  /** Pre-configured responses by exact URL. */
  responses?: Record<string, ConfiguredResponse>;
  /** Default for unconfigured URLs. Default: { status: 200, body: "" } */
  defaultResponse?: ConfiguredResponse;
}
```

### Behavior Mapping (Boundary Tests → Mock)

| Boundary Test Behavior                | Mock Implementation                          |
| ------------------------------------- | -------------------------------------------- |
| Returns 200 OK                        | Default response `{ status: 200, body: "" }` |
| Returns 404/500 status                | ConfiguredResponse with `status` field       |
| Throws AbortError on timeout          | See timeout/abort pseudocode below           |
| Respects abort signal                 | See timeout/abort pseudocode below           |
| Pre-aborted signal throws immediately | Check `signal.aborted` before any async work |
| Network error (connection refused)    | `simulateNetworkDown()` sets `networkError`  |

### Timeout/Abort Handling Pseudocode

```typescript
async fetch(url: string, options?: HttpRequestOptions): Promise<Response> {
  const { signal, timeout } = options ?? {};

  // 1. Check network error first
  if (this.networkError) {
    this.recordRequest(url, options);  // Record even on failure
    throw this.networkError;
  }

  // 2. Pre-aborted signal throws immediately (no delay, no timeout)
  if (signal?.aborted) {
    this.recordRequest(url, options);
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  // 3. Get configured response (or default)
  const config = this.responses.get(url) ?? this.defaultResponse;
  const delayMs = config.delayMs ?? 0;

  // 4. Handle delay with timeout and abort signal support
  if (delayMs > 0 || timeout) {
    await this.waitWithTimeoutAndAbort(delayMs, timeout, signal);
  }

  // 5. Record request and return response
  this.recordRequest(url, options);

  if (config.error) {
    throw config.error;
  }

  // Construct fresh Response (allows multiple reads)
  return new Response(config.body ?? "", {
    status: config.status ?? 200,
    headers: config.headers,
  });
}

private async waitWithTimeoutAndAbort(
  delayMs: number,
  timeout: number | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Timeout fires AFTER the specified duration
    const effectiveTimeout = timeout ?? Infinity;
    const timeoutId = setTimeout(() => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, Math.min(delayMs, effectiveTimeout));

    // Abort signal listener
    const abortHandler = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    // If no timeout triggers, resolve after delay
    if (delayMs < effectiveTimeout) {
      setTimeout(() => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortHandler);
        resolve();
      }, delayMs);
    }
  });
}
```

### toString() Format

```typescript
toString(): string {
  const count = this.requests.length;
  const urls = this.requests.map(r => r.url).join(", ");
  const network = this.networkError ? ` [NETWORK DOWN: ${this.networkError.message}]` : "";
  return `${count} request(s): ${urls || "(none)"}${network}`;
}
```

### URL Matching

URL matching is **exact match only** - no normalization applied. The URL passed to `setResponse()` must exactly match the URL passed to `fetch()`.

## API Migration Guide

The factory signature is similar but options change slightly:

```typescript
// OLD: Store Response object (can only be read once)
createMockHttpClient({ response: new Response("body", { status: 200 }) });

// NEW: Store response data (fresh Response constructed each call)
createMockHttpClient({ defaultResponse: { body: "body", status: 200 } });

// OLD: Custom implementation for URL routing
createMockHttpClient({
  implementation: async (url) => {
    if (url.includes("/health")) return new Response("ok");
    return new Response("", { status: 404 });
  },
});

// NEW: Configure responses per URL
createMockHttpClient({
  responses: {
    "http://127.0.0.1:8080/health": { body: "ok", status: 200 },
  },
  defaultResponse: { status: 404 },
});

// Or configure after creation:
const mock = createMockHttpClient();
mock.setResponse("http://127.0.0.1:8080/health", { body: "ok" });
```

## Implementation Steps

- [x] **Step 1: Create type definitions in `http-client.state-mock.ts`**
  - Define `HttpRequestRecord` interface with readonly fields
  - Define `ConfiguredResponse` interface (body, status, headers, error, delayMs)
  - Define `HttpClientMockState` interface extending `MockState`
  - Define `MockHttpClient` type (HttpClient & MockWithState & setup methods)
  - Define `MockHttpClientOptions` interface
  - Export all types
  - Files affected: `src/services/platform/http-client.state-mock.ts` (new)

- [x] **Step 2: Implement `createMockHttpClient()` factory**
  - Create internal mutable state (requests array, responses map, networkError)
  - Implement state object with `snapshot()` and `toString()` methods
  - Implement `fetch()` with timeout/abort/delay handling per pseudocode
  - Implement `setResponse()`, `simulateNetworkDown()`, `simulateNetworkUp()`
  - Construct fresh Response objects on each fetch (enables multiple reads)
  - Files affected: `src/services/platform/http-client.state-mock.ts`

- [x] **Step 3: Implement custom matchers**
  - Define `HttpClientMatchers` interface:
    ```typescript
    interface HttpClientMatchers {
      toHaveRequested(url: string | RegExp): void;
      toHaveRequestCount(count: number): void;
      toHaveNoRequests(): void;
    }
    ```
  - Add vitest module augmentation:
    ```typescript
    declare module "vitest" {
      interface Assertion<T> extends MatchersFor<T, MockHttpClient, HttpClientMatchers> {}
    }
    ```
  - Implement `httpClientMatchers` using `MatcherImplementationsFor`
  - Export matchers
  - Files affected: `src/services/platform/http-client.state-mock.ts`

- [x] **Step 4: Register matchers in setup-matchers.ts**
  - Add import and registration:
    ```typescript
    import { httpClientMatchers } from "../services/platform/http-client.state-mock";
    expect.extend({ ...httpClientMatchers });
    ```
  - Files affected: `src/test/setup-matchers.ts`

- [x] **Step 5: Remove old mock from network.test-utils.ts**
  - Remove `MockHttpClientOptions` interface
  - Remove `createMockHttpClient()` function
  - Keep all other exports (PortManager mock, TestServer, waitForPort, etc.)
  - Files affected: `src/services/platform/network.test-utils.ts`

- [x] **Step 6: Update test file imports and migrate API**
  - Run `rg "createMockHttpClient" --files-with-matches` to find all usages
  - For each file:
    - Change import from `network.test-utils` to `http-client.state-mock`
    - Migrate `{ response: new Response(...) }` → `{ defaultResponse: { body, status } }`
    - Migrate `{ implementation: ... }` → `{ responses: { url: config } }` or use `setResponse()`
  - Files affected (known):
    - `src/services/code-server/code-server-manager.test.ts`
    - `src/services/code-server/code-server-manager.integration.test.ts`
    - `src/services/binary-download/binary-download-service.test.ts`
    - `src/services/binary-download/binary-download-service.integration.test.ts`
  - Verify no remaining imports: `rg "createMockHttpClient.*network.test-utils"`

## Testing Strategy

Mock implementation validated by existing test suites continuing to pass after migration (no new tests needed for infrastructure).

### Manual Testing Checklist

- [ ] `pnpm validate:fix` passes
- [ ] All existing tests using `createMockHttpClient` still pass
- [ ] No remaining imports from `network.test-utils` for `createMockHttpClient`

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File | Changes Required                                        |
| ---- | ------------------------------------------------------- |
| None | No documentation changes needed - internal test utility |

### New Documentation Required

| File | Purpose                                       |
| ---- | --------------------------------------------- |
| None | Pattern already documented in docs/TESTING.md |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] All existing tests pass with new mock
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
