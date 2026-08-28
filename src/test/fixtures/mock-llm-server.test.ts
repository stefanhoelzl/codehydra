/**
 * Tests for mock LLM server.
 *
 * The wire format is aimock's problem now; what is ours is the fixture set
 * behind each mode. A typo in one of those would otherwise surface only as a
 * confusing failure in a slow opencode boundary test, so assert them here over
 * real HTTP — the same way opencode reaches the server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMockLlmServer, type MockLlmServer } from "./mock-llm-server";

interface Completion {
  readonly choices: readonly {
    readonly message: {
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    };
    readonly finish_reason: string;
  }[];
}

describe("createMockLlmServer", () => {
  let server: MockLlmServer;

  beforeAll(async () => {
    server = createMockLlmServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  /** POST a chat completion the way the openai-compatible provider would. */
  async function complete(
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Completion }> {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", ...body }),
    });
    const json = response.status === 200 ? ((await response.json()) as Completion) : ({} as never);
    return { status: response.status, json };
  }

  it("returns instant completion in instant mode", async () => {
    server.setMode("instant");

    const { status, json } = await complete({ messages: [{ role: "user", content: "Hello" }] });

    expect(status).toBe(200);
    expect(json.choices[0]?.message.content).toBe("Done.");
    expect(json.choices[0]?.finish_reason).toBe("stop");
  });

  it("returns a bash tool call in tool-call mode", async () => {
    server.setMode("tool-call");

    const { json } = await complete({
      messages: [{ role: "user", content: "Run something" }],
      tools: [{ type: "function", function: { name: "bash" } }],
    });

    const call = json.choices[0]?.message.tool_calls?.[0];
    expect(call?.function.name).toBe("bash");
    // opencode's bash schema requires both; a call missing `description` is
    // rejected before any permission event is emitted.
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
      command: "echo hello",
      description: "Prints hello to stdout",
    });
  });

  it("does not spend the tool-call slot on a request that carries no tools", async () => {
    server.setMode("tool-call");

    // opencode's title-generation agent prompts without tools.
    const titling = await complete({ messages: [{ role: "user", content: "Title this" }] });
    expect(titling.json.choices[0]?.message.content).toBe("ok");

    const build = await complete({
      messages: [{ role: "user", content: "Run something" }],
      tools: [{ type: "function", function: { name: "bash" } }],
    });
    expect(build.json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("bash");
  });

  it("answers with text once the tool result comes back", async () => {
    server.setMode("tool-call");

    const { json } = await complete({
      messages: [
        { role: "user", content: "Run something" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", tool_call_id: "call_1", content: "hello" },
      ],
      tools: [{ type: "function", function: { name: "bash" } }],
    });

    expect(json.choices[0]?.message.content).toBe("Tool executed successfully.");
  });

  it("returns 429 once in rate-limit mode, then recovers", async () => {
    server.setMode("rate-limit");

    const first = await complete({ messages: [{ role: "user", content: "Hi" }] });
    expect(first.status).toBe(429);

    const retry = await complete({ messages: [{ role: "user", content: "Hi" }] });
    expect(retry.status).toBe(200);
    expect(retry.json.choices[0]?.message.content).toBe("Recovered from rate limit.");
  });

  it("streams slowly enough to observe a busy window in slow-stream mode", async () => {
    server.setMode("slow-stream");

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        messages: [{ role: "user", content: "Stream this slowly" }],
      }),
    });
    const body = await response.text();
    const elapsed = Date.now() - started;

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("data: ");
    // The point of the mode: the stream is still open long enough for a status
    // read taken during it to see "busy".
    expect(elapsed).toBeGreaterThan(300);
  });
});
