/**
 * Mock LLM Server for OpenCode boundary tests.
 *
 * A thin `MockLlmMode` façade over `@copilotkit/aimock`, which serves the actual
 * OpenAI-compatible endpoints. It used to hand-roll the wire format; aimock
 * speaks it (and the Anthropic one the e2e suite needs), keeps up with the real
 * APIs through its own drift-detection CI, and is what `e2e/agent-mock.ts` uses
 * — so there is one mock in the repo rather than two.
 *
 * The modes stay, because they are how the boundary tests name the scenario
 * under test. Each one is a fixture set, swapped in on `setMode()`.
 *
 * @example
 * ```ts
 * const server = createMockLlmServer();
 * await server.start();
 *
 * server.setMode('instant');  // Quick response
 * server.setMode('tool-call'); // Triggers permission request
 * server.setMode('rate-limit'); // Returns 429
 *
 * await server.stop();
 * ```
 */

import { LLMock } from "@copilotkit/aimock";

// ============================================================================
// Types
// ============================================================================

/**
 * Mode for mock LLM server responses.
 *
 * | Mode          | Response Behavior                   | Triggers                 |
 * | ------------- | ----------------------------------- | ------------------------ |
 * | `instant`     | Return completion immediately       | idle → busy → idle       |
 * | `slow-stream` | Stream slowly enough to observe     | Extended busy state      |
 * | `tool-call`   | Return `bash` tool_call             | permission.updated event |
 * | `rate-limit`  | Return HTTP 429 with `Retry-After`  | retry status             |
 */
export type MockLlmMode = "instant" | "slow-stream" | "tool-call" | "rate-limit";

/**
 * Mock LLM server handle.
 */
export interface MockLlmServer {
  /** Get the port the server is listening on */
  readonly port: number;
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** Set the response mode */
  setMode(mode: MockLlmMode): void;
}

// ============================================================================
// Fixture sets
// ============================================================================

/**
 * Install the fixtures for one mode. First match wins, so the order within each
 * mode is part of its meaning.
 */
function applyMode(mock: LLMock, mode: MockLlmMode): void {
  mock.clearFixtures();

  switch (mode) {
    case "slow-stream":
      // Slow enough that a status read taken shortly after the prompt starts
      // still lands mid-stream.
      mock.on(
        {},
        { content: "This is a slow streamed response." },
        {
          streamingProfile: { ttft: 300, tps: 5 },
        }
      );
      return;

    case "tool-call":
      // Requests that advertise no tools (opencode's title-generation agent)
      // must not consume the tool-call slot: they would leave the build agent
      // with a plain completion and no permission flow.
      mock.on({ predicate: (req) => (req.tools?.length ?? 0) === 0 }, { content: "ok" });
      // The result of the bash call comes back on the same conversation.
      mock.on({ hasToolResult: true }, { content: "Tool executed successfully." });
      // The bash tool's schema requires `description` alongside `command`.
      mock.on(
        {},
        {
          toolCalls: [
            {
              name: "bash",
              arguments: { command: "echo hello", description: "Prints hello to stdout" },
            },
          ],
        }
      );
      return;

    case "rate-limit":
      // Only the first request in this group is rate limited; the retry then
      // falls through to the completion below.
      mock.on(
        { sequenceIndex: 0 },
        { error: { message: "Rate limit exceeded", type: "rate_limit_error" }, status: 429 }
      );
      mock.on({}, { content: "Recovered from rate limit." });
      return;

    case "instant":
    default:
      mock.on({}, { content: "Done." });
      return;
  }
}

// ============================================================================
// Server Implementation
// ============================================================================

/**
 * Create a mock LLM server for testing.
 *
 * The server implements the OpenAI chat completions API (`/v1/chat/completions`)
 * and can be configured to return different response types.
 *
 * @param port - Port to listen on (0 for auto-assign)
 * @returns MockLlmServer handle
 */
export function createMockLlmServer(port = 0): MockLlmServer {
  // Deliberately NOT strict: these fixtures are catch-alls by design, and a
  // boundary test's subject is opencode's behaviour, not the request shape.
  const mock = new LLMock({ port, host: "127.0.0.1" });
  applyMode(mock, "instant");
  let started = false;

  return {
    get port(): number {
      if (!started) {
        throw new Error("Server not started yet - port not assigned");
      }
      return mock.port;
    },

    async start(): Promise<void> {
      if (started) return;
      await mock.start();
      started = true;
    },

    async stop(): Promise<void> {
      if (!started) return;
      await mock.stop();
      started = false;
    },

    setMode(mode: MockLlmMode): void {
      applyMode(mock, mode);
      // Sequence counts are per fixture group; a mode swap must not inherit the
      // previous mode's counter.
      mock.resetMatchCounts();
    },
  };
}
