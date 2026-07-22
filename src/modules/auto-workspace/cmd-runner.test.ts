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

  it("invokes the cmd through a shell", async () => {
    const processRunner = createMockProcessRunner({ onSpawn: () => ({ stdout: "[]" }) });
    await runCmd({ processRunner }, "gh api");
    const spawned = processRunner.$.spawned(0);
    // sh -c "gh api" on posix, cmd /c "gh api" on windows
    expect(spawned.$.args[spawned.$.args.length - 1]).toBe("gh api");
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
