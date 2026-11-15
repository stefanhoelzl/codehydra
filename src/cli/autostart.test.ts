// @vitest-environment node
/**
 * Tests for starting CodeHydra from `ch`, and `ch running`.
 *
 * The app is simulated: a fake state.json the "launched" app fills in over a
 * few polls, a connect that succeeds only against what is published, and a
 * clock that advances with every sleep.
 */

import { describe, it, expect } from "vitest";
import { UnreachableError, type Client } from "./client";
import { DiscoveryError, type Connection, type StartupInfo } from "./discovery";
import {
  connectOrStart,
  POLL_INTERVAL_MS,
  probeRunning,
  renderRunningText,
  type AutostartDeps,
} from "./autostart";

interface FakeApp {
  port: number;
  ready: boolean;
  executable: string | null;
  launches: Array<{ executable: string; rootOverride: string | null }>;
  closed: number;
}

function fakeClient(app: FakeApp): Client {
  return {
    call: async <T>() => undefined as T,
    onEvent: () => () => {},
    close: () => {
      app.closed++;
    },
  };
}

/**
 * @param startsAfterPolls - polls after a launch until the app is listening
 *   and ready; null = it never comes up.
 */
function setup(
  app: Partial<FakeApp> = {},
  options: { startsAfterPolls?: number | null; canStart?: boolean; launchFails?: boolean } = {}
) {
  const state: FakeApp = {
    port: 0,
    ready: false,
    executable: "/opt/CodeHydra/codehydra",
    launches: [],
    closed: 0,
    ...app,
  };
  let clock = 0;
  let pollsSinceLaunch: number | null = null;
  const startsAfterPolls = options.startsAfterPolls === undefined ? 3 : options.startsAfterPolls;

  const deps: AutostartDeps = {
    connection: (): Connection => {
      if (state.port === 0) throw new DiscoveryError("CodeHydra does not appear to be running");
      return { port: state.port, token: "t", dataDir: "/data" };
    },
    connect: async () => {
      if (state.port === 0) throw new UnreachableError("refused");
      return fakeClient(state);
    },
    startupInfo: (): StartupInfo => ({
      executable: state.executable,
      rootOverride: "/root",
      ready: state.ready,
    }),
    canStart: options.canStart ?? true,
    launch: async (executable, rootOverride) => {
      if (options.launchFails) throw new Error("ENOENT");
      state.launches.push({ executable, rootOverride });
      pollsSinceLaunch = 0;
    },
    sleep: async (ms) => {
      clock += ms;
      if (pollsSinceLaunch === null) return;
      pollsSinceLaunch++;
      if (startsAfterPolls !== null && pollsSinceLaunch >= startsAfterPolls) {
        state.port = 4711;
        state.ready = true;
      } else if (startsAfterPolls !== null && pollsSinceLaunch >= 1) {
        // Listening, but still restoring projects.
        state.port = 4711;
      }
    },
    now: () => clock,
    timeoutMs: 10 * POLL_INTERVAL_MS,
  };
  return { deps, state };
}

describe("connectOrStart", () => {
  it("connects to a running app without starting another", async () => {
    const { deps, state } = setup({ port: 4711, ready: true });

    await connectOrStart(deps);

    expect(state.launches).toEqual([]);
  });

  it("uses a running app that is still starting as it is", async () => {
    // Its own startup may be what calls `ch`; waiting for ready would wait on itself.
    const { deps, state } = setup({ port: 4711, ready: false });

    await connectOrStart(deps);

    expect(state.launches).toEqual([]);
  });

  it("starts the app with its root, and waits until it is ready, not just listening", async () => {
    const { deps, state } = setup({}, { startsAfterPolls: 3 });
    let starting = 0;

    await connectOrStart({ ...deps, onStarting: () => starting++ });

    expect(state.launches).toEqual([
      { executable: "/opt/CodeHydra/codehydra", rootOverride: "/root" },
    ]);
    expect(state.ready).toBe(true);
    expect(starting).toBe(1);
  });

  it("gives up when the started app never becomes ready", async () => {
    const { deps } = setup({}, { startsAfterPolls: null });

    await expect(connectOrStart(deps)).rejects.toBeInstanceOf(UnreachableError);
  });

  it("does not start an app for an inherited connection", async () => {
    const { deps, state } = setup({}, { canStart: false });

    await expect(connectOrStart(deps)).rejects.toBeInstanceOf(DiscoveryError);
    expect(state.launches).toEqual([]);
  });

  it("does not start a build that published no executable", async () => {
    const { deps, state } = setup({ executable: null });

    await expect(connectOrStart(deps)).rejects.toBeInstanceOf(DiscoveryError);
    expect(state.launches).toEqual([]);
  });

  it("reports an executable that cannot be started as unreachable", async () => {
    const { deps } = setup({}, { launchFails: true });

    await expect(connectOrStart(deps)).rejects.toThrow(/could not be started/);
  });
});

describe("probeRunning", () => {
  it("reports a running, ready app and closes its connection", async () => {
    const { deps, state } = setup({ port: 4711, ready: true });

    const status = await probeRunning(deps);

    expect(status).toEqual({ running: true, ready: true });
    expect(renderRunningText(status)).toBe("running");
    expect(state.closed).toBe(1);
  });

  it("reports an app that is still starting", async () => {
    const { deps } = setup({ port: 4711, ready: false });

    expect(renderRunningText(await probeRunning(deps))).toBe("starting");
  });

  it("reports a stopped app and never starts it", async () => {
    const { deps, state } = setup();

    const status = await probeRunning(deps);

    expect(status).toEqual({ running: false, ready: false });
    expect(renderRunningText(status)).toBe("not running");
    expect(state.launches).toEqual([]);
  });
});
