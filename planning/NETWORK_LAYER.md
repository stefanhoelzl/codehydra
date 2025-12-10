---
status: COMPLETED
last_updated: 2024-12-11
reviewers:
  - review-ui
  - review-typescript
  - review-electron
  - review-arch
  - review-senior
  - review-testing
  - review-docs
---

# NETWORK_LAYER

## Overview

- **Problem**: Network access is scattered across multiple modules with inconsistent patterns:
  - `platform/http.ts` - fetch with timeout (used by opencode-client, instance-probe)
  - `code-server-manager.ts` - uses Node.js `http.get` directly for health checks
  - `opencode-client.ts` - manages SSE via `eventsource` package with custom reconnection
  - `process.ts` - `findAvailablePort()` using TCP server
  - `port-scanner.ts` - `systeminformation` for listing ports

- **Solution**: Create focused, injectable network interfaces in `platform/network.ts` following Interface Segregation Principle. Three separate interfaces that consumers depend on individually.

- **Risks**:
  - SSE reconnection logic is complex - must preserve existing behavior
  - Multiple consumers to update - risk of missed call sites
  - Mitigation: TDD approach (test-first), update one consumer at a time, run full test suite

- **Alternatives Considered**:
  - Keep separate modules, just standardize patterns → Rejected: doesn't improve testability
  - Single monolithic NetworkLayer interface → Rejected: violates Interface Segregation Principle

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Focused Interfaces                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ HttpClient  │  │  SseClient  │  │      PortManager        │  │
│  │  - fetch()  │  │  - create   │  │  - findFreePort()       │  │
│  │             │  │    Sse      │  │  - getListeningPorts()  │  │
│  │             │  │    Conn()   │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DefaultNetworkLayer                          │
│         implements HttpClient, SseClient, PortManager            │
│                                                                  │
│  Single class that implements all interfaces for convenience.    │
│  Consumers inject only the interface(s) they need.               │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┬──────────────┐
              ▼               ▼               ▼              ▼
        OpenCodeClient  InstanceProbe  CodeServer    Discovery
        (HttpClient,    (HttpClient)   Manager       Service
         SseClient)                    (HttpClient,  (PortManager)
                                       PortManager)
```

## Type Definitions

Complete interface definitions for implementation:

```typescript
// ============================================================================
// HTTP Client Interface
// ============================================================================

/**
 * Options for HTTP requests.
 */
export interface HttpRequestOptions {
  /** Timeout in milliseconds. Default: 5000 */
  readonly timeout?: number;
  /** External abort signal to cancel the request */
  readonly signal?: AbortSignal;
}

/**
 * HTTP client for making fetch requests with timeout support.
 */
export interface HttpClient {
  /**
   * HTTP GET request with timeout support.
   *
   * @param url - URL to fetch
   * @param options - Request options
   * @returns Response object
   * @throws DOMException with name "AbortError" on timeout or abort
   * @throws TypeError on network error (connection refused, DNS failure)
   *
   * @example
   * const response = await httpClient.fetch('http://localhost:8080/api');
   * if (response.ok) {
   *   const data = await response.json();
   * }
   *
   * @example With timeout and abort signal
   * const controller = new AbortController();
   * const response = await httpClient.fetch(url, {
   *   timeout: 10000,
   *   signal: controller.signal
   * });
   */
  fetch(url: string, options?: HttpRequestOptions): Promise<Response>;
}

// ============================================================================
// SSE Client Interface
// ============================================================================

/**
 * Options for SSE connections.
 */
export interface SseConnectionOptions {
  /** Enable auto-reconnection on disconnect. Default: true */
  readonly reconnect?: boolean;
  /** Initial reconnection delay in ms. Default: 1000 */
  readonly initialReconnectDelay?: number;
  /** Maximum reconnection delay in ms (backoff cap). Default: 30000 */
  readonly maxReconnectDelay?: number;
}

/**
 * SSE connection handle.
 *
 * IMPORTANT: Reconnection timing is handled by the connection.
 * Application-specific logic (what to do on reconnect) is handled
 * by the consumer via onStateChange callback.
 */
export interface SseConnection {
  /**
   * Set message handler. Called for each SSE message.
   * Replaces any previous handler.
   * @param handler - Receives raw message data string (not parsed)
   */
  onMessage(handler: (data: string) => void): void;

  /**
   * Set state change handler. Called on connect/disconnect.
   * Replaces any previous handler.
   *
   * Use this to perform application-specific actions on reconnect,
   * such as re-syncing state from the server.
   *
   * @param handler - Receives true on connect, false on disconnect
   *
   * @example Re-sync state on reconnect (in OpenCodeClient)
   * connection.onStateChange((connected) => {
   *   if (connected) {
   *     // Application-specific: fetch current status after reconnect
   *     void this.getStatus().then((result) => {
   *       if (result.ok) this.updateCurrentStatus(result.value);
   *     });
   *   }
   * });
   */
  onStateChange(handler: (connected: boolean) => void): void;

  /**
   * Disconnect and cleanup.
   * - Closes the EventSource connection
   * - Clears any pending reconnection timers
   * - Prevents future reconnection attempts
   *
   * Safe to call multiple times.
   */
  disconnect(): void;
}

/**
 * Factory for creating SSE connections.
 */
export interface SseClient {
  /**
   * Create SSE connection with auto-reconnection.
   *
   * Connection is established immediately upon creation.
   * Reconnection uses exponential backoff: 1s, 2s, 4s, 8s... up to maxReconnectDelay.
   * Backoff resets to initialReconnectDelay after successful connection.
   *
   * @param url - SSE endpoint URL
   * @param options - Connection options
   * @returns SSE connection handle
   *
   * @example
   * const conn = sseClient.createSseConnection('http://localhost:8080/events');
   * conn.onMessage((data) => console.log('Received:', data));
   * conn.onStateChange((connected) => console.log('Connected:', connected));
   * // Later: conn.disconnect();
   */
  createSseConnection(url: string, options?: SseConnectionOptions): SseConnection;
}

// ============================================================================
// Port Manager Interface
// ============================================================================

/**
 * A port that is listening for connections.
 */
export interface ListeningPort {
  readonly port: number;
  readonly pid: number;
}

/**
 * Port management operations.
 */
export interface PortManager {
  /**
   * Find a free port on localhost.
   *
   * Uses TCP server bind to port 0, which lets the OS assign an available port.
   * Port is released after discovery, so there's a small race window.
   * Callers should handle EADDRINUSE and retry if needed.
   *
   * @returns Available port number (1024-65535)
   */
  findFreePort(): Promise<number>;

  /**
   * Get all TCP ports currently listening on localhost.
   *
   * Note: This operation may block briefly (100-500ms) while querying
   * system network state via systeminformation library.
   *
   * @returns Array of listening ports with associated PIDs
   */
  getListeningPorts(): Promise<readonly ListeningPort[]>;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for DefaultNetworkLayer.
 */
export interface NetworkLayerConfig {
  /** Default timeout for HTTP requests in ms. Default: 5000 */
  readonly defaultTimeout?: number;
  /** Initial SSE reconnection delay in ms. Default: 1000 */
  readonly initialReconnectDelay?: number;
  /** Maximum SSE reconnection delay in ms. Default: 30000 */
  readonly maxReconnectDelay?: number;
}
```

## SSE Responsibility Split

**IMPORTANT**: Clear separation of concerns between NetworkLayer and consumers:

| Responsibility              | Owner               | Details                                                   |
| --------------------------- | ------------------- | --------------------------------------------------------- |
| EventSource creation        | DefaultNetworkLayer | Wraps `eventsource` package                               |
| Connection state tracking   | DefaultNetworkLayer | Tracks connected/disconnected                             |
| Reconnection timing         | DefaultNetworkLayer | Exponential backoff: 1s → 2s → 4s → ... → 30s max         |
| Backoff reset               | DefaultNetworkLayer | Resets to 1s after successful connect                     |
| Timer cleanup on disconnect | DefaultNetworkLayer | Clears pending timers, prevents reconnection              |
| Raw message delivery        | DefaultNetworkLayer | Passes string data to handler                             |
| **Message parsing**         | **Consumer**        | JSON.parse, type validation                               |
| **Session tracking**        | **Consumer**        | Root session filtering, etc.                              |
| **What to do on reconnect** | **Consumer**        | Re-fetch status, re-sync state via onStateChange callback |
| **Business logic**          | **Consumer**        | All application-specific behavior                         |

## Implementation Steps

### Phase 1: Create Interfaces and Implementation

- [x] **Step 1: Create interfaces and types (TDD)**
  - 1.1 Create `src/services/platform/network.ts` with all interface definitions from above
  - 1.2 Create `src/services/platform/network.test.ts` with test stubs for all methods
  - 1.3 Verify types compile and can be imported
  - Files: `src/services/platform/network.ts`, `src/services/platform/network.test.ts`
  - Test criteria: Types compile, empty test file runs

- [x] **Step 2: Implement DefaultNetworkLayer.fetch() (TDD)**
  - 2.1 Write tests first:
    - "fetch returns response on success"
    - "fetch times out after specified timeout"
    - "fetch uses default timeout (5000ms) when not specified"
    - "fetch aborts when external signal is aborted"
    - "fetch clears timeout on completion"
    - "fetch clears timeout on error"
    - "fetch handles concurrent requests with independent signals"
  - 2.2 Implement fetch() with inline timeout logic (from http.ts)
  - 2.3 Signal merging pattern:
    ```typescript
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort());
    }
    // Remember to removeEventListener in finally block
    ```
  - Files: `src/services/platform/network.ts`, `src/services/platform/network.test.ts`
  - Test criteria: All fetch tests pass

- [x] **Step 3: Implement DefaultNetworkLayer.findFreePort() (TDD)**
  - 3.1 Write tests first:
    - "findFreePort returns valid port number (1024-65535)"
    - "findFreePort returns port that can be bound immediately"
    - "findFreePort handles concurrent calls"
  - 3.2 Implement using TCP server bind to port 0 (from process.ts)
  - Files: `src/services/platform/network.ts`, `src/services/platform/network.test.ts`
  - Test criteria: All findFreePort tests pass

- [x] **Step 4: Implement DefaultNetworkLayer.getListeningPorts() (TDD)**
  - 4.1 Write tests first:
    - "getListeningPorts returns array of ListeningPort"
    - "getListeningPorts returns empty array when no ports listening"
    - "getListeningPorts filters to TCP LISTEN state only"
    - "getListeningPorts excludes entries with invalid PID"
    - "getListeningPorts handles null/undefined from systeminformation"
  - 4.2 Implement with validation:
    ```typescript
    const connections = await si.networkConnections();
    if (!Array.isArray(connections)) return [];
    return connections
      .filter(
        (conn) =>
          conn !== null &&
          conn.state === "LISTEN" &&
          typeof conn.localPort === "string" &&
          typeof conn.pid === "number" &&
          conn.pid > 0
      )
      .map((conn) => ({
        port: parseInt(conn.localPort, 10),
        pid: conn.pid,
      }));
    ```
  - Files: `src/services/platform/network.ts`, `src/services/platform/network.test.ts`
  - Test criteria: All getListeningPorts tests pass

- [x] **Step 5: Implement DefaultNetworkLayer.createSseConnection() (TDD)**
  - 5.1 Write tests first (use vi.useFakeTimers()):
    - "SSE connects and fires onStateChange(true)"
    - "SSE delivers messages via onMessage handler"
    - "SSE fires onStateChange(false) on error"
    - "SSE reconnects after 1s on first failure"
    - "SSE backoff doubles each retry (1s → 2s → 4s → 8s)"
    - "SSE backoff caps at maxReconnectDelay"
    - "SSE backoff resets to initial after successful connect"
    - "SSE disconnect() stops reconnection attempts"
    - "SSE disconnect() clears pending timers"
    - "SSE disconnect() during backoff wait cancels reconnect"
    - "SSE handles EventSource constructor error"
    - "SSE ignores events after disconnect()"
  - 5.2 Implement DefaultSseConnection class:

    ```typescript
    class DefaultSseConnection implements SseConnection {
      private eventSource: EventSource | null = null;
      private messageHandler: ((data: string) => void) | null = null;
      private stateHandler: ((connected: boolean) => void) | null = null;
      private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      private currentDelay: number;
      private disposed = false;

      // ... implementation
    }
    ```

  - 5.3 Verify cleanup: use `vi.getTimerCount()` to ensure no timers leak
  - Files: `src/services/platform/network.ts`, `src/services/platform/network.test.ts`
  - Test criteria: All SSE tests pass, no timer leaks

- [x] **Step 6: Create mock utilities**
  - 6.1 Create `src/services/platform/network.test-utils.ts`
  - 6.2 Implement mock factories:

    ```typescript
    interface MockHttpClientOptions {
      response?: Response;
      error?: Error;
      implementation?: (url: string, options?: HttpRequestOptions) => Promise<Response>;
    }

    interface MockPortManagerOptions {
      findFreePort?: { port?: number; error?: Error };
      getListeningPorts?: { ports?: ListeningPort[]; error?: Error };
    }

    interface MockSseClientOptions {
      connection?: SseConnection;
      implementation?: (url: string, options?: SseConnectionOptions) => SseConnection;
    }

    interface MockSseConnectionOptions {
      messages?: string[]; // Messages to emit
      connected?: boolean; // Initial state
    }

    export function createMockHttpClient(options?: MockHttpClientOptions): HttpClient;
    export function createMockSseClient(options?: MockSseClientOptions): SseClient;
    export function createMockPortManager(options?: MockPortManagerOptions): PortManager;
    export function createMockSseConnection(options?: MockSseConnectionOptions): SseConnection;
    ```

  - Files: `src/services/platform/network.test-utils.ts`
  - Test criteria: Mock factories work in test environment

### Phase 2: Update Consumers

- [x] **Step 7: Update OpenCodeClient (TDD)**
  - 7.1 Write new tests first:
    - "constructor accepts HttpClient and SseClient"
    - "fetchRootSessions uses httpClient.fetch()"
    - "getStatus uses httpClient.fetch()"
    - "connect creates SSE connection via sseClient"
    - "onStateChange(true) triggers status re-sync"
    - "disconnect calls sseConnection.disconnect()"
  - 7.2 Update constructor: `constructor(port: number, private readonly httpClient: HttpClient, private readonly sseClient: SseClient)`
  - 7.3 Replace `fetchWithTimeout` with `this.httpClient.fetch()`
  - 7.4 Replace EventSource + reconnection with `this.sseClient.createSseConnection()`
  - 7.5 Wire onStateChange to trigger getStatus() on reconnect
  - 7.6 Remove internal reconnection logic (~40 lines): reconnectTimer, reconnectDelay, maxReconnectDelay, handleDisconnect()
  - 7.7 **Refactor ALL existing tests** - this is extensive:
    - Remove ALL `vi.spyOn(globalThis, "fetch")` calls
    - Remove ALL `vi.mock("eventsource")` calls
    - Create mock clients in beforeEach:

      ```typescript
      let mockHttpClient: HttpClient;
      let mockSseClient: SseClient;
      let mockSseConnection: SseConnection;

      beforeEach(() => {
        mockSseConnection = createMockSseConnection();
        mockHttpClient = createMockHttpClient({
          response: new Response(JSON.stringify([]), { status: 200 }),
        });
        mockSseClient = createMockSseClient({
          connection: mockSseConnection,
        });
      });
      ```

    - Update all `new OpenCodeClient(port)` → `new OpenCodeClient(port, mockHttpClient, mockSseClient)`
    - For tests that need specific fetch responses, use `createMockHttpClient({ implementation: ... })`
    - For tests that simulate SSE messages, call `mockSseConnection` message handler directly

  - Files: `src/services/opencode/opencode-client.ts`, `src/services/opencode/opencode-client.test.ts`
  - Test criteria: All tests pass (79+ tests)

- [x] **Step 8: Update HttpInstanceProbe (TDD)**
  - 8.1 Write new tests first:
    - "constructor accepts HttpClient"
    - "probe uses httpClient.fetch() with correct URL"
    - "probe uses configured timeout"
  - 8.2 Update constructor: `constructor(private readonly httpClient: HttpClient, timeout = 5000)`
  - 8.3 Replace `fetchWithTimeout` with `this.httpClient.fetch()`
  - 8.4 **Refactor ALL existing tests**:
    - Remove ALL `vi.spyOn(globalThis, "fetch")` calls
    - Create mock HttpClient in beforeEach using `createMockHttpClient()`
    - Update all `new HttpInstanceProbe()` → `new HttpInstanceProbe(mockHttpClient)`
    - For tests needing specific responses, use `createMockHttpClient({ implementation: ... })`
  - Files: `src/services/opencode/instance-probe.ts`, `src/services/opencode/instance-probe.test.ts`
  - Test criteria: All tests pass

- [x] **Step 9: Update DiscoveryService (TDD)**
  - 9.1 Write new tests first:
    - "constructor accepts PortManager"
    - "scan uses portManager.getListeningPorts()"
  - 9.2 Update DiscoveryServiceDependencies type in types.ts:
    - Replace `portScanner: PortScanner` with `portManager: PortManager`
  - 9.3 Update constructor and scan() to use `this.deps.portManager.getListeningPorts()`
  - 9.4 **Refactor ALL existing tests**:
    - Replace mock PortScanner with `createMockPortManager()`
    - Update deps object: `portScanner` → `portManager`
    - Update `scan()` mock returns to use `getListeningPorts` format
  - Files: `src/services/opencode/discovery-service.ts`, `src/services/opencode/discovery-service.test.ts`, `src/services/opencode/types.ts`
  - Test criteria: All tests pass

- [x] **Step 10: Update CodeServerManager (TDD)**
  - 10.1 Write new tests first:
    - "constructor accepts HttpClient and PortManager"
    - "ensureRunning uses portManager.findFreePort()"
    - "health check uses httpClient.fetch() with 1s timeout"
    - "health check returns true on 200 status"
    - "health check returns false on non-200 status"
    - "health check returns false on network error"
  - 10.2 Update constructor: `constructor(config, processRunner, private readonly httpClient: HttpClient, private readonly portManager: PortManager)`
  - 10.3 Replace `findAvailablePort()` with `this.portManager.findFreePort()`
  - 10.4 Replace `http.get` health check with:
    ```typescript
    private async checkHealth(port: number): Promise<boolean> {
      try {
        const response = await this.httpClient.fetch(
          `http://localhost:${port}/healthz`,
          { timeout: 1000 }
        );
        return response.status === 200;
      } catch {
        return false;
      }
    }
    ```
  - 10.5 Remove dynamic `import("http")`
  - 10.6 **Refactor ALL existing tests**:
    - Create mock HttpClient and PortManager in beforeEach
    - Mock `findFreePort` to return a fixed port (e.g., 9999)
    - Mock `fetch` to return 200 for health checks
    - Update all `new CodeServerManager(config, processRunner)` → `new CodeServerManager(config, processRunner, mockHttpClient, mockPortManager)`
  - Files: `src/services/code-server/code-server-manager.ts`, `src/services/code-server/code-server-manager.test.ts`
  - Test criteria: All tests pass

### Phase 3: Cleanup

- [x] **Step 11: Delete obsolete files**
  - 11.1 Verify no imports reference these files:
    - `grep -r "from.*platform/http" src/`
    - `grep -r "from.*opencode/port-scanner" src/`
    - `grep -r "fetchWithTimeout" src/`
    - `grep -r "findAvailablePort" src/`
  - 11.2 Delete files:
    - `src/services/platform/http.ts`
    - `src/services/platform/http.test.ts`
    - `src/services/opencode/port-scanner.ts`
    - `src/services/opencode/port-scanner.test.ts`
  - Files: (deletions)
  - Test criteria: `npm run validate:fix` passes

- [x] **Step 12: Update process.ts**
  - Remove `findAvailablePort` function
  - Remove `createServer` import from `net`
  - Files: `src/services/platform/process.ts`
  - Test criteria: No TypeScript errors

- [x] **Step 13: Update exports**
  - 13.1 Update `src/services/index.ts`:
    - Export: `DefaultNetworkLayer`, `HttpClient`, `SseClient`, `SseConnection`, `PortManager`, `ListeningPort`, `HttpRequestOptions`, `SseConnectionOptions`, `NetworkLayerConfig`
    - Remove: `fetchWithTimeout`, `findAvailablePort`
  - 13.2 Update `src/services/opencode/index.ts`:
    - Remove: `SiPortScanner`, `PortScanner` exports
  - Files: `src/services/index.ts`, `src/services/opencode/index.ts`
  - Test criteria: No import errors

- [x] **Step 14: Wire in main process**
  - 14.1 Create DefaultNetworkLayer in bootstrap():
    ```typescript
    const networkLayer = new DefaultNetworkLayer();
    ```
  - 14.2 Update service creation:

    ```typescript
    // CodeServerManager needs HttpClient + PortManager
    codeServerManager = new CodeServerManager(config, processRunner, networkLayer, networkLayer);

    // InstanceProbe needs HttpClient
    const instanceProbe = new HttpInstanceProbe(networkLayer);

    // DiscoveryService needs PortManager (via deps)
    discoveryService = new DiscoveryService({
      portManager: networkLayer,
      processTree,
      instanceProbe,
    });

    // OpenCodeClient creation in AgentStatusManager needs HttpClient + SseClient
    // Update AgentStatusManager to receive these and pass to OpenCodeClient
    ```

  - 14.3 Update AgentStatusManager constructor to receive HttpClient and SseClient
  - 14.4 Pass to OpenCodeClient when creating instances
  - 14.5 **Refactor AgentStatusManager tests**:
    - Create mock HttpClient and SseClient in beforeEach
    - Update all `new AgentStatusManager(discoveryService)` → `new AgentStatusManager(discoveryService, mockHttpClient, mockSseClient)`
    - Tests that verify OpenCodeClient creation should check mocks are passed through
  - Files: `src/main/index.ts`, `src/services/opencode/agent-status-manager.ts`, `src/services/opencode/agent-status-manager.test.ts`
  - Test criteria: Application starts successfully, all AgentStatusManager tests pass

## Testing Strategy

### Unit Tests (vitest)

| Test Case                            | Description                    | File            |
| ------------------------------------ | ------------------------------ | --------------- |
| fetch returns response               | Successful HTTP request        | network.test.ts |
| fetch times out                      | Request exceeds timeout        | network.test.ts |
| fetch uses default timeout           | 5000ms when not specified      | network.test.ts |
| fetch respects external abort        | External signal aborts request | network.test.ts |
| fetch clears timeout on completion   | Cleanup on success             | network.test.ts |
| fetch clears timeout on error        | Cleanup on failure             | network.test.ts |
| fetch concurrent requests            | Independent signals work       | network.test.ts |
| findFreePort valid port              | Returns 1024-65535             | network.test.ts |
| findFreePort can bind                | Returned port is actually free | network.test.ts |
| getListeningPorts returns array      | Has listening ports            | network.test.ts |
| getListeningPorts empty              | No listening ports             | network.test.ts |
| getListeningPorts filters TCP LISTEN | Only LISTEN state              | network.test.ts |
| getListeningPorts validates PID      | Excludes invalid PIDs          | network.test.ts |
| getListeningPorts null safety        | Handles null from si           | network.test.ts |
| SSE connects                         | fires onStateChange(true)      | network.test.ts |
| SSE messages                         | onMessage receives data        | network.test.ts |
| SSE disconnects                      | fires onStateChange(false)     | network.test.ts |
| SSE reconnect 1s                     | First retry after 1s           | network.test.ts |
| SSE backoff doubles                  | 1s → 2s → 4s → 8s              | network.test.ts |
| SSE backoff caps                     | Stops at maxReconnectDelay     | network.test.ts |
| SSE backoff resets                   | Back to 1s after success       | network.test.ts |
| SSE disconnect stops reconnect       | No more attempts               | network.test.ts |
| SSE disconnect clears timers         | No timer leaks                 | network.test.ts |
| SSE disconnect during backoff        | Cancels pending reconnect      | network.test.ts |
| SSE constructor error                | Handles invalid URL            | network.test.ts |

### Integration Tests

| Test Case                 | Description                         | File                                    |
| ------------------------- | ----------------------------------- | --------------------------------------- |
| Full HTTP flow            | fetch real localhost endpoint       | network.integration.test.ts             |
| Full port flow            | findFreePort → bind → verify        | network.integration.test.ts             |
| CodeServerManager startup | findFreePort → start → health check | code-server-manager.integration.test.ts |

### Manual Testing Checklist

- [ ] Start application, verify code-server starts (uses findFreePort)
- [ ] Open project with workspace, verify code-server health check works
- [ ] Start opencode in workspace, verify agent status updates via SSE
- [ ] Kill opencode, verify SSE reconnects (check console for backoff timing)
- [ ] Restart opencode, verify status syncs after reconnection
- [ ] Verify UI remains responsive during SSE reconnection attempts

## Dependencies

| Package           | Purpose                  | Approved |
| ----------------- | ------------------------ | -------- |
| eventsource       | SSE client (existing)    | [x]      |
| systeminformation | Port scanning (existing) | [x]      |

No new dependencies required.

## Documentation Updates

### Files to Update

| File                 | Changes Required                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| docs/ARCHITECTURE.md | Add NetworkLayer section: describe HttpClient, SseClient, PortManager interfaces; add to App Services table; note DI pattern |
| AGENTS.md            | Add "NetworkLayer Pattern" section similar to "ProcessRunner Pattern"; document interface segregation and injection          |

### New Documentation Required

None - inline JSDoc in interface definitions is comprehensive.

## Definition of Done

- [ ] All implementation steps complete
- [ ] All tests pass: `npm test`
- [ ] Type check passes: `npm run check`
- [ ] Lint passes: `npm run lint`
- [ ] Format check passes: `npm run format:check`
- [ ] Full validation: `npm run validate:fix`
- [ ] Test coverage ≥ 90% for new network.ts code
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
