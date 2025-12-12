/**
 * Mock LLM Server for OpenCode boundary tests.
 *
 * Provides an OpenAI-compatible API endpoint that can be configured
 * to return different response types for testing various scenarios.
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

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";

// ============================================================================
// Types
// ============================================================================

/**
 * Mode for mock LLM server responses.
 *
 * | Mode          | Response Behavior                   | Triggers                 |
 * | ------------- | ----------------------------------- | ------------------------ |
 * | `instant`     | Return completion immediately       | idle → busy → idle       |
 * | `slow-stream` | Stream with 100ms delays            | Extended busy state      |
 * | `tool-call`   | Return `bash` tool_call             | permission.updated event |
 * | `rate-limit`  | Return HTTP 429 with `Retry-After`  | retry status             |
 * | `sub-agent`   | Return `task` tool_call             | Child session creation   |
 */
export type MockLlmMode = "instant" | "slow-stream" | "tool-call" | "rate-limit" | "sub-agent";

/**
 * Chat completion response structure (OpenAI format).
 */
export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: "stop" | "tool_calls";
  }>;
}

/**
 * Tool call structure.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Rate limit error response.
 */
export interface RateLimitResponse {
  status: 429;
  headers: Record<string, string>;
  body: string;
}

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
// Response Builders
// ============================================================================

/**
 * Generate a random ID for completions.
 */
function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Creates instant completion response.
 *
 * @param content - Text content to return
 * @returns ChatCompletion with the content
 */
export function createInstantCompletion(content: string): ChatCompletion {
  return {
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Creates tool call completion (triggers permission request).
 *
 * IMPORTANT: For bash tool, args must include `command` AND `description`.
 * The description parameter is required by OpenCode's bash tool schema.
 *
 * @param toolName - Name of the tool to call
 * @param args - Arguments for the tool (e.g., { command: "ls", description: "List files" })
 * @returns ChatCompletion with tool_calls
 */
export function createToolCallCompletion(
  toolName: string,
  args: Record<string, unknown>
): ChatCompletion {
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
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * Creates sub-agent trigger response (legacy method).
 *
 * NOTE: Sub-agents are actually triggered via the `task` tool call, not `@mentions`.
 * Use `createToolCallCompletion("task", { description, prompt })` instead.
 *
 * This function is kept for backward compatibility but produces incorrect output.
 *
 * @param agentName - Name of the agent (unused - task tool doesn't use agent names)
 * @param prompt - Prompt text (included in response text, but won't trigger sub-agent)
 * @returns ChatCompletion with text content (won't create child session)
 * @deprecated Use createToolCallCompletion("task", {...}) instead
 */
export function createSubAgentCompletion(agentName: string, prompt: string): ChatCompletion {
  return createInstantCompletion(`@${agentName} ${prompt}`);
}

/**
 * Creates rate limit error response.
 *
 * @returns Rate limit response object with status, headers, and body
 */
export function createRateLimitResponse(): RateLimitResponse {
  return {
    status: 429,
    headers: {
      "Retry-After": "5",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit_error",
      },
    }),
  };
}

// ============================================================================
// Streaming Helpers
// ============================================================================

/**
 * Delay for streaming chunks in slow-stream mode.
 */
const STREAM_CHUNK_DELAY_MS = 50;

/**
 * Creates SSE stream chunks for a completion.
 */
function createStreamChunks(content: string): string[] {
  const words = content.split(" ");
  const chunks: string[] = [];
  const completionId = `chatcmpl-${randomId()}`;

  for (const word of words) {
    const chunk = {
      id: completionId,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { content: word + " " },
        },
      ],
    };
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  // Add final chunk with finish_reason to signal completion
  const finalChunk = {
    id: completionId,
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  chunks.push(`data: ${JSON.stringify(finalChunk)}\n\n`);

  // Add done signal
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

/**
 * Creates SSE stream chunks for a tool call.
 * Streaming tool calls have a specific format with incremental arguments.
 */
function createToolCallStreamChunks(toolName: string, args: Record<string, unknown>): string[] {
  const chunks: string[] = [];
  const callId = `call_${randomId()}`;
  const argsString = JSON.stringify(args);

  // First chunk: tool call start with function name
  chunks.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: toolName, arguments: "" },
              },
            ],
          },
        },
      ],
    })}\n\n`
  );

  // Second chunk: arguments
  chunks.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: argsString },
              },
            ],
          },
        },
      ],
    })}\n\n`
  );

  // Final chunk: finish_reason
  chunks.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n`
  );

  // Done signal
  chunks.push("data: [DONE]\n\n");
  return chunks;
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
  let server: Server | null = null;
  let serverPort = port;
  let currentMode: MockLlmMode = "instant";
  let rateLimitRequestCount = 0; // Track requests to allow recovery after first rate limit
  let toolCallRequestCount = 0; // Track requests to return completion after tool execution
  let subAgentRequestCount = 0; // Track requests for sub-agent task tool flow

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Handle various OpenAI-compatible endpoints
    // GET /v1/models - list available models
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/path")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "test", object: "model", created: Date.now(), owned_by: "mock" }],
        })
      );
      return;
    }

    // Only handle POST /v1/chat/completions
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Parse request body
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
    });

    const request = JSON.parse(body) as { stream?: boolean };
    const isStreaming = request.stream === true;

    // Handle based on mode
    switch (currentMode) {
      case "rate-limit": {
        // Return 429 only on first request, then recover with instant response
        rateLimitRequestCount++;
        if (rateLimitRequestCount === 1) {
          const response = createRateLimitResponse();
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        } else {
          // After first rate limit, return normal response
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            const chunks = createStreamChunks("Recovered from rate limit.");
            for (const chunk of chunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            const completion = createInstantCompletion("Recovered from rate limit.");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completion));
          }
        }
        break;
      }

      case "slow-stream": {
        // Force streaming mode for slow-stream
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const chunks = createStreamChunks("This is a slow streamed response.");
        for (const chunk of chunks) {
          res.write(chunk);
          await new Promise((resolve) => setTimeout(resolve, STREAM_CHUNK_DELAY_MS));
        }
        res.end();
        break;
      }

      case "tool-call": {
        // Return tool call only on first request, then return completion
        // This simulates a proper conversation flow:
        // 1. First request: LLM returns tool call
        // 2. Second request: OpenCode sends tool result, LLM responds with completion
        toolCallRequestCount++;
        if (toolCallRequestCount === 1) {
          if (isStreaming) {
            // Stream tool call in SSE format
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            const chunks = createToolCallStreamChunks("bash", {
              command: "echo hello",
              description: "Prints hello to stdout",
            });
            for (const chunk of chunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            const completion = createToolCallCompletion("bash", {
              command: "echo hello",
              description: "Prints hello to stdout",
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completion));
          }
        } else {
          // After tool execution, return a normal completion
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            const chunks = createStreamChunks("Tool executed successfully.");
            for (const chunk of chunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            const completion = createInstantCompletion("Tool executed successfully.");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completion));
          }
        }
        break;
      }

      case "sub-agent": {
        // Sub-agents are triggered via the `task` tool call, which creates a child session
        subAgentRequestCount++;
        if (subAgentRequestCount === 1) {
          // First call: Return task tool call to create child session
          const taskArgs = {
            description: "Search TypeScript files",
            prompt: "Please search for all TypeScript files in the project",
          };
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            const chunks = createToolCallStreamChunks("task", taskArgs);
            for (const chunk of chunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            const completion = createToolCallCompletion("task", taskArgs);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completion));
          }
        } else {
          // Subsequent calls: Child session or parent follow-up - return completion
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            const chunks = createStreamChunks("Task completed.");
            for (const chunk of chunks) {
              res.write(chunk);
            }
            res.end();
          } else {
            const completion = createInstantCompletion("Task completed.");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completion));
          }
        }
        break;
      }

      case "instant":
      default: {
        if (isStreaming) {
          // Stream even for instant mode if requested
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const chunks = createStreamChunks("Done.");
          for (const chunk of chunks) {
            res.write(chunk);
          }
          res.end();
        } else {
          const completion = createInstantCompletion("Done.");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(completion));
        }
        break;
      }
    }
  };

  return {
    get port(): number {
      if (serverPort === 0) {
        throw new Error("Server not started yet - port not assigned");
      }
      return serverPort;
    },

    async start(): Promise<void> {
      if (server) return;

      server = createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          console.error("Mock LLM server error:", error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.listen(serverPort, "localhost", () => {
          const addr = server!.address();
          if (addr && typeof addr === "object") {
            serverPort = addr.port;
            resolve();
          } else {
            reject(new Error("Failed to get server address"));
          }
        });
        server!.on("error", reject);
      });
    },

    async stop(): Promise<void> {
      if (!server) return;

      await new Promise<void>((resolve) => {
        server!.close(() => {
          server = null;
          resolve();
        });
      });
    },

    setMode(mode: MockLlmMode): void {
      currentMode = mode;
      // Reset request counters when switching modes
      rateLimitRequestCount = 0;
      toolCallRequestCount = 0;
      subAgentRequestCount = 0;
    },
  };
}
