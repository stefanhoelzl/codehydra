/**
 * Tests for mock LLM server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createMockLlmServer,
  type MockLlmServer,
  createInstantCompletion,
  createToolCallCompletion,
  createSubAgentCompletion,
  createRateLimitResponse,
} from "./mock-llm-server";

describe("createMockLlmServer", () => {
  let server: MockLlmServer;

  beforeAll(async () => {
    server = createMockLlmServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns instant completion in instant mode", async () => {
    server.setMode("instant");

    const response = await fetch(`http://localhost:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      id: string;
      choices: { message: { content: string } }[];
    };
    expect(data.id).toMatch(/^chatcmpl-/);
    expect(data.choices).toHaveLength(1);
    expect(data.choices[0]!.message.content).toBe("Done.");
  });

  it("returns tool call in tool-call mode", async () => {
    server.setMode("tool-call");

    const response = await fetch(`http://localhost:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Run echo hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      choices: {
        message: { tool_calls: { function: { name: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0]!;
    expect(choice.message.tool_calls).toBeDefined();
    expect(choice.message.tool_calls[0]!.function.name).toBe("bash");
    expect(choice.finish_reason).toBe("tool_calls");
  });

  it("returns 429 in rate-limit mode", async () => {
    server.setMode("rate-limit");

    const response = await fetch(`http://localhost:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const data = (await response.json()) as { error: { message: string } };
    expect(data.error.message).toBe("Rate limit exceeded");
  });

  it("returns task tool call in sub-agent mode", async () => {
    server.setMode("sub-agent");

    const response = await fetch(`http://localhost:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Search files" }],
      }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      choices: {
        message: { tool_calls: { function: { name: string; arguments: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(data.choices).toHaveLength(1);
    const choice = data.choices[0]!;
    expect(choice.message.tool_calls).toBeDefined();
    expect(choice.message.tool_calls[0]!.function.name).toBe("task");
    expect(choice.finish_reason).toBe("tool_calls");

    // Verify task tool arguments contain description and prompt
    const args = JSON.parse(choice.message.tool_calls[0]!.function.arguments) as {
      description: string;
      prompt: string;
    };
    expect(args.description).toBeDefined();
    expect(args.prompt).toBeDefined();
  });

  it("streams response with delays in slow-stream mode", async () => {
    server.setMode("slow-stream");

    const startTime = Date.now();
    const response = await fetch(`http://localhost:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);

    // Read the stream
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        chunks.push(new TextDecoder().decode(value));
      }
    }

    const elapsed = Date.now() - startTime;

    // Should have multiple chunks with delays
    expect(chunks.length).toBeGreaterThan(1);
    // Should take at least some time due to streaming delays
    expect(elapsed).toBeGreaterThan(50);
  });
});

describe("response builders", () => {
  it("createInstantCompletion creates valid response", () => {
    const completion = createInstantCompletion("Test content");
    const choice = completion.choices[0];

    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.object).toBe("chat.completion");
    expect(choice?.message.content).toBe("Test content");
    expect(choice?.finish_reason).toBe("stop");
  });

  it("createToolCallCompletion creates valid tool call", () => {
    // Note: For bash tool, OpenCode requires both 'command' and 'description' parameters
    const completion = createToolCallCompletion("bash", {
      command: "echo hello",
      description: "Prints hello",
    });
    const choice = completion.choices[0];
    const toolCall = choice?.message.tool_calls?.[0];

    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toHaveLength(1);
    expect(toolCall?.function.name).toBe("bash");
    expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toEqual({
      command: "echo hello",
      description: "Prints hello",
    });
    expect(choice?.finish_reason).toBe("tool_calls");
  });

  it("createSubAgentCompletion creates agent mention", () => {
    const completion = createSubAgentCompletion("general", "Search for files");
    const choice = completion.choices[0];

    expect(choice?.message.content).toBe("@general Search for files");
  });

  it("createRateLimitResponse creates 429 response", () => {
    const response = createRateLimitResponse();

    expect(response.status).toBe(429);
    expect(response.headers["Retry-After"]).toBe("5");
    expect(JSON.parse(response.body).error.type).toBe("rate_limit_error");
  });
});
