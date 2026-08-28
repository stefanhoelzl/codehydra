// @vitest-environment node
/**
 * Integration tests for wrapper functions that interact with the filesystem.
 * Tests getInitialPromptConfig which uses Node.js fs module directly.
 * Tests runClaude which handles session resume logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import type {
  InitialPromptFs,
  RunClaudeDeps,
  getInitialPromptConfig as GetInitialPromptConfigFn,
  runClaude as RunClaudeFn,
} from "./wrapper";
import * as wrapper from "./wrapper";
import { dirname } from "node:path";
import { testPath } from "../../../shared/test-fixtures";

let getInitialPromptConfig: typeof GetInitialPromptConfigFn;
let runClaude: typeof RunClaudeFn;

describe("getInitialPromptConfig integration", () => {
  // These are injected, not module-mocked. wrapper.ts is also loaded by
  // wrapper.test.ts and wrapper.boundary.test.ts, which use the real
  // filesystem. Mocking the fs module here would bind wrapper.ts to whichever
  // test file imports it first, so exactly one of the three would always fail
  // under a shared module registry.
  const mockReadFileSync = vi.fn<(path: string, encoding: "utf-8") => string>();
  const mockUnlinkSync = vi.fn<(path: string) => void>();
  const mockRmdirSync = vi.fn<(path: string) => void>();
  const fakeFs: InitialPromptFs = {
    readFileSync: mockReadFileSync,
    unlinkSync: mockUnlinkSync,
    rmdirSync: mockRmdirSync,
  };

  beforeAll(() => {
    getInitialPromptConfig = wrapper.getInitialPromptConfig;
    runClaude = wrapper.runClaude;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the env var before each test
    delete process.env._CH_INITIAL_PROMPT_FILE;
  });

  afterEach(() => {
    delete process.env._CH_INITIAL_PROMPT_FILE;
  });

  it("reads file and returns parsed config", () => {
    // Set up env var
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/codehydra-test/initial-prompt.json"
    ).toNative();

    // Mock file content
    const fileContent = JSON.stringify({
      prompt: "Hello, Claude!",
      model: "claude-sonnet",
      agentName: "coder",
      permissionMode: "plan",
    });
    mockReadFileSync.mockReturnValue(fileContent);

    // Call function
    const result = getInitialPromptConfig(fakeFs);

    // Verify result
    expect(result).toEqual({
      prompt: "Hello, Claude!",
      model: "claude-sonnet",
      agentName: "coder",
      permissionMode: "plan",
    });

    // Verify file was read
    expect(mockReadFileSync).toHaveBeenCalledWith(
      testPath("/tmp/codehydra-test/initial-prompt.json").toNative(),
      "utf-8"
    );

    // Verify file was deleted
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      testPath("/tmp/codehydra-test/initial-prompt.json").toNative()
    );

    // Verify temp directory was deleted. Derived with the same `dirname` the
    // wrapper uses: `node:path` is bound to the real platform, so a literal here
    // would only be right on the OS it was written for.
    expect(mockRmdirSync).toHaveBeenCalledWith(
      dirname(testPath("/tmp/codehydra-test/initial-prompt.json").toNative())
    );
  });

  it("returns undefined when env var is not set", () => {
    // No env var set
    const result = getInitialPromptConfig(fakeFs);

    expect(result).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockRmdirSync).not.toHaveBeenCalled();
  });

  it("returns undefined silently when file does not exist (restart scenario)", () => {
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/nonexistent/initial-prompt.json"
    ).toNative();

    // Mock file not found error (expected on restart - file consumed on first launch)
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getInitialPromptConfig(fakeFs);

    expect(result).toBeUndefined();
    // ENOENT should NOT produce a warning - it's expected on restart
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("handles invalid JSON gracefully", () => {
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/codehydra-test/initial-prompt.json"
    ).toNative();

    // Mock invalid JSON content
    mockReadFileSync.mockReturnValue("not valid json {{{");

    // Suppress console.warn during test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getInitialPromptConfig(fakeFs);

    // Should return undefined on JSON parse error
    expect(result).toBeUndefined();

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Warning: Failed to read initial prompt file");

    // Should still attempt cleanup (in catch block)
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      testPath("/tmp/codehydra-test/initial-prompt.json").toNative()
    );
    expect(mockRmdirSync).toHaveBeenCalledWith(
      dirname(testPath("/tmp/codehydra-test/initial-prompt.json").toNative())
    );

    warnSpy.mockRestore();
  });

  it("returns config with prompt only when model and agent are not set", () => {
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/codehydra-test/initial-prompt.json"
    ).toNative();

    // Mock file content with only prompt
    const fileContent = JSON.stringify({ prompt: "Simple prompt" });
    mockReadFileSync.mockReturnValue(fileContent);

    const result = getInitialPromptConfig(fakeFs);

    expect(result).toEqual({ prompt: "Simple prompt" });
    expect(result?.model).toBeUndefined();
    expect(result?.agentName).toBeUndefined();
    expect(result?.permissionMode).toBeUndefined();
  });

  it("continues cleanup even if unlink fails", () => {
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/codehydra-test/initial-prompt.json"
    ).toNative();

    const fileContent = JSON.stringify({ prompt: "Test" });
    mockReadFileSync.mockReturnValue(fileContent);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    // Should not throw, should return the config
    const result = getInitialPromptConfig(fakeFs);

    expect(result).toEqual({ prompt: "Test" });
    expect(mockUnlinkSync).toHaveBeenCalled();
    // rmdirSync should still be called even if unlink fails
    expect(mockRmdirSync).toHaveBeenCalled();
  });

  it("continues even if rmdir fails", () => {
    process.env._CH_INITIAL_PROMPT_FILE = testPath(
      "/tmp/codehydra-test/initial-prompt.json"
    ).toNative();

    const fileContent = JSON.stringify({ prompt: "Test" });
    mockReadFileSync.mockReturnValue(fileContent);
    mockRmdirSync.mockImplementation(() => {
      throw new Error("Directory not empty");
    });

    // Should not throw, should return the config
    const result = getInitialPromptConfig(fakeFs);

    expect(result).toEqual({ prompt: "Test" });
  });
});

/**
 * Create a mock spawnSync function that returns configured exit codes.
 * Tracks all calls for verification.
 */
function createSpawnMock(exitCodes: (number | null)[]): RunClaudeDeps & {
  calls: Array<{ cmd: string; args: string[] }>;
} {
  let callIndex = 0;
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const spawnSync: RunClaudeDeps["spawnSync"] = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const exitCode = exitCodes[callIndex++] ?? 1;
    return { status: exitCode, error: undefined };
  };

  return { spawnSync, calls };
}

describe("runClaude session resume", () => {
  it("succeeds on first attempt with --continue when session exists", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude(
      "claude",
      ["--ide", "--settings", testPath("/path").toNative()],
      {},
      mock
    );

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.args[0]).toBe("--continue");
    expect(mock.calls[0]?.args).toContain("--ide");
    expect(mock.calls[0]?.args).toContain("--settings");
  });

  it("retries without --continue when first attempt fails", () => {
    const mock = createSpawnMock([1, 0]);

    const result = runClaude(
      "claude",
      ["--ide", "--settings", testPath("/path").toNative()],
      {},
      mock
    );

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

    const result = runClaude("claude", ["--ide"], {}, mock);

    expect(result.exitCode).toBe(2);
    expect(mock.calls).toHaveLength(2);
  });

  it("skips auto-continue when user passes --resume flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["--resume", "my-session", "--ide"], {}, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added --continue
    expect(mock.calls[0]?.args[0]).toBe("--resume");
    expect(mock.calls[0]?.args).not.toContain("--continue");
  });

  it("skips auto-continue when user passes -c flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["-c", "--ide"], {}, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added duplicate -c
    expect(mock.calls[0]?.args[0]).toBe("-c");
    expect(mock.calls[0]?.args.filter((a) => a === "-c" || a === "--continue")).toHaveLength(1);
  });

  it("skips auto-continue when user passes --continue flag", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude("claude", ["--continue", "--ide"], {}, mock);

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have added duplicate --continue
    expect(mock.calls[0]?.args.filter((a) => a === "--continue")).toHaveLength(1);
  });

  it("preserves initial prompt args in retry", () => {
    const mock = createSpawnMock([1, 0]);

    const result = runClaude("claude", ["Hello Claude", "--model", "opus", "--ide"], {}, mock);

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

  it("skips --continue attempt when skipContinue is true", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude(
      "claude",
      ["--ide", "--settings", testPath("/path").toNative()],
      { skipContinue: true },
      mock
    );

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should NOT have --continue prepended
    expect(mock.calls[0]?.args[0]).toBe("--ide");
    expect(mock.calls[0]?.args).not.toContain("--continue");
  });

  it("attempts --continue when skipContinue is false", () => {
    const mock = createSpawnMock([0]);

    const result = runClaude(
      "claude",
      ["--ide", "--settings", testPath("/path").toNative()],
      { skipContinue: false },
      mock
    );

    expect(result.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    // Should have --continue prepended
    expect(mock.calls[0]?.args[0]).toBe("--continue");
  });
});
