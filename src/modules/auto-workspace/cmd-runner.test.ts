import { describe, it, expect } from "vitest";
import { createMockProcessRunner } from "../../boundaries/platform/process.state-mock";
import { runCmd } from "./cmd-runner";

function runner(config: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  running?: boolean;
}) {
  return createMockProcessRunner({ onSpawn: () => config });
}

describe("runCmd", () => {
  it("parses a JSON array from stdout", async () => {
    const processRunner = runner({ stdout: '[{"a":1},{"a":2}]' });
    await expect(runCmd({ processRunner }, "echo")).resolves.toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("hands the raw cmd to the runner with shell:true", async () => {
    const processRunner = createMockProcessRunner({ onSpawn: () => ({ stdout: "[]" }) });
    const cmd = `curl -H "Authorization: Bearer x" 'https://example.com'`;

    await runCmd({ processRunner }, cmd);

    // Must NOT hand-roll `sh -c` / `cmd /c`: passing the line as an argv entry
    // leaves it to be escaped as an ordinary argument, and the `\"` that Windows
    // escaping produces is not something cmd.exe understands. Node builds the
    // platform invocation from shell:true instead.
    const spawned = processRunner.$.spawned(0);
    expect(spawned.$.command).toBe(cmd);
    expect(spawned.$.args).toEqual([]);
    expect(spawned.$.shell).toBe(true);
  });

  it("throws on a non-zero exit code", async () => {
    const processRunner = runner({ exitCode: 1, stderr: "boom" });
    await expect(runCmd({ processRunner }, "x")).rejects.toThrow(/boom/);
  });

  it("throws on invalid JSON", async () => {
    const processRunner = runner({ stdout: "not json" });
    await expect(runCmd({ processRunner }, "x")).rejects.toThrow(/not valid JSON/);
  });

  it("throws when stdout is not a JSON array", async () => {
    const processRunner = runner({ stdout: '{"items":[]}' });
    await expect(runCmd({ processRunner }, "x")).rejects.toThrow(/not a JSON array/);
  });

  it("throws on a timeout (still running)", async () => {
    const processRunner = runner({ running: true, stdout: "" });
    await expect(runCmd({ processRunner }, "x")).rejects.toThrow(/timed out/);
  });
});
