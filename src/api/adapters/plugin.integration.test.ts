// @vitest-environment node
/**
 * Integration tests for the plugin adapter.
 *
 * Drives the adapter through a fake socket, so these cover the generic loop
 * itself: channel mounting, both ack shapes the protocol uses, fire-and-forget,
 * and the failure translation the sidekick sees.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { attachPluginAdapter, type AdapterSocket, type PluginResult } from "./plugin";
import { OperationRegistry } from "../registry";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import { workspacePathSchema } from "../../intents/contract";
import { createRegistry } from "../entries";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { testPath } from "../../shared/test-fixtures";

/** The real registry, for the tests that assert on the real mappings. */
function realRegistry() {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
    },
    SILENT_LOGGER
  );
}

const WS = workspacePathSchema.parse(testPath("/repo/wt/feature").toNative());

/** A socket that records handlers so a test can emit into them directly. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket: AdapterSocket = {
    on: (event, listener) => {
      handlers.set(event, listener);
    },
  };
  return {
    socket,
    channels: () => [...handlers.keys()],
    /** Emit with a payload and an ack, as a channel that takes a request does. */
    call: (channel: string, request: unknown) =>
      new Promise<PluginResult<unknown>>((resolve) => {
        handlers.get(channel)!(request, resolve);
      }),
    /** Emit with only an ack, as a no-argument channel does. */
    callNoArgs: (channel: string) =>
      new Promise<PluginResult<unknown>>((resolve) => {
        handlers.get(channel)!(resolve);
      }),
    /** Emit with neither payload nor ack, as a fire-and-forget channel does. */
    emit: (channel: string, request: unknown) => {
      handlers.get(channel)!(request);
    },
  };
}

function build(
  entries: readonly AnyOperationEntry[],
  map: Record<string, { channel: string; fireAndForget?: boolean } | null>,
  workspacePath = WS as string | null
) {
  const harness = fakeSocket();
  attachPluginAdapter({
    socket: harness.socket,
    registry: new OperationRegistry(entries),
    workspacePath: workspacePath as never,
    logger: SILENT_LOGGER,
    kind: "sidekick",
    map,
  });
  return harness;
}

describe("plugin adapter", () => {
  it("mounts one channel per mapped operation, plus describe", () => {
    const harness = build(
      [
        defineEntry({
          name: "project.list",
          kind: "command",
          description: "a",
          input: z.object({}),
          requiresWorkspace: false,
          handler: async () => null,
        }),
        defineEntry({
          name: "log",
          kind: "command",
          description: "b",
          input: z.object({}),
          requiresWorkspace: false,
          handler: async () => null,
          // CLI only — must not appear on the wire.
        }),
      ],
      { "project.list": { channel: "api:a" }, log: null }
    );

    // describe is adapter infrastructure and is always mounted; `log` maps to
    // null and must not appear.
    expect(harness.channels()).toEqual(["api:registry:describe", "api:a"]);
  });

  it("acks a successful call with the handler's data", async () => {
    const harness = build(
      [
        defineEntry({
          name: "metadata.get",
          kind: "command",
          description: "echo",
          input: z.object({ value: z.string() }),
          requiresWorkspace: false,
          handler: async (_ctx, input) => ({ echoed: input.value }),
        }),
      ],
      { "metadata.get": { channel: "api:echo" } }
    );

    await expect(harness.call("api:echo", { value: "hi" })).resolves.toEqual({
      success: true,
      data: { echoed: "hi" },
    });
  });

  it("supports channels emitted with only an ack", async () => {
    const harness = build(
      [
        defineEntry({
          name: "agent.session",
          kind: "command",
          description: "noargs",
          input: z.object({}),
          requiresWorkspace: false,
          handler: async () => 42,
        }),
      ],
      { "agent.session": { channel: "api:noargs" } }
    );

    await expect(harness.callNoArgs("api:noargs")).resolves.toEqual({ success: true, data: 42 });
  });

  it("passes the connection's workspace to the handler", async () => {
    const seen: unknown[] = [];
    const harness = build(
      [
        defineEntry({
          name: "workspace.status",
          kind: "command",
          description: "ctx",
          input: z.object({}),
          requiresWorkspace: true,
          handler: async (ctx) => {
            seen.push(ctx.workspacePath);
            return null;
          },
        }),
      ],
      { "workspace.status": { channel: "api:ctx" } }
    );

    await harness.call("api:ctx", {});

    expect(seen).toEqual([WS]);
  });

  it("reports validation failures as an unsuccessful result", async () => {
    const harness = build(
      [
        defineEntry({
          name: "agent.status.set",
          kind: "command",
          description: "strict",
          input: z.object({ value: z.string() }),
          requiresWorkspace: false,
          handler: async () => null,
        }),
      ],
      { "agent.status.set": { channel: "api:strict" } }
    );

    const result = await harness.call("api:strict", { value: 7 });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("agent.status.set");
  });

  it("reports a thrown handler error without rejecting", async () => {
    const harness = build(
      [
        defineEntry({
          name: "workspace.delete",
          kind: "command",
          description: "boom",
          input: z.object({}),
          requiresWorkspace: false,
          handler: async () => {
            throw new Error("worktree is locked");
          },
        }),
      ],
      { "workspace.delete": { channel: "api:boom" } }
    );

    await expect(harness.call("api:boom", {})).resolves.toEqual({
      success: false,
      error: "worktree is locked",
    });
  });

  it("runs a fire-and-forget channel with no ack", async () => {
    const handler = vi.fn(async () => null);
    const harness = build(
      [
        defineEntry({
          name: "log",
          kind: "command",
          description: "log",
          input: z.object({ message: z.string() }),
          requiresWorkspace: false,
          handler,
        }),
      ],
      { log: { channel: "api:log", fireAndForget: true } }
    );

    expect(() => harness.emit("api:log", { message: "hello" })).not.toThrow();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("does not log a caller's own condition as an app fault", async () => {
    // Running a workspace command from outside a worktree is normal — it is what
    // exit code 4 exists for. Logging it at error level would put a fault in the
    // log and in every bug report for something working as designed.
    const logged: string[] = [];
    const logger = {
      ...SILENT_LOGGER,
      warn: (message: string) => logged.push(`warn:${message}`),
      error: (message: string) => logged.push(`error:${message}`),
    };

    const harness = fakeSocket();
    attachPluginAdapter({
      socket: harness.socket,
      registry: new OperationRegistry([
        defineEntry({
          name: "workspace.status",
          kind: "command",
          description: "Get status.",
          input: z.object({}),
          requiresWorkspace: true,
          handler: async () => null,
        }),
      ]),
      workspacePath: null as never,
      logger: logger as never,
      kind: "cli",
      map: { "workspace.status": { channel: "api:scoped" } },
    });

    await harness.call("api:scoped", {});

    expect(logged.filter((entry) => entry.startsWith("error:"))).toEqual([]);
    expect(logged.some((entry) => entry.startsWith("warn:"))).toBe(true);
  });

  it("rejects a workspace-scoped call on a workspace-less connection", async () => {
    const harness = build(
      [
        defineEntry({
          name: "workspace.hibernate",
          kind: "command",
          description: "scoped",
          input: z.object({}),
          requiresWorkspace: true,
          handler: async () => null,
        }),
      ],
      { "workspace.hibernate": { channel: "api:scoped" } },
      null
    );

    const result = await harness.call("api:scoped", {});

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("workspace");
  });
});

describe("client kinds", () => {
  function realWire(kind: "sidekick" | "cli" | "mcp") {
    const harness = fakeSocket();
    attachPluginAdapter({
      socket: harness.socket,
      registry: realRegistry(),
      workspacePath: WS,
      logger: SILENT_LOGGER,
      kind,
    });
    return harness;
  }

  it("gives the sidekick the historical channel names", () => {
    const channels = realWire("sidekick").channels();

    // These are a published contract that third-party extensions call.
    expect(channels).toContain("api:workspace:getStatus");
    expect(channels).toContain("api:workspace:agentLifecycle");
    expect(channels).not.toContain("api:operation:workspace.status");
  });

  it("gives new clients operation names instead", () => {
    const channels = realWire("cli").channels();

    expect(channels).toContain("api:operation:workspace.status");
    expect(channels).not.toContain("api:workspace:getStatus");
  });

  it("keeps the event off both new client kinds", () => {
    // Only the sidekick can witness the terminal event it reports.
    for (const kind of ["cli", "mcp"] as const) {
      expect(realWire(kind).channels(), kind).not.toContain("api:operation:agent.lifecycle");
    }
  });

  it("exposes the split message forms to the CLI but not to MCP", () => {
    expect(realWire("cli").channels()).toContain("api:operation:vscode.notify");
    // A tool takes structured arguments already, so MCP keeps only the general form.
    expect(realWire("mcp").channels()).not.toContain("api:operation:vscode.notify");
    expect(realWire("mcp").channels()).toContain("api:operation:vscode.message");
  });

  it("answers describe on every kind", () => {
    for (const kind of ["sidekick", "cli", "mcp"] as const) {
      expect(realWire(kind).channels(), kind).toContain("api:registry:describe");
    }
  });
});
