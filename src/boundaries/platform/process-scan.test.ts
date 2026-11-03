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
import {
  parseLsofPids,
  parseNetstatListeners,
  parsePsOutput,
  parseWindowsListeners,
  linuxStartTicks,
  parseLinuxBootTime,
  parseLinuxProcess,
  parseEnviron,
  parseLsofCwds,
  parseLsofListenPorts,
  parseMacSnapshot,
  parseProcNetTcpListeners,
  parsePsDuration,
  parsePsEnvironment,
  parseWindowsListenPorts,
  parseWindowsSnapshot,
  socketInode,
} from "./process";

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

describe("parseNetstatListeners", () => {
  const header = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
  ];

  it("takes the pids listening on the port, IPv4 and IPv6", () => {
    const stdout = [
      ...header,
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
      "  TCP    127.0.0.1:25448        0.0.0.0:0              LISTENING       4321",
      "  TCP    [::1]:25448            [::]:0                 LISTENING       4322",
    ].join("\r\n");
    expect(parseNetstatListeners(stdout, 25448)).toEqual([4321, 4322]);
  });

  it("reads a translated state column", () => {
    // netstat localizes the state; a German Windows prints ABHÖREN.
    const stdout = "  TCP    127.0.0.1:25448        0.0.0.0:0              ABHÖREN         4321";
    expect(parseNetstatListeners(stdout, 25448)).toEqual([4321]);
  });

  it("skips connections, other ports and UDP", () => {
    const stdout = [
      ...header,
      // A client connected to the port, and the server side of that connection.
      "  TCP    127.0.0.1:50000        127.0.0.1:25448        ESTABLISHED     7777",
      "  TCP    127.0.0.1:25448        127.0.0.1:50000        ESTABLISHED     4321",
      // A port that merely ends in the same digits.
      "  TCP    127.0.0.1:125448       0.0.0.0:0              LISTENING       8888",
      "  UDP    127.0.0.1:25448        *:*                                    9999",
    ].join("\r\n");
    expect(parseNetstatListeners(stdout, 25448)).toEqual([]);
  });

  it("reports a pid once, and never pid 0", () => {
    const stdout = [
      "  TCP    127.0.0.1:25448        0.0.0.0:0              LISTENING       4321",
      "  TCP    0.0.0.0:25448          0.0.0.0:0              LISTENING       4321",
      "  TCP    [::]:25448             [::]:0                 LISTENING       0",
    ].join("\r\n");
    expect(parseNetstatListeners(stdout, 25448)).toEqual([4321]);
  });

  it("returns nothing for empty output", () => {
    expect(parseNetstatListeners("", 25448)).toEqual([]);
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

// ============================================================================
// Process snapshot parsers
// ============================================================================

/** A /proc/<pid>/stat line; fields after comm as proc(5) numbers them. */
function stat(pid: number, comm: string, fields: Record<number, number> = {}): string {
  const values = Array.from({ length: 50 }, (_, index) => fields[index + 3] ?? 0);
  values[0] = 0; // state, not numeric in reality; unused
  return `${pid} (${comm}) S ${values.slice(1).join(" ")}`;
}

describe("parseLinuxProcess", () => {
  const context = { bootMs: 1_000_000, clockTicks: 100, pageSize: 4096 };

  it("reads parent, CPU, start time and memory from stat, and the command line", () => {
    const line = stat(4321, "node", { 4: 77, 14: 150, 15: 50, 22: 2_000, 24: 256 });
    expect(parseLinuxProcess(line, "/usr/bin/node\0server.js\0--port\0", "/ws/a", context)).toEqual(
      {
        pid: 4321,
        ppid: 77,
        name: "node",
        commandLine: "/usr/bin/node server.js --port",
        cwd: "/ws/a",
        rssBytes: 256 * 4096,
        cpuTimeMs: 2000,
        startedAt: 1_000_000 + 20_000,
        envValue: null,
      }
    );
  });

  it("finds the fields after a comm containing spaces and parentheses", () => {
    const line = stat(9, "tmux: server (1)", { 4: 1, 14: 1, 15: 1 });
    const entry = parseLinuxProcess(line, "", null, context);
    expect(entry).toMatchObject({ pid: 9, ppid: 1, name: "tmux: server (1)", cpuTimeMs: 20 });
    // No cmdline (a kernel thread, or a zombie): the comm stands in.
    expect(entry!.commandLine).toBe("tmux: server (1)");
  });

  it("strips the marker of a working directory deleted under the process", () => {
    expect(parseLinuxProcess(stat(9, "sh"), "sh\0", "/ws/gone (deleted)", context)!.cwd).toBe(
      "/ws/gone"
    );
  });

  it("reads the raw start time that keys the command-line cache", () => {
    expect(linuxStartTicks(stat(9, "a (b)", { 22: 12345 }))).toBe("12345");
  });

  it("rejects a line that is not a stat line", () => {
    expect(parseLinuxProcess("garbage", "", null, context)).toBeNull();
  });
});

describe("environment parsers", () => {
  it("finds a variable in a /proc/<pid>/environ block, exact name only", () => {
    const environ = "PATH=/usr/bin\0_CH_WORKSPACE_X=no\0_CH_WORKSPACE=ch::m::p::a b\0";
    expect(parseEnviron(environ, "_CH_WORKSPACE")).toBe("ch::m::p::a b");
    expect(parseEnviron(environ, "HOME")).toBeNull();
    expect(parseEnviron("", "_CH_WORKSPACE")).toBeNull();
  });

  it("reads the value after the arguments in `ps -E` output", () => {
    const stdout = [
      // An argument mentions the variable; the environment, last, wins.
      "  10 /bin/zsh -c echo _CH_WORKSPACE=fake TERM=xterm _CH_WORKSPACE=ch::m::p::my ws HOME=/u",
      "  11 /usr/bin/ssh-agent",
      "  12 node app.js _CH_WORKSPACE=ch::m::p::b",
    ].join("\n");
    expect(parsePsEnvironment(stdout, "_CH_WORKSPACE")).toEqual(
      new Map([
        [10, "ch::m::p::my ws"],
        [12, "ch::m::p::b"],
      ])
    );
  });
});

describe("parseLinuxBootTime", () => {
  it("takes btime from /proc/stat", () => {
    expect(parseLinuxBootTime("cpu  1 2 3\nbtime 1700000000\nprocesses 5\n")).toBe(
      1_700_000_000_000
    );
    expect(parseLinuxBootTime("cpu 1 2 3\n")).toBeNull();
  });
});

describe("parseProcNetTcpListeners / socketInode", () => {
  it("maps each LISTEN socket's inode to its port, skipping other states", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1",
      "   1: 0100007F:9C40 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1",
    ].join("\n");
    expect(parseProcNetTcpListeners(table)).toEqual(new Map([[55501, 0x1435]]));
  });

  it("reads the inode of a socket fd link only", () => {
    expect(socketInode("socket:[55501]")).toBe(55501);
    expect(socketInode("/dev/null")).toBeNull();
  });
});

describe("parsePsDuration", () => {
  it("reads every shape ps prints for time and etime", () => {
    expect(parsePsDuration("0:01.50")).toBe(1500);
    expect(parsePsDuration("12:05")).toBe(725_000);
    expect(parsePsDuration("01:02:03")).toBe(3_723_000);
    expect(parsePsDuration("2-01:00:00")).toBe(2 * 86_400_000 + 3_600_000);
    expect(parsePsDuration("-")).toBeNull();
  });
});

describe("lsof parsers", () => {
  it("maps pids to their working directory", () => {
    expect(parseLsofCwds("p10\nfcwd\nn/ws/a\np11\nfcwd\nn/Users/me/My Project\n")).toEqual(
      new Map([
        [10, "/ws/a"],
        [11, "/Users/me/My Project"],
      ])
    );
  });

  it("maps pids to their listening ports, each once", () => {
    const stdout = "p10\nf20\nn*:5173\nf21\nn[::1]:5173\np11\nf3\nn127.0.0.1:8080\n";
    expect(parseLsofListenPorts(stdout)).toEqual(
      new Map([
        [10, [5173]],
        [11, [8080]],
      ])
    );
  });
});

describe("parseMacSnapshot", () => {
  it("joins ps rows with executable names, working directories and the env value", () => {
    const ps = [
      "  10     1  2048   0:01.50    01:00 /usr/local/bin/node server.js --port 3000",
      "  11    10   512   0:00.00    00:05 ",
    ].join("\n");
    const comm = "  10 /usr/local/bin/node\n  11 /Applications/My App.app/Contents/MacOS/My App\n";
    const entries = parseMacSnapshot(
      ps,
      comm,
      new Map([[10, "/ws/a"]]),
      100_000,
      new Map([[10, "ch::m::p::a"]])
    );
    expect(entries).toEqual([
      {
        pid: 10,
        ppid: 1,
        name: "node",
        commandLine: "/usr/local/bin/node server.js --port 3000",
        cwd: "/ws/a",
        rssBytes: 2048 * 1024,
        cpuTimeMs: 1500,
        startedAt: 40_000,
        envValue: "ch::m::p::a",
      },
      {
        pid: 11,
        ppid: 10,
        name: "My App",
        commandLine: "My App",
        cwd: null,
        rssBytes: 512 * 1024,
        cpuTimeMs: 0,
        startedAt: 95_000,
        envValue: null,
      },
    ]);
  });
});

describe("Windows helper output", () => {
  it("parses a snapshot, keeping unreadable fields null", () => {
    const stdout = JSON.stringify({
      processes: [
        {
          pid: 4,
          ppid: 0,
          name: "System",
          commandLine: null,
          cwd: null,
          rssBytes: 0,
          cpuTimeMs: null,
          startedAt: null,
        },
        {
          pid: 4321,
          ppid: 100,
          name: "node",
          commandLine: "node server.js",
          cwd: "C:\\ws\\a",
          rssBytes: 1024,
          cpuTimeMs: 15.6,
          startedAt: 1_700_000_000_000,
          env: "ch::m::p::a",
        },
      ],
    });
    expect(parseWindowsSnapshot(stdout)).toEqual([
      {
        pid: 4,
        ppid: 0,
        name: "System",
        commandLine: "System",
        cwd: null,
        rssBytes: 0,
        cpuTimeMs: null,
        startedAt: null,
        envValue: null,
      },
      {
        pid: 4321,
        ppid: 100,
        name: "node",
        commandLine: "node server.js",
        cwd: "C:\\ws\\a",
        rssBytes: 1024,
        cpuTimeMs: 15.6,
        startedAt: 1_700_000_000_000,
        envValue: "ch::m::p::a",
      },
    ]);
  });

  it("answers null, not an empty machine, for output that is not a snapshot", () => {
    expect(parseWindowsSnapshot("")).toBeNull();
    expect(parseWindowsSnapshot('{"error":"boom"}')).toBeNull();
  });

  it("maps listeners to ports per pid", () => {
    const stdout = JSON.stringify({
      listeners: [
        { pid: 10, port: 5173 },
        { pid: 10, port: 5173 },
        { pid: 11, port: 8080 },
        { pid: 0, port: 135 },
      ],
    });
    expect(parseWindowsListenPorts(stdout)).toEqual(
      new Map([
        [10, [5173]],
        [11, [8080]],
      ])
    );
  });
});
