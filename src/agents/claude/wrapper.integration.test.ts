// @vitest-environment node
/**
 * Integration tests for wrapper functions that interact with the filesystem.
 * Tests getInitialPromptConfig which uses Node.js fs module directly.
 * Tests runClaude which handles session resume logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import type { RunClaudeDeps } from "./wrapper";

// Must mock fs before importing wrapper
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

// Use dynamic import to ensure mock is set up before wrapper is loaded
let getInitialPromptConfig: typeof import("./wrapper").getInitialPromptConfig;
let runClaude: typeof import("./wrapper").runClaude;

describe("getInitialPromptConfig integration", () => {
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockUnlinkSync = vi.mocked(fs.unlinkSync);
  const mockRmdirSync = vi.mocked(fs.rmdirSync);

  beforeAll(async () => {
    // Dynamic import after mock is set up
    const wrapper = await import("./wrapper");
    getInitialPromptConfig = wrapper.getInitialPromptConfig;
    runClaude = wrapper.runClaude;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the env var before each test
    delete process.env.CODEHYDRA_INITIAL_PROMPT_FILE;
  });

  afterEach(() => {
    delete process.env.CODEHYDRA_INITIAL_PROMPT_FILE;
  });

  it("reads file and returns parsed config", () => {
    // Set up env var
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/codehydra-test/initial-prompt.json";

    // Mock file content
    const fileContent = JSON.stringify({
      prompt: "Hello, Claude!",
      model: "claude-sonnet",
      agent: "coder",
    });
    mockReadFileSync.mockReturnValue(fileContent);

    // Call function
    const result = getInitialPromptConfig();

    // Verify result
    expect(result).toEqual({
      prompt: "Hello, Claude!",
      model: "claude-sonnet",
      agent: "coder",
    });

    // Verify file was read
    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/tmp/codehydra-test/initial-prompt.json",
      "utf-8"
    );

    // Verify file was deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/codehydra-test/initial-prompt.json");

    // Verify temp directory was deleted
    expect(mockRmdirSync).toHaveBeenCalledWith("/tmp/codehydra-test");
  });

  it("returns undefined when env var is not set", () => {
    // No env var set
    const result = getInitialPromptConfig();

    expect(result).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockRmdirSync).not.toHaveBeenCalled();
  });

  it("returns undefined silently when file does not exist (restart scenario)", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/nonexistent/initial-prompt.json";

    // Mock file not found error (expected on restart - file consumed on first launch)
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getInitialPromptConfig();

    expect(result).toBeUndefined();
    // ENOENT should NOT produce a warning - it's expected on restart
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("handles invalid JSON gracefully", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/codehydra-test/initial-prompt.json";

    // Mock invalid JSON content
    mockReadFileSync.mockReturnValue("not valid json {{{");

    // Suppress console.warn during test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getInitialPromptConfig();

    // Should return undefined on JSON parse error
    expect(result).toBeUndefined();

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Warning: Failed to read initial prompt file");

    // Should still attempt cleanup (in catch block)
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/codehydra-test/initial-prompt.json");
    expect(mockRmdirSync).toHaveBeenCalledWith("/tmp/codehydra-test");

    warnSpy.mockRestore();
  });

  it("returns config with prompt only when model and agent are not set", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/codehydra-test/initial-prompt.json";

    // Mock file content with only prompt
    const fileContent = JSON.stringify({ prompt: "Simple prompt" });
    mockReadFileSync.mockReturnValue(fileContent);

    const result = getInitialPromptConfig();

    expect(result).toEqual({ prompt: "Simple prompt" });
    expect(result?.model).toBeUndefined();
    expect(result?.agent).toBeUndefined();
  });

  it("continues cleanup even if unlink fails", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/codehydra-test/initial-prompt.json";

    const fileContent = JSON.stringify({ prompt: "Test" });
    mockReadFileSync.mockReturnValue(fileContent);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    // Should not throw, should return the config
    const result = getInitialPromptConfig();

    expect(result).toEqual({ prompt: "Test" });
    expect(mockUnlinkSync).toHaveBeenCalled();
    // rmdirSync should still be called even if unlink fails
    expect(mockRmdirSync).toHaveBeenCalled();
  });

  it("continues even if rmdir fails", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/codehydra-test/initial-prompt.json";

    const fileContent = JSON.stringify({ prompt: "Test" });
    mockReadFileSync.mockReturnValue(fileContent);
    mockRmdirSync.mockImplementation(() => {
      throw new Error("Directory not empty");
    });

    // Should not throw, should return the config
    const result = getInitialPromptConfig();

    expect(result).toEqual({ prompt: "Test" });
  });
});

/**
 * Create a mock spawnSync function that returns configured exit codes.
 * Tracks all calls for verification.
 */
function createSpawnMock(exitCodes: (number | null)[]): RunClaudeDeps & {
  calls: Array<{ cmd: string; args: string[]; opts: { shell: boolean } }>;
} {
  let callIndex = 0;
  const calls: Array<{ cmd: string; args: string[]; opts: { shell: boolean } }> = [];

  const spawnSync: RunClaudeDeps["spawnSync"] = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts: { shell: opts.shell } });
    const exitCode = exitCodes[callIndex++] ?? 1;
    return { status: exitCode, error: undefined };
  };

  return { spawnSync, calls };
}

describe("runClaude session resume", () => {
  it("succeeds on first attempt with --continue when session exists", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["--ide", "--settings", "/path"], { shell: false }, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.args[0]).toBe("--continue");
    expect(mock.calls[0]?.args).toContain("--ide");
    expect(mock.calls[0]?.args).toContain("--settings");
  });

  it("retries without --continue when first attempt fails", () => {
    const mock = createSpawnMock([1, 0]);

    const result = runClaude("claude", ["--ide", "--settings", "/path"], { shell: false }, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(2);
    // First attempt has --continue
    expect(mock.calls[0]?.args[0]).toBe("--continue");
    // Retry does not have --continue
    expect(mock.calls[1]?.args[0]).toBe("--ide");
    expect(mock.calls[1]?.args).not.toContain("--continue");
  });

  it("returns final exit code when both attempts fail", () => {
    const mock = createSpawnMock([1, 2]);

    const result = runClaude("claude", ["--ide"], { shell: false }, mock);

    expect(result.exitCode).toBe(2);
    expect(mock.calls).toHaveLength(2);
  });

  it("skips auto-continue when user passes --resume flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["--resume", "my-session", "--ide"], { shell: false }, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added --continue
    expect(mock.calls[0]?.args[0]).toBe("--resume");
    expect(mock.calls[0]?.args).not.toContain("--continue");
  });

  it("skips auto-continue when user passes -c flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["-c", "--ide"], { shell: false }, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added duplicate -c
    expect(mock.calls[0]?.args[0]).toBe("-c");
    expect(mock.calls[0]?.args.filter((a) => a === "-c" || a === "--continue")).toHaveLength(1);
  });

  it("skips auto-continue when user passes --continue flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["--continue", "--ide"], { shell: false }, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added duplicate --continue
    expect(mock.calls[0]?.args.filter((a) => a === "--continue")).toHaveLength(1);
  });

  it("preserves initial prompt args in retry", () => {
    const mock = createSpawnMock([1, 0]);

    const result = runClaude(
      "claude",
      ["Hello Claude", "--model", "opus", "--ide"],
      { shell: false },
      mock
    );

    expect(result.exitCode).toBe(0);
    // First attempt should have prompt
    expect(mock.calls[0]?.args).toContain("Hello Claude");
    expect(mock.calls[0]?.args).toContain("--model");
    expect(mock.calls[0]?.args).toContain("opus");
    // Retry should also have prompt
    expect(mock.calls[1]?.args).toContain("Hello Claude");
    expect(mock.calls[1]?.args).toContain("--model");
    expect(mock.calls[1]?.args).toContain("opus");
  });

  it("passes shell option correctly for Windows", () => {
    const mock = createSpawnMock([0]);

    runClaude("claude", ["--ide"], { shell: true }, mock);

    expect(mock.calls[0]?.opts.shell).toBe(true);
  });

  it("passes shell option correctly for non-Windows", () => {
    const mock = createSpawnMock([0]);

    runClaude("claude", ["--ide"], { shell: false }, mock);

    expect(mock.calls[0]?.opts.shell).toBe(false);
  });
});
