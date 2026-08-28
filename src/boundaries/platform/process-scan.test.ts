// @vitest-environment node
/**
 * Focused tests for the listening-process scan parsers.
 *
 * These are pure string→data functions, and they are the part of
 * `findListeningProcesses` most likely to be wrong per platform: the scan
 * itself is one shell-out, but the output formats differ in ways that only
 * show up on real output (lsof's `-F` field prefixes, `ps` args containing
 * spaces, PowerShell emitting a bare object for a single result).
 */

import { describe, it, expect } from "vitest";
import { parseLsofPids, parsePsOutput, parseWindowsListeners } from "./process";

describe("parseLsofPids", () => {
  it("takes the pid lines and ignores every other field", () => {
    // `lsof -Fp` prefixes each field with its type; only `p` is a pid.
    const stdout = ["p4321", "cnode", "n127.0.0.1:25448", "p4322", "cnode"].join("\n");
    expect(parseLsofPids(stdout)).toEqual([4321, 4322]);
  });

  it("reports a pid once even when it holds several matching descriptors", () => {
    // A process with the socket open more than once must not be killed twice
    // or shown twice in the dialog.
    expect(parseLsofPids("p4321\nn127.0.0.1:25448\np4321\nn[::1]:25448")).toEqual([4321]);
  });

  it("returns nothing for empty output", () => {
    // lsof exits 1 with no output when nothing matches; that is "none", not an error.
    expect(parseLsofPids("")).toEqual([]);
  });

  it("skips lines whose pid is not a number", () => {
    expect(parseLsofPids("pnot-a-pid\np4321")).toEqual([4321]);
  });
});

describe("parsePsOutput", () => {
  it("keeps the command line intact, spaces and all", () => {
    // The command line is the whole point: it is what lets the user recognize
    // the process. Splitting on every space would destroy it.
    const stdout = "  4321 node /opt/codehydra/runtime/codium-server --port 25448 --host 127.0.0.1";
    expect(parsePsOutput(stdout)).toEqual([
      {
        pid: 4321,
        name: "node",
        commandLine: "/opt/codehydra/runtime/codium-server --port 25448 --host 127.0.0.1",
      },
    ]);
  });

  it("falls back to the process name when ps reports no args", () => {
    // A kernel thread or a permission-restricted process has an empty args
    // column; showing a blank Command cell would tell the user nothing.
    expect(parsePsOutput("4321 kworker ")).toEqual([
      { pid: 4321, name: "kworker", commandLine: "kworker" },
    ]);
  });

  it("parses several processes and skips blank lines", () => {
    const stdout = "4321 node server.js\n\n4322 python app.py\n";
    expect(parsePsOutput(stdout).map((p) => p.pid)).toEqual([4321, 4322]);
  });

  it("ignores a header row or any line that does not start with a pid", () => {
    expect(parsePsOutput("PID COMMAND ARGS\n4321 node server.js")).toEqual([
      { pid: 4321, name: "node", commandLine: "server.js" },
    ]);
  });
});

describe("parseWindowsListeners", () => {
  it("parses the array form", () => {
    const stdout = JSON.stringify([
      { ProcessId: 4321, Name: "node.exe", CommandLine: "node.exe server.js --port 25448" },
    ]);
    expect(parseWindowsListeners(stdout)).toEqual([
      { pid: 4321, name: "node.exe", commandLine: "node.exe server.js --port 25448" },
    ]);
  });

  it("parses a bare object, which older ConvertTo-Json emits for a single result", () => {
    // -AsArray is not honored everywhere, and a single listener is the common
    // case — getting this wrong would mean no dialog exactly when one is needed.
    const stdout = JSON.stringify({ ProcessId: 4321, Name: "node.exe", CommandLine: "node.exe" });
    expect(parseWindowsListeners(stdout)).toEqual([
      { pid: 4321, name: "node.exe", commandLine: "node.exe" },
    ]);
  });

  it("falls back to the name when CommandLine is null", () => {
    // Win32_Process returns a null CommandLine for processes the current user
    // may not inspect, which includes anything running as another user.
    const stdout = JSON.stringify([{ ProcessId: 4321, Name: "svchost.exe", CommandLine: null }]);
    expect(parseWindowsListeners(stdout)).toEqual([
      { pid: 4321, name: "svchost.exe", commandLine: "svchost.exe" },
    ]);
  });

  it("returns nothing for empty output or malformed JSON", () => {
    expect(parseWindowsListeners("")).toEqual([]);
    expect(parseWindowsListeners("   ")).toEqual([]);
    expect(parseWindowsListeners("not json")).toEqual([]);
  });

  it("skips entries without a usable pid", () => {
    const stdout = JSON.stringify([{ Name: "node.exe" }, { ProcessId: 4321, Name: "node.exe" }]);
    expect(parseWindowsListeners(stdout).map((p) => p.pid)).toEqual([4321]);
  });
});
