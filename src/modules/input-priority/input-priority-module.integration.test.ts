// @vitest-environment node
/**
 * Integration tests for the input priority module: scans through a behavioral
 * ProcessRunner mock, raising what input-path.ts selects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import type { ProcessSnapshotEntry } from "../../boundaries/platform/process";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import type { HookContext } from "../../intents/lib/operation";
import { createInputPriorityModule } from "./input-priority-module";

const APP_PID = 1;
const SCAN_MS = 5000;

function proc(pid: number, ppid: number, commandLine: string): ProcessSnapshotEntry {
  return {
    pid,
    ppid,
    name: commandLine.split(" ")[0]!,
    commandLine,
    cwd: null,
    rssBytes: 0,
    cpuTimeMs: 0,
    startedAt: 1000 + pid,
    envValue: null,
  };
}

const IDE = [
  proc(APP_PID, 0, "electron ."),
  proc(10, APP_PID, "node server-main.js"),
  proc(11, 10, "node --type=ptyHost"),
  proc(12, 10, "node --type=extensionHost"),
];

function createSetup(options: { platform?: NodeJS.Platform; boost?: boolean } = {}) {
  let machine: ProcessSnapshotEntry[] = [...IDE, proc(20, 11, "pwsh")];
  let scans = 0;
  const runner = createMockProcessRunner({
    processes: () => {
      scans++;
      return { takenAt: Date.now(), processes: machine };
    },
  });
  const module = createInputPriorityModule({
    processRunner: runner,
    configService: createMockConfig({
      defaults: { "terminal.priority-boost": options.boost ?? true },
    }),
    logger: SILENT_LOGGER,
    platform: options.platform ?? "win32",
    appPid: APP_PID,
    timing: { scanIntervalMs: SCAN_MS },
  });
  return {
    runner,
    get scans() {
      return scans;
    },
    setMachine(next: ProcessSnapshotEntry[]) {
      machine = next;
    },
    start: async () => {
      await module.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} });
      await vi.advanceTimersByTimeAsync(0);
    },
    shutdown: () => module.hooks![APP_SHUTDOWN_OPERATION_ID]!["stop"]!.handler({} as HookContext),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("input priority", () => {
  it("raises the IDE server, ptyHost and terminal shells once the app has started", async () => {
    const setup = createSetup();

    await setup.start();

    expect([...setup.runner.$.raisedPids].sort((a, b) => a - b)).toEqual([10, 11, 20]);
  });

  it("raises a terminal opened later on the next scan", async () => {
    const setup = createSetup();
    await setup.start();

    setup.setMachine([...IDE, proc(20, 11, "pwsh"), proc(21, 11, "pwsh")]);
    await vi.advanceTimersByTimeAsync(SCAN_MS);

    expect(setup.scans).toBe(2);
    expect(setup.runner.$.raisedPids).toContain(21);
  });

  it("does nothing off Windows", async () => {
    const setup = createSetup({ platform: "linux" });

    await setup.start();
    await vi.advanceTimersByTimeAsync(SCAN_MS * 2);

    expect(setup.scans).toBe(0);
    expect(setup.runner.$.raisedPids).toEqual([]);
  });

  it("does nothing when terminal.priority-boost is off", async () => {
    const setup = createSetup({ boost: false });

    await setup.start();
    await vi.advanceTimersByTimeAsync(SCAN_MS * 2);

    expect(setup.scans).toBe(0);
  });

  it("stops scanning at shutdown", async () => {
    const setup = createSetup();
    await setup.start();

    await setup.shutdown();
    await vi.advanceTimersByTimeAsync(SCAN_MS * 3);

    expect(setup.scans).toBe(1);
  });
});
