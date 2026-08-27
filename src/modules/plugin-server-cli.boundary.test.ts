/**
 * Boundary tests for the CLI and MCP client kinds on the plugin wire.
 *
 * These run against a real Socket.IO server, because the things worth proving
 * here are all handshake behaviour: who is admitted, what they may call, and —
 * most importantly — that admitting them cannot disturb the sidekick connection
 * or a teardown waiting on it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod/v4";
import {
  createPluginServerEnv,
  waitForConnect,
  waitForDisconnect,
} from "./plugin-server.test-utils";
import { OperationRegistry } from "../api/registry";
import { defineEntry } from "../api/types";
import { workspacePathSchema, type WorkspacePath } from "../intents/contract";
import type { ClientEvent } from "../api/events";
import type { DomainEvent } from "../intents/lib/types";

const WS = workspacePathSchema.parse("/repo/wt/feature") as WorkspacePath;
const TOKEN = "test-token";

/** A registry holding two operations: one workspace-scoped, one app-global. */
function testRegistry(seen: { workspacePath: unknown }[] = []) {
  return new OperationRegistry([
    defineEntry({
      name: "workspace.status",
      kind: "command",
      description: "Get workspace status.",
      input: z.object({}),
      requiresWorkspace: true,
      handler: async (ctx) => {
        seen.push({ workspacePath: ctx.workspacePath });
        return { dirty: false };
      },
    }),
    defineEntry({
      name: "project.list",
      kind: "command",
      description: "List projects.",
      input: z.object({}),
      requiresWorkspace: false,
      handler: async (ctx) => {
        seen.push({ workspacePath: ctx.workspacePath });
        return [];
      },
    }),
  ]);
}

type Env = Awaited<ReturnType<typeof createPluginServerEnv>>;
let env: Env | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/**
 * Emit and wait for the acknowledgement.
 *
 * The typed client only knows the extension-facing channels; these tests speak
 * the operation-name channels deliberately, so the emit is untyped here.
 */
function call(
  client: unknown,
  channel: string,
  request: unknown = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const emit = (client as { emit: (event: string, ...args: unknown[]) => void }).emit.bind(client);
  return new Promise((resolve) => {
    emit(channel, request, resolve);
  });
}

describe("CLI clients on the plugin wire", () => {
  describe("authentication", () => {
    it("admits a client presenting the right token", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const client = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });

      client.connect();
      await expect(waitForConnect(client)).resolves.toBeUndefined();
    });

    it("turns away a client presenting the wrong token", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const client = env.createCliClient({ client: "cli", token: "guessed", cwd: WS });

      client.connect();
      await expect(waitForDisconnect(client)).resolves.toBeUndefined();
    });

    it("turns away a client presenting no token at all", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const client = env.createCliClient({ client: "cli", cwd: WS });

      client.connect();
      await expect(waitForDisconnect(client)).resolves.toBeUndefined();
    });

    it("refuses every CLI client when no token has been published", async () => {
      // The posture before app:start has generated one: refuse, rather than
      // silently accepting unauthenticated callers.
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: null });
      const client = env.createCliClient({ client: "cli", token: "anything", cwd: WS });

      client.connect();
      await expect(waitForDisconnect(client)).resolves.toBeUndefined();
    });

    it("turns away an unknown client kind", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const client = env.createCliClient({ client: "impostor", token: TOKEN, cwd: WS });

      client.connect();
      await expect(waitForDisconnect(client)).resolves.toBeUndefined();
    });

    it("still admits a sidekick, whose handshake carries no token", async () => {
      // The extension handshake is a published contract and must not change.
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const sidekick = env.createClient(WS);

      sidekick.connect();
      await expect(waitForConnect(sidekick)).resolves.toBeUndefined();
    });
  });

  describe("non-exclusivity", () => {
    it("does not displace the sidekick", async () => {
      // The whole reason CLI clients stay out of the connection registry: a
      // duplicate sidekick connection disconnects the incumbent, and every `ch`
      // invocation would otherwise do exactly that.
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const sidekick = env.createClient(WS);
      sidekick.connect();
      await waitForConnect(sidekick);

      const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      cli.connect();
      await waitForConnect(cli);

      expect(sidekick.connected).toBe(true);
    });

    it("admits several CLI clients on one workspace at once", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });

      const first = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      const second = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      first.connect();
      second.connect();
      await waitForConnect(first);
      await waitForConnect(second);

      expect(first.connected).toBe(true);
      expect(second.connected).toBe(true);
    });
  });

  describe("operations", () => {
    it("addresses operations by registry name", async () => {
      const seen: { workspacePath: unknown }[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:workspace.status");

      expect(result).toEqual({ success: true, data: { dirty: false } });
      expect(seen).toEqual([{ workspacePath: WS }]);
    });

    it("does not answer the extension-facing channel names", async () => {
      // Those exist for backwards compatibility with extensions; `ch` must not
      // depend on them, so it cannot reach them.
      const seen: { workspacePath: unknown }[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      cli.connect();
      await waitForConnect(cli);

      const acked = await Promise.race([
        call(cli, "api:workspace:getStatus"),
        new Promise((resolve) => setTimeout(() => resolve("no-handler"), 300)),
      ]);

      expect(acked).toBe("no-handler");
      expect(seen).toEqual([]);
    });

    it("serves the registry description so a client can build its surface", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:registry:describe", { target: "cli" });

      expect(result.success).toBe(true);
      expect((result.data as { name: string }[]).map((d) => d.name)).toContain("workspace.status");
    });
  });

  describe("workspace-less clients", () => {
    it("admits a client that names no workspace", async () => {
      // A shell standing outside any worktree is a legitimate caller.
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const cli = env.createCliClient({ client: "cli", token: TOKEN });

      cli.connect();
      await expect(waitForConnect(cli)).resolves.toBeUndefined();
    });

    it("runs app-global operations for it", async () => {
      const seen: { workspacePath: unknown }[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:project.list");

      expect(result).toEqual({ success: true, data: [] });
      expect(seen).toEqual([{ workspacePath: null }]);
    });

    it("refuses workspace-scoped operations with a message naming the reason", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const cli = env.createCliClient({ client: "cli", token: TOKEN });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:workspace.status");

      expect(result.success).toBe(false);
      expect(result.error).toContain("workspace");
    });
  });
});

describe("forwarded events", () => {
  /** Collect events a client receives on the forwarded-event channel. */
  function collect(client: unknown): ClientEvent[] {
    const received: ClientEvent[] = [];
    (client as { on: (channel: string, handler: (event: ClientEvent) => void) => void }).on(
      "api:event",
      (event) => received.push(event)
    );
    return received;
  }

  it("pushes a domain event to a CLI client", async () => {
    // The whole point: `ch ws delete` sits through a multi-step pipeline, and
    // without this it sees nothing until the pipeline finishes.
    env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
    const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
    cli.connect();
    await waitForConnect(cli);
    const received = collect(cli);

    env.emitDomainEvent({
      type: "workspace:deletion-progress",
      payload: { workspacePath: WS, completed: false, operations: [] },
    } as DomainEvent);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.type).toBe("workspace:deletion-progress");
  });

  it("does not push another workspace's event to a scoped client", async () => {
    env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
    const cli = env.createCliClient({ client: "cli", token: TOKEN, workspacePath: WS });
    cli.connect();
    await waitForConnect(cli);
    const received = collect(cli);

    env.emitDomainEvent({
      type: "workspace:deletion-progress",
      payload: { workspacePath: "/somewhere/else", completed: false, operations: [] },
    } as DomainEvent);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual([]);
  });

  it("pushes an instance-wide event to a workspace-less client", async () => {
    // A clone has no workspace, and a shell outside every worktree is exactly
    // where `ch project open <url>` is run.
    env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
    const cli = env.createCliClient({ client: "cli", token: TOKEN });
    cli.connect();
    await waitForConnect(cli);
    const received = collect(cli);

    env.emitDomainEvent({
      type: "clone:progress",
      payload: { stage: "receiving", progress: 10, name: "repo", url: "u" },
    } as DomainEvent);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.type).toBe("clone:progress");
  });

  it("does not push events to a sidekick", async () => {
    // The extension has its own channels; this one exists for CLI clients.
    env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
    const sidekick = env.createClient(WS);
    sidekick.connect();
    await waitForConnect(sidekick);
    const received = collect(sidekick);

    env.emitDomainEvent({
      type: "workspace:deletion-progress",
      payload: { workspacePath: WS, completed: false, operations: [] },
    } as DomainEvent);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual([]);
  });
});
