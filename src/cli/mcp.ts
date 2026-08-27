/**
 * `ch mcp` — CodeHydra's MCP server, spoken over stdio.
 *
 * This replaces the HTTP MCP server that used to live inside the app. Agents
 * launch it as a subprocess; it holds one connection to the running CodeHydra
 * for the life of the session and forwards tool calls onto the wire.
 *
 * The tool list is not compiled in. It is fetched from the app's registry at
 * startup, which is what makes the tools an agent sees and the commands `ch`
 * offers the same set by construction.
 *
 * The low-level `Server` is used rather than the higher-level helper because the
 * app describes each operation with JSON Schema, and that is exactly what a tool
 * definition carries — going through the zod-shaped API would mean converting
 * back into zod only for the SDK to convert forward again.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { DESCRIBE_CHANNEL, type OperationDescriptor } from "../api/adapters/describe";
import { OPERATION_CHANNEL_PREFIX } from "../api/adapters/plugin";
import type { Client } from "./client";

/**
 * Cross-tool guidance an agent needs before it has loaded any tool schema.
 *
 * Deliberately short. What an agent needs to know about its environment lives in
 * the CodeHydra system prompt, which is always in context; anything a tool's own
 * description already says is not repeated here. The report_bug restraint is the
 * one duplicate on purpose — a rule about NOT calling a tool has to be in
 * context before the tool's schema is first loaded.
 */
export const SERVER_INSTRUCTIONS = [
  "When creating a workspace, pass an optional prompt to tell the new workspace's agent what to do.",
  "",
  "report_bug files a bug report about CodeHydra itself with the maintainers. Use it only when the user explicitly asks to report a CodeHydra bug or send feedback — never proactively. It attaches CodeHydra's current logs and redacted config and sends even if telemetry is off.",
].join("\n");

/** A tool result, in the shape the protocol expects. */
function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Serve MCP over stdio until the transport closes.
 *
 * Resolves when stdin ends, which is how an agent shuts a stdio server down.
 */
export async function serveMcp(client: Client, version: string): Promise<void> {
  const descriptors = await client.call<readonly OperationDescriptor[]>(DESCRIBE_CHANNEL, {
    target: "mcp",
  });

  const byTool = new Map<string, OperationDescriptor>();
  for (const descriptor of descriptors) {
    if (descriptor.tool !== undefined) byTool.set(descriptor.tool, descriptor);
  }

  const server = new Server(
    { name: "codehydra", version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...byTool.entries()].map(([tool, descriptor]) => ({
      name: tool,
      // The one-line summary and the long-form guidance are separate fields in
      // the registry so `ch --help` can stay terse; a tool description is the
      // only place an agent sees either, so both are joined here.
      description: descriptor.instructions
        ? `${descriptor.description}\n\n${descriptor.instructions}`
        : descriptor.description,
      inputSchema: descriptor.inputSchema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const descriptor = byTool.get(request.params.name);
    if (!descriptor) {
      return toolResult(`Unknown tool: ${request.params.name}`, true);
    }

    try {
      const data = await client.call<unknown>(
        `${OPERATION_CHANNEL_PREFIX}${descriptor.name}`,
        request.params.arguments ?? {}
      );
      return toolResult(data);
    } catch (error: unknown) {
      // Reported as a tool error rather than thrown: a failed operation is a
      // result the agent should read and act on, not a broken server.
      return toolResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // An agent shuts a stdio server down by closing our stdin, so that is the
  // signal to stop serving. `server.onclose` alone is not enough to rely on:
  // whether it fires depends on the transport propagating the stream's end, and
  // a server that outlives its agent leaks a process per session. Watching
  // stdin directly makes the exit unconditional.
  //
  // `transport.onclose` is deliberately not touched — connect() owns it, and
  // overwriting it would skip the server's own cleanup.
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    server.onclose = finish;
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.once("error", finish);
  });
}
