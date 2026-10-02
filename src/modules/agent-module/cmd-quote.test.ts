/**
 * Focused tests for cmd.exe quoting, and for runAgentBinary, which uses it to
 * run a Windows `.cmd` shim.
 */

import { describe, it, expect } from "vitest";
import { cmdCommandLine, needsCmdShell, quoteForCmd } from "./cmd-quote";
import { runAgentBinary } from "./binary-resolver";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";

describe("quoteForCmd", () => {
  it("wraps a part in double quotes", () => {
    expect(quoteForCmd("C:\\Users\\Jane Doe\\agent.cmd")).toBe('"C:\\Users\\Jane Doe\\agent.cmd"');
  });

  it("doubles embedded quotes so the part stays one token", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes an empty part rather than dropping it", () => {
    expect(quoteForCmd("")).toBe('""');
  });
});

describe("cmdCommandLine", () => {
  it("quotes the executable and every argument", () => {
    expect(cmdCommandLine("C:\\npm\\agent.cmd", ["--port", "1234", "hello world"])).toBe(
      '"C:\\npm\\agent.cmd" "--port" "1234" "hello world"'
    );
  });
});

describe("needsCmdShell", () => {
  it("is true only for a .cmd on Windows, whatever its case", () => {
    expect(needsCmdShell("C:\\npm\\agent.CMD", "win32")).toBe(true);
    expect(needsCmdShell("C:\\npm\\agent.exe", "win32")).toBe(false);
    expect(needsCmdShell("/usr/bin/agent.cmd", "linux")).toBe(false);
  });
});

describe("runAgentBinary", () => {
  it("runs a .cmd shim through a shell with every part quoted", () => {
    const runner = createMockProcessRunner();

    runAgentBinary(runner, "C:\\Users\\Jane Doe\\agent.cmd", ["serve", "a b"], "win32", {
      cwd: "C:\\ws",
    });

    const spawned = runner.$.spawned(0).$;
    expect(spawned.command).toBe('"C:\\Users\\Jane Doe\\agent.cmd" "serve" "a b"');
    expect(spawned.args).toEqual([]);
    expect(spawned.shell).toBe(true);
    expect(spawned.cwd).toBe("C:\\ws");
  });

  it("spawns anything else directly, arguments untouched", () => {
    const runner = createMockProcessRunner();

    runAgentBinary(runner, "/usr/bin/agent", ["serve", "a b"], "linux");

    const spawned = runner.$.spawned(0).$;
    expect(spawned.command).toBe("/usr/bin/agent");
    expect(spawned.args).toEqual(["serve", "a b"]);
    expect(spawned.shell).toBe(false);
  });
});
