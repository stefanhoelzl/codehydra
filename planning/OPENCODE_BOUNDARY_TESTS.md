---
status: COMPLETED
last_updated: 2025-12-12
reviewers: [review-testing, review-docs, review-arch, review-senior, review-typescript]
---

# OPENCODE_BOUNDARY_TESTS

## Overview

- **Problem**: `OpenCodeClient` has extensive unit tests with mocked SDK, but we need to verify it correctly communicates with a real `opencode serve` instance and interprets responses correctly.
- **Solution**: Create boundary tests that run against a real `opencode serve` process, using a mock OpenAI-compatible LLM server to control responses and trigger specific states (idle, busy, retry, permission requests).
- **Risks**:
  - Test complexity: requires coordinating mock LLM server + opencode process
  - Timing sensitivity: SSE events are async
  - Port conflicts: tests need specific ports available
- **Alternatives Considered**:
  - Testing against a real LLM: Rejected - too slow, non-deterministic, expensive
  - Only unit tests: Current approach, but mocks may drift from real SDK/server behavior

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Boundary Test Architecture                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────┐                                             │
│  │   Mock LLM Server  │  ← Controls responses:                      │
│  │   :19999           │    instant, slow-stream, tool-call,         │
│  │                    │    rate-limit, sub-agent                    │
│  └─────────┬──────────┘                                             │
│            │                                                         │
│            │ POST /v1/chat/completions                               │
│            ▼                                                         │
│  ┌────────────────────┐     SSE /event      ┌──────────────────┐   │
│  │   opencode serve   │ ──────────────────► │  OpenCodeClient  │   │
│  │   :14096           │                     │  (under test)    │   │
│  └─────────┬──────────┘                     └────────┬─────────┘   │
│            │                                          │             │
│            │ HTTP /session, /session/status           │             │
│            ◄──────────────────────────────────────────┘             │
│            │                                                         │
│            │ SDK client.session.prompt()                             │
│  ┌─────────┴──────────┐                                             │
│  │   @opencode-ai/sdk │  ← Used to send prompts to trigger events   │
│  └────────────────────┘                                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Mock LLM Server Modes

| Mode          | Response Behavior                   | Triggers                 |
| ------------- | ----------------------------------- | ------------------------ |
| `instant`     | Return completion immediately       | idle → busy → idle       |
| `slow-stream` | Stream with 100ms delays            | Extended busy state      |
| `tool-call`   | Return `bash` tool_call             | permission.updated event |
| `rate-limit`  | Return HTTP 429 with `Retry-After`  | retry status             |
| `sub-agent`   | Return text with `@general` mention | Child session creation   |

**Note on sub-agents:** OpenCode creates child sessions when the model's text response contains `@agent-name` mentions (e.g., `@general`, `@explore`). This is NOT a tool_call - it's parsed from the text content.

### Type Definitions

```typescript
// Constants
const MOCK_LLM_PORT = 19999;
const OPENCODE_TEST_PORT = 14096;
const STREAM_DELAY_MS = 100;
const EVENT_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 10000;
const CI_TIMEOUT_MS = 30000;

// Mock LLM Server types
type MockLlmMode = "instant" | "slow-stream" | "tool-call" | "rate-limit" | "sub-agent";

interface MockLlmServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  setMode(mode: MockLlmMode): void;
  readonly port: number;
}

// OpenCode process management
interface OpencodeProcess {
  readonly pid: number;
  stop(): Promise<void>;
}

interface OpencodePermissionConfig {
  bash: "ask" | "allow" | "deny";
  edit: "ask" | "allow" | "deny";
  webfetch: "ask" | "allow" | "deny";
}

interface OpencodeTestConfig {
  port: number;
  cwd: string;
  config: {
    provider: Record<string, unknown>;
    model: string;
    permission: OpencodePermissionConfig;
  };
}

// Test utilities
/**
 * Starts opencode serve with the given config.
 * Uses OPENCODE_CONFIG env var to inject configuration.
 */
function startOpencode(config: OpencodeTestConfig): Promise<OpencodeProcess>;

/**
 * Waits for a port to become available.
 * Uses dynamic timeout based on CI environment.
 */
function waitForPort(port: number, timeoutMs?: number): Promise<void>;

/**
 * Waits for events matching a predicate, with timeout.
 * Prefer vitest's vi.waitFor() for simple conditions.
 */
function waitForEvents<T>(
  predicate: () => T | Promise<T>,
  options?: { timeout?: number; interval?: number }
): Promise<T>;
```

## UI Design

N/A - This is a testing infrastructure feature.

## Implementation Steps

### Phase 0: Infrastructure Validation

- [x] **Step 0.1: Verify opencode binary availability**
  - TDD: Write test that checks `opencode --version` returns valid output
  - Skip boundary tests gracefully if opencode binary not found
  - Test criteria: Binary check passes or tests skip with clear message

### Phase 1: Mock LLM Server

- [x] **Step 1.1: Create mock LLM server**
  - TDD: Write failing test expecting server to respond with instant mode
  - Extend existing `createTestServer()` from `src/services/platform/network.test-utils.ts`
  - Add `/v1/chat/completions` route with mode-based responses
  - Implement `setMode()` for test control
  - Create typed response builders for each mode (see Mock Response Builders below)
  - Files: `src/test/fixtures/mock-llm-server.ts` (new)
  - Test criteria: Each mode returns spec-compliant OpenAI response format

- [x] **Step 1.2: Create test utilities**
  - TDD: Write failing tests for each utility before implementation
  - `startOpencode()`: Use `ExecaProcessRunner` (consistent with CodeServerManager pattern)
  - `waitForPort()`: Add to `src/services/platform/network.test-utils.ts` for reuse
  - Event waiting: Use vitest's `vi.waitFor()` for simple conditions
  - Implement cleanup-on-failure pattern (see Test Environment Setup)
  - Track spawned PIDs for force-kill fallback cleanup
  - Files: `src/services/opencode/boundary-test-utils.ts` (new)
  - Test criteria: Utilities handle errors gracefully, cleanup works reliably

- [x] **Step 1.3: Verify mock LLM integration**
  - TDD: Write test that starts opencode with mock config and sends prompt via SDK
  - Assert mock LLM server received request with correct format
  - Validates the mock works before using it in other tests
  - Test criteria: End-to-end mock → opencode → SDK flow works

### Phase 2: HTTP API Boundary Tests

- [x] **Step 2.1: Test fetchRootSessions**
  - TDD: Write failing test expecting sessions array from real server
  - Verify real `/session` endpoint returns parseable session data
  - Verify root sessions (no parentID) are correctly identified
  - Verify child sessions are excluded from result
  - Files: `src/services/opencode/opencode-client.boundary.test.ts` (new)
  - Test criteria: Sessions from real server match expected structure

- [x] **Step 2.2: Test getStatus**
  - TDD: Write failing test expecting idle status when no active sessions
  - Verify real `/session/status` endpoint returns parseable status
  - Verify idle status when no active sessions
  - Verify busy status during active prompt
  - Test criteria: Status aggregation works with real server data

- [x] **Step 2.3: Test HTTP API error handling**
  - TDD: Write failing tests for each error scenario
  - Test 500 errors from server (malformed JSON response)
  - Test timeout errors (server unresponsive)
  - Test empty session list (no sessions exist)
  - Test invalid session ID handling
  - Test criteria: Client handles errors gracefully, doesn't crash

### Phase 3: SSE Connection Boundary Tests

- [x] **Step 3.1: Test connect/disconnect lifecycle**
  - TDD: Write failing test expecting SSE connection to establish
  - Verify SSE connection establishes to `/event` endpoint
  - Verify disconnect cleanly terminates connection
  - Verify timeout behavior when server is unresponsive
  - Test criteria: Connection lifecycle works with real server

- [x] **Step 3.2: Test SSE error scenarios**
  - TDD: Write failing tests for connection failures
  - Test connect() when opencode not fully started (should retry or clear error)
  - Test SSE connection drop mid-stream (simulate server restart)
  - Test reconnection behavior after disconnect
  - Test criteria: Client handles connection errors gracefully

### Phase 4: Session Status Event Tests

- [x] **Step 4.1: Test idle → busy → idle transition**
  - TDD: Write failing test expecting status events in sequence
  - Send prompt via SDK with mock LLM in `instant` mode
  - Use typed event collection: `const events: SessionStatusEvent[] = []`
  - Use `vi.waitFor()` with event count assertion
  - Verify `session.status` events received via SSE
  - Verify `onStatusChanged` callback fires correctly
  - Test criteria: Status transitions match expected sequence

- [x] **Step 4.2: Test retry status on rate limit**
  - TDD: Write failing test expecting retry → busy mapping
  - Set mock LLM to `rate-limit` mode
  - Send prompt via SDK
  - Verify `retry` status maps to `busy` in client
  - Test criteria: Rate limit scenario handled correctly

- [x] **Step 4.3: Test extended busy state with streaming**
  - TDD: Write failing test expecting busy status to persist during streaming
  - Set mock LLM to `slow-stream` mode (100ms delays between chunks)
  - Send prompt via SDK
  - Verify busy status persists during streaming
  - Verify idle status only after stream completes
  - Test criteria: Streaming responses maintain busy state correctly

### Phase 5: Root vs Child Session Filtering Tests

- [x] **Step 5.1: Test root session tracking**
  - TDD: Write failing test expecting root session to be tracked
  - Create session, verify it's tracked as root
  - Verify `isRootSession()` returns true for root
  - Verify events emitted for root session status changes
  - Test criteria: Root sessions correctly identified and tracked

- [x] **Step 5.2: Test child session filtering**
  - TDD: Write failing test expecting child session events to be filtered
  - Trigger sub-agent creation (mock LLM returns text with `@general` mention)
  - Verify child session created with `parentID`
  - Verify `isRootSession()` returns false for child
  - Verify NO events emitted for child session status changes
  - Verify child session going busy/idle does NOT affect root status
  - Test criteria: Child sessions correctly filtered from events

- [x] **Step 5.3: Test session.created event handling**
  - TDD: Write failing test for session.created filtering
  - Verify new root session (no parentID) triggers event emission
  - Verify new child session (with parentID) does NOT trigger event
  - Test criteria: session.created filtering works correctly

### Phase 6: Permission Event Tests

**Note:** Permission tests require `permission.bash = "ask"` in config so opencode waits for approval.

- [x] **Step 6.1: Test permission.updated event**
  - TDD: Write failing test expecting permission.updated event
  - Configure `permission: { bash: "ask" }` so opencode waits for approval
  - Set mock LLM to `tool-call` mode (returns bash tool_call)
  - Send prompt via SDK
  - Use typed event collection: `const events: PermissionUpdatedEvent[] = []`
  - Verify `permission.updated` SSE event received with correct fields (id, sessionID, type, title)
  - Verify `onPermissionEvent` callback fires with correct data
  - Test criteria: Permission events correctly parsed and emitted

- [x] **Step 6.2: Test permission approval flow**
  - TDD: Write failing test expecting tool execution after approval
  - After receiving `permission.updated`, respond via SDK:
    ```typescript
    await sdk.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionId: permissionId },
      body: { response: "once" },
    });
    ```
  - Verify `permission.replied` SSE event received
  - Verify tool executes after approval (session goes busy then idle)
  - Test criteria: Permission approval flow works end-to-end

- [x] **Step 6.3: Test permission rejection flow**
  - TDD: Write failing test expecting rejection behavior
  - After receiving `permission.updated`, respond with rejection:
    ```typescript
    await sdk.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionId: permissionId },
      body: { response: "reject" },
    });
    ```
  - Verify `permission.replied` SSE event received with rejection
  - Verify tool does NOT execute after rejection
  - Test criteria: Permission rejection prevents tool execution

## Testing Strategy

### Test Environment Setup

```typescript
import { findFreePort } from "../platform/network";
import { createTestGitRepo } from "../../test-utils";

// Use dynamic port allocation for parallel test safety
let mockLlmPort: number;
let opencodePort: number;
let mockLlm: MockLlmServer;
let opencodeProcess: OpencodeProcess;
let tempDir: string;
let cleanup: () => Promise<void>;
let sdk: OpencodeClient;

// Track PIDs for fallback cleanup
const spawnedPids: number[] = [];

beforeAll(async () => {
  // Dynamic port allocation (avoids conflicts in parallel runs)
  mockLlmPort = await findFreePort();
  opencodePort = await findFreePort();

  // Cleanup stack for error recovery
  const cleanupStack: Array<() => Promise<void>> = [];

  try {
    // 1. Start mock LLM server
    mockLlm = createMockLlmServer(mockLlmPort);
    await mockLlm.start();
    cleanupStack.push(() => mockLlm.stop());

    // 2. Create temp directory for opencode (uses existing pattern)
    const repo = await createTestGitRepo();
    tempDir = repo.path;
    cleanup = repo.cleanup;
    cleanupStack.push(cleanup);

    // 3. Start opencode serve with mock config
    opencodeProcess = await startOpencode({
      port: opencodePort,
      cwd: tempDir,
      config: {
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://localhost:${mockLlmPort}/v1` },
            models: { test: { name: "Test Model" } },
          },
        },
        model: "mock/test",
        permission: {
          bash: "ask",
          edit: "allow",
          webfetch: "allow",
        },
      },
    });
    spawnedPids.push(opencodeProcess.pid);
    cleanupStack.push(() => opencodeProcess.stop());

    // 4. Wait for opencode to be ready (CI gets longer timeout)
    const timeout = process.env.CI ? CI_TIMEOUT_MS : EVENT_TIMEOUT_MS;
    await waitForPort(opencodePort, timeout);

    // 5. Create SDK client for sending prompts
    sdk = createOpencodeClient({ baseUrl: `http://localhost:${opencodePort}` });
  } catch (error) {
    // Cleanup in reverse order on failure
    for (const fn of cleanupStack.reverse()) {
      await fn().catch(console.error);
    }
    throw error;
  }
}, CI_TIMEOUT_MS);

afterAll(async () => {
  // Primary cleanup
  try {
    if (opencodeProcess) await opencodeProcess.stop();
    if (mockLlm) await mockLlm.stop();
    if (cleanup) await cleanup();
  } catch (error) {
    console.error("Primary cleanup failed:", error);
  }

  // Fallback: force-kill any remaining spawned processes
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead, ignore
    }
  }
});

afterEach(async () => {
  // Cleanup between tests to prevent pollution
  if (client) client.disconnect();
  // Delete all sessions to reset state
  const sessions = await sdk.session.list();
  for (const session of sessions.data ?? []) {
    await sdk.session.delete({ path: { id: session.id } }).catch(() => {});
  }
  // Small delay for event queue to drain
  await new Promise((resolve) => setTimeout(resolve, 100));
});
```

### Test Patterns

| Pattern                   | Usage                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| **Typed event arrays**    | `const events: SessionStatusEvent[] = []` for type-safe collection |
| **vi.waitFor()**          | Use vitest's built-in for simple conditions with timeout           |
| **Event count assertion** | `vi.waitFor(() => events.length >= 2, { timeout: 5000 })`          |
| **Mode switching**        | `mockLlm.setMode()` before each test scenario                      |
| **Fresh client**          | Create new `OpenCodeClient` in `beforeEach`                        |
| **Explicit cleanup**      | `afterEach` deletes sessions, drains event queue                   |

### Port Allocation

Dynamic port allocation using `findFreePort()` from `src/services/platform/network.ts` for parallel test safety. Fallback to fixed ports only if opencode requires specific port configuration.

### Unit Tests

N/A - This plan adds boundary tests, unit tests already exist.

### Integration Tests

N/A - These ARE the integration/boundary tests.

### Manual Testing Checklist

- [ ] Run `npm run test:boundary` and verify all tests pass
- [ ] Verify tests complete in reasonable time:
  - Phase 0 (infrastructure): <2s
  - Phase 1 (mock server): <3s
  - Phase 2 (HTTP API): <5s
  - Phase 3 (SSE connection): <5s
  - Phase 4 (session status): <10s
  - Phase 5 (root/child): <10s
  - Phase 6 (permissions): <10s
  - **Total: <45s** (boundary tests are slower than unit tests)
- [ ] Verify no port conflicts with other services
- [ ] Verify tests pass in CI environment (longer timeouts)

## Dependencies

| Package | Purpose                     | Approved |
| ------- | --------------------------- | -------- |
| (none)  | No new runtime dependencies | N/A      |

**Existing devDependencies used:**

- `@opencode-ai/sdk` (^1.0.138) - For sending prompts and SDK client
- `opencode-ai` (\*) - For `opencode serve` binary
- `vitest` - Test runner

**Binary requirement:** Tests require `opencode` binary to be available. Tests should skip gracefully with clear message if binary not found (see Phase 0).

## Documentation Updates

### Files to Update

| File              | Changes Required                                          |
| ----------------- | --------------------------------------------------------- |
| `docs/TESTING.md` | Add OpenCode boundary tests section (see details below)   |
| `AGENTS.md`       | Add `waitForPort()` to NetworkLayer pattern documentation |

**docs/TESTING.md updates:**

1. Add subsection under "Boundary Tests" titled "OpenCode Boundary Tests"
2. Document the mock LLM server pattern:
   - When to use mock LLM vs real server
   - Available mock modes and their purposes
   - How to extend with new modes
3. Document test utilities:
   - `startOpencode()` signature and usage
   - `waitForPort()` signature and usage
   - Cleanup patterns and PID tracking
4. Add to "When to Run Tests" table:
   - OpenCode boundary tests: when modifying `OpenCodeClient` or SDK integration
5. Update Decision Guide:
   - "Testing OpenCode client changes" → run boundary tests

### New Documentation Required

| File                              | Purpose                                                 |
| --------------------------------- | ------------------------------------------------------- |
| JSDoc in `mock-llm-server.ts`     | Document each mode, response formats, extension points  |
| JSDoc in `boundary-test-utils.ts` | Document utilities with examples (see Type Definitions) |

## Definition of Done

- [x] Phase 0: Infrastructure validation (binary check, skip if unavailable)
- [x] Phase 1: Mock LLM server with typed response builders, extending createTestServer()
- [x] Phase 2: HTTP API tests including error scenarios
- [x] Phase 3: SSE connection tests including error scenarios
- [x] Phase 4: Session status tests including slow-stream mode
- [x] Phase 5: Root vs child session filtering verified
- [x] Phase 6: Permission event flow verified (approval AND rejection)
- [x] All tests use TDD approach (failing test first)
- [x] Dynamic port allocation for parallel test safety
- [x] Cleanup-on-failure pattern implemented
- [x] `npm run validate:fix` passes
- [x] `docs/TESTING.md` updated with OpenCode boundary test section
- [x] Changes committed

## Notes

### Mock Response Builders

Use typed factory functions instead of inline JSON for maintainability:

```typescript
interface ChatCompletion {
  id: string;
  object: "chat.completion";
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: "stop" | "tool_calls";
  }>;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Creates instant completion response */
function createInstantCompletion(content: string): ChatCompletion {
  return {
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

/** Creates tool call completion (triggers permission) */
function createToolCallCompletion(toolName: string, args: Record<string, unknown>): ChatCompletion {
  return {
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${randomId()}`,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/** Creates sub-agent trigger response */
function createSubAgentCompletion(agentName: string, prompt: string): ChatCompletion {
  return createInstantCompletion(`@${agentName} ${prompt}`);
}

/** Creates rate limit error response */
function createRateLimitResponse(): { status: 429; headers: Record<string, string>; body: string } {
  return {
    status: 429,
    headers: { "Retry-After": "5", "Content-Type": "application/json" },
    body: JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }),
  };
}
```

### Mock LLM Response Formats

**Instant completion (idle → busy → idle):**

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Done." },
      "finish_reason": "stop"
    }
  ]
}
```

**Tool call (permission.updated):**

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "bash",
              "arguments": "{\"command\": \"echo hello\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

**Rate limit (retry status):**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 5
Content-Type: application/json

{"error": {"message": "Rate limit exceeded", "type": "rate_limit_error"}}
```

**Sub-agent trigger (child session):**

Sub-agents are triggered by `@agent-name` mentions in text, NOT tool_calls:

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "@general Please search for all TypeScript files in the src directory and report what you find."
      },
      "finish_reason": "stop"
    }
  ]
}
```

Built-in subagents: `@general`, `@explore`

### Resolved Questions

1. **Sub-agent trigger mechanism**: Sub-agents are triggered by `@agent-name` mentions in the model's text response (NOT a tool_call). Built-in subagents: `@general`, `@explore`. The mock LLM returns text like `"@general Please search for files"` to trigger child session creation.

2. **Permission handling in tests**: Use `permission.bash = "ask"` to make opencode wait for approval, then respond via SDK:

   ```typescript
   await sdk.postSessionIdPermissionsPermissionId({
     path: { id: sessionId, permissionId: permissionId },
     body: { response: "once" | "always" | "reject" },
   });
   ```

   This allows testing the full permission flow: receive `permission.updated` → respond via SDK → receive `permission.replied`.

3. **Session cleanup**: Use `sdk.session.delete({ path: { id: sessionId } })` for cleanup within a test suite, or restart the opencode process between test suites for full isolation.
