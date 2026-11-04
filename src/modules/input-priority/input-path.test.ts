// @vitest-environment node
/**
 * Focused tests for inputPathPids: which processes of a snapshot a keystroke
 * passes through, on the process tree a Windows CodeHydra runs.
 */

import { describe, it, expect } from "vitest";
import type { ProcessSnapshotEntry } from "../../boundaries/platform/process";
import { inputPathPids } from "./input-path";

const APP = 1;

function proc(
  pid: number,
  ppid: number,
  name: string,
  commandLine = name,
  startedAt = 1000 + pid
): ProcessSnapshotEntry {
  return {
    pid,
    ppid,
    name,
    commandLine,
    cwd: null,
    rssBytes: 0,
    cpuTimeMs: 0,
    startedAt,
    envValue: null,
  };
}

const LAUNCHER = String.raw`"C:\nodejs\node.exe" "C:\data\bin\ch.cjs" claude`;

/** CodeHydra with one agent terminal and one plain terminal running a dev server. */
function machine(): ProcessSnapshotEntry[] {
  return [
    proc(APP, 0, "electron", "electron.exe ."),
    proc(2, APP, "electron", "electron.exe --type=renderer --user-data-dir=x"),
    proc(3, APP, "electron", "electron.exe --type=gpu-process"),
    proc(10, APP, "node", "node.exe server-main.js --port 25448"),
    proc(11, 10, "node", "node.exe bootstrap-fork --type=ptyHost --logsPath x"),
    proc(12, 10, "node", "node.exe bootstrap-fork --type=extensionHost"),
    proc(13, 10, "node", "node.exe bootstrap-fork --type=fileWatcher"),
    // The agent terminal: pwsh → ch.cmd → the launcher → claude → a build.
    proc(20, 11, "OpenConsole", "OpenConsole.exe --headless"),
    proc(21, 11, "pwsh", "pwsh.exe"),
    proc(22, 21, "cmd", String.raw`cmd.exe /c C:\data\bin\ch.cmd claude`),
    proc(23, 22, "node", LAUNCHER),
    proc(24, 23, "claude", "claude.exe --settings x"),
    proc(25, 24, "node", "node.exe vitest"),
    // A plain terminal running a dev server.
    proc(30, 11, "OpenConsole", "OpenConsole.exe --headless"),
    proc(31, 11, "pwsh", "pwsh.exe"),
    proc(32, 31, "node", "node.exe vite"),
  ];
}

describe("inputPathPids", () => {
  it("finds renderer, IDE server, ptyHost, every OpenConsole and shell, and the agent TUI", () => {
    expect(inputPathPids(machine(), APP).sort((a, b) => a - b)).toEqual([
      2, 10, 11, 20, 21, 24, 30, 31,
    ]);
  });

  it("leaves out what shells and agents start, and the IDE's other helpers", () => {
    const pids = inputPathPids(machine(), APP);
    for (const pid of [3, 12, 13, 22, 23, 25, 32]) expect(pids).not.toContain(pid);
  });

  it("finds the agent behind the cmd.exe that runs an npm .cmd install", () => {
    const processes = [
      ...machine().filter((entry) => entry.pid !== 24 && entry.pid !== 25),
      proc(40, 23, "cmd", String.raw`cmd.exe /d /s /c ""C:\npm\claude.cmd" --settings x"`),
      proc(41, 40, "node", String.raw`node.exe C:\npm\node_modules\claude-code\cli.js`),
      proc(42, 41, "node", "node.exe tsc"),
    ];

    const pids = inputPathPids(processes, APP);

    expect(pids).toContain(41);
    expect(pids).not.toContain(40);
    expect(pids).not.toContain(42);
  });

  it("finds a shell started under its OpenConsole", () => {
    const processes = [...machine(), proc(50, 30, "pwsh", "pwsh.exe")];

    expect(inputPathPids(processes, APP)).toContain(50);
  });

  it("leaves another VS Code's ptyHost alone", () => {
    const processes = [
      ...machine(),
      proc(90, 0, "Code", "Code.exe"),
      proc(91, 90, "Code", "Code.exe --type=ptyHost"),
      proc(92, 91, "pwsh", "pwsh.exe"),
    ];

    const pids = inputPathPids(processes, APP);

    for (const pid of [90, 91, 92]) expect(pids).not.toContain(pid);
  });

  it("does not adopt a process through a reused parent pid", () => {
    // pid 11 was reused by a ptyHost started after this orphaned shell.
    const processes = [...machine(), proc(60, 11, "pwsh", "pwsh.exe", 5)];

    expect(inputPathPids(processes, APP)).not.toContain(60);
  });

  it("finds nothing before the IDE server is up", () => {
    const processes = machine().filter((entry) => entry.pid < 10);

    expect(inputPathPids(processes, APP)).toEqual([2]);
  });
});
