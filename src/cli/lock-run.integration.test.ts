/**
 * `ch lock run`: taking the lock through `lock.hold`, running the command, and
 * releasing only what it acquired — against a fake client and an injected
 * command runner, so the ordering of hold → run → release is what is asserted.
 */

import { describe, it, expect } from "vitest";
import { lockRun, type LockRunOptions } from "./lock-run";
import { CallError, type Client } from "./client";
import { DESCRIBE_CHANNEL } from "../api/adapters/describe";
import { EXIT } from "./output";

interface Recorded {
  readonly step: string;
  readonly detail?: unknown;
}

function harness(options: {
  hold?: (request: unknown) => unknown;
  status?: number;
  argv: readonly string[];
  /** Operations the app says it has. */
  described?: readonly string[];
}) {
  const steps: Recorded[] = [];
  const out: string[] = [];
  const err: string[] = [];

  const client: Client = {
    async call<T>(channel: string, request?: unknown): Promise<T> {
      if (channel === DESCRIBE_CHANNEL) {
        return (options.described ?? ["lock.hold", "lock.release"]).map((name) => ({
          name,
        })) as T;
      }
      steps.push({ step: channel, detail: request });
      if (channel === "api:operation:lock.hold") {
        const reply = options.hold
          ? options.hold(request)
          : { name: "device", scope: "global", acquired: true };
        if (reply instanceof Error) throw reply;
        return reply as T;
      }
      return { released: ["device"] } as T;
    },
    onEvent: () => () => {},
    close: () => steps.push({ step: "close" }),
  };

  const run: LockRunOptions = {
    argv: options.argv,
    isTty: true,
    connect: async () => {
      steps.push({ step: "connect" });
      return client;
    },
    runCommand: async (command, args) => {
      steps.push({ step: "run", detail: [command, ...args] });
      return options.status ?? 0;
    },
    holdForever: async () => {
      steps.push({ step: "hold-forever" });
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };

  return { run: () => lockRun(run), steps, out, err };
}

describe("ch lock run", () => {
  it("takes the lock, runs the command, then releases what it took", async () => {
    const h = harness({ argv: ["device", "install", "--", "./install.sh", "--fast"], status: 3 });

    const code = await h.run();

    expect(h.steps.map((s) => s.step)).toEqual([
      "connect",
      "api:operation:lock.hold",
      "run",
      "api:operation:lock.release",
      "close",
    ]);
    expect(h.steps[1]?.detail).toEqual({ name: "device", reason: "install" });
    expect(h.steps[2]?.detail).toEqual(["./install.sh", "--fast"]);
    expect(h.steps[3]?.detail).toEqual({ name: "device", scope: "global" });
    // The command's status is the process's status.
    expect(code).toBe(3);
  });

  it("leaves a hold this workspace already had in place", async () => {
    const h = harness({
      argv: ["device", "--", "./install.sh"],
      hold: () => ({ name: "device", scope: "global", acquired: false }),
    });

    await h.run();

    expect(h.steps.map((s) => s.step)).not.toContain("api:operation:lock.release");
    expect(h.steps.map((s) => s.step)).toContain("run");
  });

  it("holds until killed when there is no command", async () => {
    const h = harness({ argv: ["device", "long device session"] });

    const code = await h.run();

    expect(h.steps.map((s) => s.step)).toEqual([
      "connect",
      "api:operation:lock.hold",
      "hold-forever",
      "close",
    ]);
    expect(h.out).toEqual(["held 'device' — release by killing this process"]);
    expect(code).toBe(EXIT.OK);
  });

  it("does not pretend to hold a lock the workspace's earlier take owns", async () => {
    const h = harness({
      argv: ["device"],
      hold: () => ({ name: "device", scope: "global", acquired: false }),
    });

    const code = await h.run();

    expect(h.steps.map((s) => s.step)).not.toContain("hold-forever");
    expect(h.out).toEqual(["'device' is already held by this workspace — nothing to hold"]);
    expect(code).toBe(EXIT.OK);
  });

  it("passes scope, no-wait and the holder through, and leaves the command's flags alone", async () => {
    const h = harness({
      argv: [
        "fixtures",
        "--scope",
        "project",
        "--no-wait",
        "--workspace",
        "/w",
        "--",
        "make",
        "--workspace",
        "other",
      ],
    });

    await h.run();

    expect(h.steps[1]?.detail).toEqual({
      name: "fixtures",
      scope: "project",
      noWait: true,
      workspace: "/w",
    });
    expect(h.steps[2]?.detail).toEqual(["make", "--workspace", "other"]);
    // Released as the workspace that held it.
    expect(h.steps[3]?.detail).toEqual({ name: "device", scope: "global", workspace: "/w" });
  });

  it("reports a refused take with the category's exit code and runs nothing", async () => {
    const h = harness({
      argv: ["device", "--no-wait", "--", "./install.sh"],
      hold: () => new CallError("'device' is held by 'android' (4m)", "conflict"),
    });

    const code = await h.run();

    expect(code).toBe(EXIT.CONFLICT);
    expect(h.err).toEqual(["'device' is held by 'android' (4m)"]);
    expect(h.steps.map((s) => s.step)).not.toContain("run");
  });

  it("refuses, rather than waiting forever, on an app that has no `lock.hold`", async () => {
    const h = harness({ argv: ["device", "--", "./install.sh"], described: ["workspace.status"] });

    const code = await h.run();

    expect(code).toBe(EXIT.FAILED);
    expect(h.err).toEqual(["This CodeHydra does not support `ch lock run` — update it."]);
    expect(h.steps.map((s) => s.step)).not.toContain("api:operation:lock.hold");
  });

  it("reports failures in the chosen format, ignoring the command's own --format", async () => {
    const h = harness({
      argv: ["device", "--format", "json", "--", "make", "--format", "text"],
      hold: () => new CallError("'device' is held by 'android' (4m)", "conflict"),
    });

    await h.run();

    expect(h.err).toEqual([
      JSON.stringify({ error: "'device' is held by 'android' (4m)", exitCode: EXIT.CONFLICT }),
    ]);
  });

  it.each([
    [[], "no lock name"],
    [["device", "--"], "nothing after --"],
  ])("is a usage error with %j (%s)", async (argv) => {
    const h = harness({ argv });

    const code = await h.run();

    expect(code).toBe(EXIT.USAGE);
    expect(h.steps.map((s) => s.step)).not.toContain("api:operation:lock.hold");
  });
});
