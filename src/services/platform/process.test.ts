// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { ExecaProcessRunner, type SpawnedProcess, type ProcessRunner } from "./process";

describe("ExecaProcessRunner", () => {
  // Create runner once (stateless, safe to reuse)
  const runner: ProcessRunner = new ExecaProcessRunner();
  const runningProcesses: SpawnedProcess[] = [];

  afterEach(async () => {
    // Clean up any running processes
    for (const proc of runningProcesses) {
      try {
        proc.kill();
        await proc.wait(100);
      } catch {
        // Ignore errors during cleanup
      }
    }
    runningProcesses.length = 0;
  });

  it("spawns a process and returns SpawnedProcess handle", async () => {
    const proc = runner.run("echo", ["hello"]);
    runningProcesses.push(proc);

    expect(proc.pid).toBeDefined();
    expect(typeof proc.pid).toBe("number");

    const result = await proc.wait();

    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stdout from process", async () => {
    const proc = runner.run("echo", ["test output"]);
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.stdout).toContain("test output");
  });

  it("captures stderr from process", async () => {
    const proc = runner.run("sh", ["-c", "echo error >&2"]);
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.stderr).toContain("error");
  });

  it("provides exit code on completion", async () => {
    const proc = runner.run("sh", ["-c", "exit 0"]);
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.exitCode).toBe(0);
  });

  it("provides non-zero exit code on failure (no throw)", async () => {
    const proc = runner.run("sh", ["-c", "exit 42"]);
    runningProcesses.push(proc);

    // With reject: false, wait() doesn't throw - it returns the result
    const result = await proc.wait();

    expect(result.exitCode).toBe(42);
  });

  it("can be killed gracefully", async () => {
    const proc = runner.run("sleep", ["10"]);
    runningProcesses.push(proc);

    // Kill the process
    const killed = proc.kill("SIGTERM");
    expect(killed).toBe(true);

    const result = await proc.wait();

    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBeNull();
  });

  it("supports custom working directory", async () => {
    const proc = runner.run("pwd", [], { cwd: "/tmp" });
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("supports environment variables", async () => {
    const proc = runner.run("sh", ["-c", "echo $TEST_VAR"], {
      env: { ...process.env, TEST_VAR: "test_value" },
    });
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.stdout).toContain("test_value");
  });

  it("wait() with timeout returns running:true when process doesn't exit in time", async () => {
    const proc = runner.run("sleep", ["10"]);
    runningProcesses.push(proc);

    const result = await proc.wait(100);

    expect(result.running).toBe(true);
    expect(result.exitCode).toBeNull();

    // Clean up
    proc.kill();
  });

  it("wait() with timeout returns result when process exits before timeout", async () => {
    const proc = runner.run("echo", ["quick"]);
    runningProcesses.push(proc);

    const result = await proc.wait(5000);

    expect(result.running).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("quick");
  });

  it("multiple wait() calls return same result after process exits", async () => {
    const proc = runner.run("echo", ["cached"]);
    runningProcesses.push(proc);

    const result1 = await proc.wait();
    const result2 = await proc.wait();

    expect(result1).toEqual(result2);
  });

  it("kill() returns false when process already dead", async () => {
    const proc = runner.run("echo", ["done"]);
    runningProcesses.push(proc);

    await proc.wait();

    const killed = proc.kill();
    expect(killed).toBe(false);
  });

  it("handles ENOENT when command not found", async () => {
    const proc = runner.run("nonexistent-command-12345", []);
    runningProcesses.push(proc);

    const result = await proc.wait();

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("ENOENT");
    expect(proc.pid).toBeUndefined();
  });
});
