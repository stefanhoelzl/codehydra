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
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { lockEntries } from "../api/entries/lock";
import { createLockModule } from "./lock-module";
import { IntentHandle } from "../intents/lib/dispatcher";
import type { ProjectLocation } from "../api/workspace-lookup";
import { targetFields } from "../api/entries/target";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";

const WS = workspacePathSchema.parse("/repo/wt/feature") as WorkspacePath;
const TOKEN = "test-token";

/** What a test operation saw: the caller, and the input it was handed. */
interface Seen {
  readonly workspacePath: unknown;
  readonly input?: unknown;
}

/**
 * Calls held open until the test releases them, so events can be emitted while
 * one is in flight — the only time a client is shown any.
 */
function gate() {
  let open: () => void = () => {};
  let entered: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return { opened, reached, open: () => open(), enter: () => entered() };
}

/**
 * A registry of test operations: one workspace-scoped, one app-global, one that
 * takes the target fields, and two held open by `hold` — `workspace.delete`,
 * which resolves a target (the named path, else the caller), and
 * `workspace.create`, which has none.
 */
function testRegistry(seen: Seen[] = [], hold = gate()) {
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
    defineEntry({
      name: "workspace.title",
      kind: "command",
      description: "Set the title.",
      input: z.object({ ...targetFields, title: z.string().nullable() }),
      requiresWorkspace: true,
      handler: async (ctx, input) => {
        seen.push({ workspacePath: ctx.workspacePath, input });
        return null;
      },
    }),
    defineEntry({
      name: "workspace.delete",
      kind: "command",
      description: "Delete a workspace.",
      input: z.object(targetFields),
      requiresWorkspace: true,
      handler: async (ctx, input) => {
        ctx.onTarget?.(workspacePathSchema.parse(input.workspace ?? ctx.workspacePath));
        hold.enter();
        await hold.opened;
        return null;
      },
    }),
    defineEntry({
      name: "workspace.create",
      kind: "command",
      description: "Create a workspace.",
      input: z.object({}),
      requiresWorkspace: false,
      handler: async () => {
        hold.enter();
        await hold.opened;
        return null;
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

/** Answer the server's project listing — what a named workspace resolves against. */
function listProjectsReturns(projects: readonly ProjectLocation[]): void {
  env!.mockDispatch.mockImplementation(() => {
    const handle = new IntentHandle();
    handle.signalAccepted(true);
    handle.resolve(projects);
    return handle;
  });
}

const PROJECTS: readonly ProjectLocation[] = [
  { name: "repo", path: "/repo", workspaces: [{ name: "feature", path: WS }] },
  {
    name: "other",
    path: "/other",
    workspaces: [
      { name: "shared", path: "/other/wt/shared" },
      { name: "twin", path: "/other/wt/twin" },
    ],
  },
  { name: "third", path: "/third", workspaces: [{ name: "twin", path: "/third/wt/twin" }] },
];

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

      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
      cli.connect();
      await waitForConnect(cli);

      expect(sidekick.connected).toBe(true);
    });

    it("admits several CLI clients on one workspace at once", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });

      const first = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
      const second = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
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
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      listProjectsReturns(PROJECTS);
      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:workspace.status");

      expect(result).toEqual({ success: true, data: { dirty: false } });
      expect(seen).toMatchObject([{ workspacePath: WS }]);
    });

    it("does not answer the extension-facing channel names", async () => {
      // Those exist for backwards compatibility with extensions; `ch` must not
      // depend on them, so it cannot reach them.
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
      cli.connect();
      await waitForConnect(cli);

      const acked = await Promise.race([
        call(cli, "api:workspace:getStatus"),
        new Promise((resolve) => setTimeout(() => resolve("no-handler"), 300)),
      ]);

      expect(acked).toBe("no-handler");
      expect(seen).toMatchObject([]);
    });

    it("serves the registry description so a client can build its surface", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
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
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:project.list");

      expect(result).toEqual({ success: true, data: [] });
      expect(seen).toMatchObject([{ workspacePath: null }]);
    });

    it("refuses workspace-scoped operations with a message naming the reason", async () => {
      env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
      const cli = env.createCliClient({ client: "cli", token: TOKEN });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:workspace.status");

      expect(result).toMatchObject({ success: false, category: "no-workspace" });
      expect(result.error).toContain("workspace");
    });

    it("runs a workspace operation that names the workspace to act on", async () => {
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: "/elsewhere" });
      cli.connect();
      await waitForConnect(cli);

      const result = await call(cli, "api:operation:workspace.title", {
        workspace: "feature",
        title: "t",
      });

      expect(result).toMatchObject({ success: true });
      expect(seen).toEqual([{ workspacePath: null, input: { workspace: "feature", title: "t" } }]);
    });
  });

  describe("who the caller is", () => {
    it("is the workspace a shell stands in", async () => {
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      listProjectsReturns(PROJECTS);
      const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: `${WS}/src` });
      cli.connect();
      await waitForConnect(cli);

      await call(cli, "api:operation:workspace.status");

      expect(seen).toEqual([{ workspacePath: WS }]);
    });

    it("is the workspace the MCP shim presents, wherever it runs", async () => {
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      listProjectsReturns(PROJECTS);
      const mcp = env.createCliClient({
        client: "mcp",
        token: TOKEN,
        workspacePath: WS,
        cwd: "/other/wt/shared",
      });
      mcp.connect();
      await waitForConnect(mcp);

      await call(mcp, "api:operation:workspace.status");

      expect(seen).toEqual([{ workspacePath: WS }]);
    });

    it("is never a workspace a shell's handshake names", async () => {
      // A `ch` older than the app named its target there. Honouring it as the
      // caller would sign messages and resolve names as the wrong workspace.
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      listProjectsReturns(PROJECTS);
      const cli = env.createCliClient({
        client: "cli",
        token: TOKEN,
        workspacePath: "/other/wt/shared",
        cwd: WS,
      });
      cli.connect();
      await waitForConnect(cli);

      await call(cli, "api:operation:workspace.status");

      expect(seen).toEqual([{ workspacePath: WS }]);
    });
  });

  describe("the call's own target", () => {
    // What one surface once dropped: the MCP shim, connected as the CLI, lost
    // every tool's `workspace` to the CLI's shaping and acted on its caller.
    it.each([
      ["a shell", { client: "cli", token: TOKEN, cwd: WS }],
      ["the MCP shim", { client: "mcp", token: TOKEN, workspacePath: WS }],
    ])("reaches the operation from %s", async (_kind, auth) => {
      const seen: Seen[] = [];
      env = await createPluginServerEnv(undefined, {
        registry: testRegistry(seen),
        cliToken: TOKEN,
      });
      listProjectsReturns(PROJECTS);
      const client = env.createCliClient(auth);
      client.connect();
      await waitForConnect(client);

      await call(client, "api:operation:workspace.title", { workspace: "shared", title: "t" });

      expect(seen).toEqual([{ workspacePath: WS, input: { workspace: "shared", title: "t" } }]);
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

  const deletion = (workspacePath: string) =>
    ({
      type: "workspace:deletion-progress",
      payload: { workspacePath, completed: false, operations: [] },
    }) as DomainEvent;

  const clone = {
    type: "clone:progress",
    payload: { stage: "receiving", progress: 10, name: "repo", url: "u" },
  } as DomainEvent;

  /** A shell in WS with `channel` in flight, held open until `hold.open()`. */
  async function callInFlight(channel: string, request: unknown = {}) {
    const hold = gate();
    env = await createPluginServerEnv(undefined, {
      registry: testRegistry([], hold),
      cliToken: TOKEN,
    });
    listProjectsReturns(PROJECTS);
    const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    cli.connect();
    await waitForConnect(cli);
    const received = collect(cli);
    const done = call(cli, channel, request);
    await hold.reached;
    return { received, hold, done };
  }

  it("pushes the target's events to the call acting on it", async () => {
    // The whole point: `ch ws delete` sits through a multi-step pipeline, and
    // without this it sees nothing until the pipeline finishes.
    const { received, hold, done } = await callInFlight("api:operation:workspace.delete");

    env!.emitDomainEvent(deletion(WS));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.type).toBe("workspace:deletion-progress");
    hold.open();
    await done;
  });

  it("follows the target a call names, not where the caller stands", async () => {
    // `ch ws delete --workspace other`, run from inside WS.
    const other = "/other/wt/shared";
    const { received, hold, done } = await callInFlight("api:operation:workspace.delete", {
      workspace: other,
    });

    env!.emitDomainEvent(deletion(WS));
    env!.emitDomainEvent(deletion(other));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.payload).toMatchObject({ workspacePath: other });
    hold.open();
    await done;
  });

  it("pushes an event about no workspace to any call", async () => {
    // A clone has no workspace; `ch project open <url>` is waiting on it.
    const { received, hold, done } = await callInFlight("api:operation:workspace.delete");

    env!.emitDomainEvent(clone);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]!.type).toBe("clone:progress");
    hold.open();
    await done;
  });

  it("pushes every workspace's events to a call with no target", async () => {
    // `ch ws create` cannot say which workspace its progress will be about.
    const { received, hold, done } = await callInFlight("api:operation:workspace.create");

    env!.emitDomainEvent(deletion("/other/wt/twin"));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    hold.open();
    await done;
  });

  it("pushes nothing to a client with no call in flight", async () => {
    env = await createPluginServerEnv(undefined, { registry: testRegistry(), cliToken: TOKEN });
    listProjectsReturns(PROJECTS);
    const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    cli.connect();
    await waitForConnect(cli);
    const received = collect(cli);

    env.emitDomainEvent(deletion(WS));
    env.emitDomainEvent(clone);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual([]);
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

describe("locks tied to a CLI connection", () => {
  /**
   * The real lock entries over a real lock table, and a project listing for
   * them to look a named holder up in.
   */
  function lockRegistry() {
    const dispatcher = createMockDispatcher();
    dispatcher.registerOperation({
      id: "list-projects",
      schemas: { type: INTENT_LIST_PROJECTS, payload: z.unknown(), result: z.unknown() },
      execute: async () => PROJECTS,
    });
    const locks = createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks;
    const registry: OperationRegistry = new OperationRegistry(
      lockEntries({
        dispatcher,
        appLayer: { openPath: async () => undefined },
        awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
        registry: () => registry,
        locks,
        config: createMockConfig(),
        readUserGuide: async () => "",
      })
    );
    return { registry, locks };
  }

  it("releases a `lock.hold` when the socket that took it disconnects", async () => {
    const { registry, locks } = lockRegistry();
    env = await createPluginServerEnv(undefined, { registry, cliToken: TOKEN });
    listProjectsReturns(PROJECTS);
    const run = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    run.connect();
    await waitForConnect(run);

    await expect(call(run, "api:operation:lock.hold", { name: "device" })).resolves.toMatchObject({
      success: true,
    });
    expect(locks.list()).toHaveLength(1);

    // What killing `ch lock run` looks like from the app's side.
    run.disconnect();

    await vi.waitFor(() => expect(locks.list()).toEqual([]));
  });

  it("keeps a `lock.take` after the socket that took it disconnects", async () => {
    const { registry, locks } = lockRegistry();
    env = await createPluginServerEnv(undefined, { registry, cliToken: TOKEN });
    listProjectsReturns(PROJECTS);
    const cli = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    cli.connect();
    await waitForConnect(cli);

    await call(cli, "api:operation:lock.take", { name: "device" });
    cli.disconnect();
    await waitForDisconnect(cli);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Held by the workspace, not by the process that asked.
    expect(locks.list()).toHaveLength(1);
  });

  it("releases another workspace's lock for a call that names that workspace", async () => {
    // The documented way to break a stuck lock: `ch lock release <name>
    // --workspace <holder>`, run from anywhere.
    const { registry, locks } = lockRegistry();
    env = await createPluginServerEnv(undefined, { registry, cliToken: TOKEN });
    listProjectsReturns(PROJECTS);
    const holder = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    holder.connect();
    await waitForConnect(holder);
    await call(holder, "api:operation:lock.take", { name: "device" });
    holder.disconnect();
    await waitForDisconnect(holder);

    const breaker = env.createCliClient({ client: "cli", token: TOKEN, cwd: "/elsewhere" });
    breaker.connect();
    await waitForConnect(breaker);

    await expect(
      call(breaker, "api:operation:lock.release", { name: "device", workspace: "feature" })
    ).resolves.toMatchObject({ success: true, data: { released: ["device"] } });
    expect(locks.list()).toEqual([]);
  });

  it("drops a queued waiter whose socket disconnects", async () => {
    const { registry, locks } = lockRegistry();
    env = await createPluginServerEnv(undefined, { registry, cliToken: TOKEN });
    listProjectsReturns(PROJECTS);
    const holder = env.createCliClient({ client: "cli", token: TOKEN, cwd: WS });
    const waiter = env.createCliClient({ client: "cli", token: TOKEN, cwd: "/other/wt/shared" });
    holder.connect();
    waiter.connect();
    await Promise.all([waitForConnect(holder), waitForConnect(waiter)]);

    await call(holder, "api:operation:lock.take", { name: "device" });
    void call(waiter, "api:operation:lock.take", { name: "device" });
    await vi.waitFor(() => expect(locks.list()[0]?.waiting).toHaveLength(1));

    waiter.disconnect();

    await vi.waitFor(() => expect(locks.list()[0]?.waiting).toEqual([]));
  });
});
