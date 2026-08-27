// @vitest-environment node
/**
 * Integration tests for the `ch` command.
 *
 * Drives `run()` against a fake client, so these cover the whole path a real
 * invocation takes — describe, resolve, parse, call, render — including the exit
 * codes a script or agent branches on.
 */

import { describe, it, expect } from "vitest";
import { DESCRIBE_CHANNEL, type OperationDescriptor } from "../api/adapters/describe";
import { CallError, UnreachableError, type Client } from "./client";
import type { ClientEvent } from "../api/events";
import { DiscoveryError } from "./discovery";
import { EXIT } from "./output";
import { run } from "./run";

const DESCRIPTORS: readonly OperationDescriptor[] = [
  {
    name: "workspace.status",
    kind: "command",
    description: "Get workspace status.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean" } } },
    path: ["ws", "status"],
  },
  {
    name: "agent.status.set",
    kind: "command",
    description: "Report agent status.",
    instructions: "A one-shot report, not a pinned override.",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
    path: ["ws", "status", "set"],
    positionals: ["status"],
  },
  {
    name: "workspace.delete",
    kind: "command",
    description: "Delete a workspace.",
    inputSchema: {
      type: "object",
      properties: { keepBranch: { type: "boolean" }, wait: { type: "boolean" } },
    },
    path: ["ws", "delete"],
  },
  {
    name: "project.list",
    kind: "command",
    description: "List projects.",
    inputSchema: { type: "object", properties: {} },
    path: ["project", "list"],
  },
];

interface Recorded {
  readonly channel: string;
  readonly request: unknown;
}

/** A client that answers describe and records every other call. */
function fakeClient(
  reply: (channel: string, request: unknown) => unknown,
  calls: Recorded[] = [],
  events: readonly ClientEvent[] = []
): Client {
  const listeners = new Set<(event: ClientEvent) => void>();
  return {
    async call<T>(channel: string, request?: unknown): Promise<T> {
      if (channel === DESCRIBE_CHANNEL) return DESCRIPTORS as T;
      calls.push({ channel, request });
      // Anything the fake emits arrives while the call is in flight, which is
      // when a real client would see it.
      for (const event of events) listeners.forEach((listener) => listener(event));
      const result = reply(channel, request);
      if (result instanceof Error) throw result;
      return result as T;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };
}

function runWith(argv: readonly string[], client: Client, isTty = false) {
  return run({ argv, isTty, connect: async () => client });
}

describe("run", () => {
  describe("dispatch", () => {
    it("addresses the operation by registry name, not by plugin channel", async () => {
      const calls: Recorded[] = [];
      await runWith(
        ["ws", "status"],
        fakeClient(() => ({ dirty: false }), calls)
      );

      expect(calls).toEqual([{ channel: "api:operation:workspace.status", request: {} }]);
    });

    it("resolves the longest matching path", async () => {
      const calls: Recorded[] = [];
      await runWith(
        ["ws", "status", "set", "busy"],
        fakeClient(() => null, calls)
      );

      expect(calls[0]).toEqual({
        channel: "api:operation:agent.status.set",
        request: { status: "busy" },
      });
    });

    it("sends flags as typed input", async () => {
      const calls: Recorded[] = [];
      await runWith(
        ["ws", "delete", "--keep-branch", "--no-wait"],
        fakeClient(() => null, calls)
      );

      expect(calls[0]!.request).toEqual({ keepBranch: true, wait: false });
    });
  });

  describe("output", () => {
    it("emits JSON when piped", async () => {
      const result = await runWith(
        ["ws", "status"],
        fakeClient(() => ({ dirty: true }))
      );

      expect(result.stdout).toBe('{"dirty":true}');
      expect(result.exitCode).toBe(EXIT.OK);
    });

    it("emits readable output at a terminal", async () => {
      const result = await runWith(
        ["ws", "status"],
        fakeClient(() => ({ dirty: true })),
        true
      );

      expect(result.stdout).toBe("dirty  true");
    });

    it("honours a forced mode against the TTY default", async () => {
      const result = await runWith(
        ["ws", "status", "--json"],
        fakeClient(() => ({ a: 1 })),
        true
      );

      expect(result.stdout).toBe('{"a":1}');
    });
  });

  describe("exit codes", () => {
    it("returns 0 on success", async () => {
      const result = await runWith(
        ["project", "list"],
        fakeClient(() => [])
      );
      expect(result.exitCode).toBe(EXIT.OK);
    });

    it("returns 1 when the operation ran and failed", async () => {
      const result = await runWith(
        ["ws", "delete"],
        fakeClient(() => new CallError("worktree is locked"))
      );

      expect(result.exitCode).toBe(EXIT.FAILED);
      expect(result.stderr).toContain("worktree is locked");
    });

    it("returns 2 for an unknown command", async () => {
      const result = await runWith(
        ["ws", "bogus"],
        fakeClient(() => null)
      );

      expect(result.exitCode).toBe(EXIT.USAGE);
      expect(result.stderr).toContain("unknown command");
    });

    it("returns 2 for a malformed argument", async () => {
      const result = await runWith(
        ["ws", "status", "stray"],
        fakeClient(() => null)
      );

      expect(result.exitCode).toBe(EXIT.USAGE);
      expect(result.stderr).toContain("unexpected argument");
    });

    it("returns 3 when CodeHydra cannot be reached", async () => {
      const result = await run({
        argv: ["ws", "status"],
        isTty: false,
        connect: () => Promise.reject(new UnreachableError("connection refused")),
      });

      expect(result.exitCode).toBe(EXIT.UNREACHABLE);
    });

    it("returns 3 when no instance published its connection details", async () => {
      const result = await run({
        argv: ["ws", "status"],
        isTty: false,
        connect: () => Promise.reject(new DiscoveryError("not running")),
      });

      expect(result.exitCode).toBe(EXIT.UNREACHABLE);
    });

    it("returns 4 when a workspace command runs outside a workspace", async () => {
      // Distinct from a plain failure so a script can tell "wrong place" from
      // "the operation refused".
      const result = await runWith(
        ["ws", "status"],
        fakeClient(
          () =>
            new CallError(
              '"workspace.status" acts on a workspace, but no workspace was given. Run it from inside a workspace.'
            )
        )
      );

      expect(result.exitCode).toBe(EXIT.NO_WORKSPACE);
    });

    it("reports a failure as a structured object in JSON mode", async () => {
      const result = await runWith(
        ["ws", "delete"],
        fakeClient(() => new CallError("nope"))
      );

      expect(JSON.parse(result.stderr)).toEqual({ error: "nope", exitCode: EXIT.FAILED });
    });
  });

  describe("help", () => {
    it("lists commands when given no arguments", async () => {
      const result = await runWith(
        [],
        fakeClient(() => null)
      );

      expect(result.exitCode).toBe(EXIT.OK);
      expect(result.stdout).toContain("ws status");
      expect(result.stdout).toContain("project list");
      // Built-in modes are not registry operations and must still be listed.
      expect(result.stdout).toContain("mcp");
      expect(result.stdout).toContain("bg <cmd…>");
    });

    it("describes one command's own arguments", async () => {
      const result = await runWith(
        ["ws", "status", "set", "--help"],
        fakeClient(() => null)
      );

      expect(result.stdout).toContain("Report agent status");
      expect(result.stdout).toContain("A one-shot report");
      expect(result.stdout).toContain("<status>");
    });

    it("does not call the operation when help is asked for", async () => {
      const calls: Recorded[] = [];
      await runWith(
        ["ws", "delete", "--help"],
        fakeClient(() => null, calls)
      );

      expect(calls).toEqual([]);
    });
  });
});

describe("progress", () => {
  it("reports forwarded events while the call is in flight", async () => {
    const progress: string[] = [];
    const client = fakeClient(
      () => ({ started: true }),
      [],
      [
        {
          type: "workspace:deletion-progress",
          payload: {
            operations: [{ id: "a", label: "Removing worktree", status: "running" }],
            completed: false,
            hasErrors: false,
          },
        },
      ]
    );

    const result = await run({
      argv: ["ws", "delete"],
      isTty: false,
      connect: async () => client,
      onProgress: (line) => progress.push(line),
    });

    expect(progress).toEqual(["Removing worktree…"]);
    // Progress must never contaminate the result a pipeline reads.
    expect(result.stdout).toBe('{"started":true}');
  });

  it("stays silent when no progress sink is given", async () => {
    // The piped case: stdout is read by something, so nothing else is shown.
    const client = fakeClient(
      () => ({ started: true }),
      [],
      [{ type: "workspace:loading", payload: { workspaceName: "x" } }]
    );

    const result = await run({ argv: ["ws", "delete"], isTty: false, connect: async () => client });

    expect(result.stdout).toBe('{"started":true}');
    expect(result.stderr).toBe("");
  });

  it("drops repeated lines, so a clone does not scroll past the watcher", async () => {
    const progress: string[] = [];
    const repeated = {
      type: "clone:progress",
      payload: { stage: "receiving", progress: 10, name: "repo", url: "u" },
    };
    const client = fakeClient(() => null, [], [repeated, repeated, repeated]);

    await run({
      argv: ["project", "list"],
      isTty: false,
      connect: async () => client,
      onProgress: (line) => progress.push(line),
    });

    expect(progress).toEqual(["cloning repo: receiving 10%"]);
  });

  it("ignores an event it has no rendering for", async () => {
    const progress: string[] = [];
    const client = fakeClient(() => null, [], [{ type: "unknown:event", payload: {} }]);

    await run({
      argv: ["project", "list"],
      isTty: false,
      connect: async () => client,
      onProgress: (line) => progress.push(line),
    });

    expect(progress).toEqual([]);
  });
});
