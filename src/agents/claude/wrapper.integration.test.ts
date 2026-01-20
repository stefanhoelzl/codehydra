// @vitest-environment node
/**
 * Integration tests for wrapper functions that interact with the filesystem.
 * Tests getInitialPromptConfig which uses Node.js fs module directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";

// Must mock fs before importing wrapper
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

// Use dynamic import to ensure mock is set up before wrapper is loaded
let getInitialPromptConfig: typeof import("./wrapper").getInitialPromptConfig;

describe("getInitialPromptConfig integration", () => {
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockUnlinkSync = vi.mocked(fs.unlinkSync);
  const mockRmdirSync = vi.mocked(fs.rmdirSync);

  beforeAll(async () => {
    // Dynamic import after mock is set up
    const wrapper = await import("./wrapper");
    getInitialPromptConfig = wrapper.getInitialPromptConfig;
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

  it("returns undefined when file does not exist", () => {
    process.env.CODEHYDRA_INITIAL_PROMPT_FILE = "/tmp/nonexistent/initial-prompt.json";

    // Mock file not found error
    mockReadFileSync.mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    // Suppress console.warn during test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getInitialPromptConfig();

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

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
