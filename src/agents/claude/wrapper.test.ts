// @vitest-environment node
/**
 * Focused tests for wrapper pure functions.
 * Tests buildInitialPromptArgs function.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInitialPromptArgs,
  buildPermissionArgs,
  consumeNoSessionMarker,
  type InitialPromptConfig,
} from "./wrapper";

describe("buildPermissionArgs", () => {
  it("returns --dangerously-skip-permissions when no agent", () => {
    expect(buildPermissionArgs()).toEqual(["--dangerously-skip-permissions"]);
  });

  it("returns --dangerously-skip-permissions for implement agent", () => {
    expect(buildPermissionArgs("implement")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("returns plan mode flags for plan agent", () => {
    expect(buildPermissionArgs("plan")).toEqual([
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "plan",
    ]);
  });

  it("returns --dangerously-skip-permissions for unknown agents", () => {
    expect(buildPermissionArgs("coder")).toEqual(["--dangerously-skip-permissions"]);
  });
});

describe("buildInitialPromptArgs", () => {
  it("with prompt only returns prompt as single argument", () => {
    const config: InitialPromptConfig = { prompt: "Hello, Claude!" };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(["Hello, Claude!"]);
  });

  it("with model adds --model flag", () => {
    const config: InitialPromptConfig = { prompt: "Hi", model: "claude-sonnet" };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(["Hi", "--model", "claude-sonnet"]);
  });

  it("with agent adds --agent flag", () => {
    const config: InitialPromptConfig = { prompt: "Hi", agent: "coder" };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(["Hi", "--agent", "coder"]);
  });

  it("with all options adds all flags", () => {
    const config: InitialPromptConfig = {
      prompt: "Implement the feature",
      model: "claude-opus",
      agent: "architect",
    };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual([
      "Implement the feature",
      "--model",
      "claude-opus",
      "--agent",
      "architect",
    ]);
  });

  it("preserves prompt with special characters", () => {
    const config: InitialPromptConfig = {
      prompt: 'Fix the "login" bug in src/auth.ts',
    };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(['Fix the "login" bug in src/auth.ts']);
  });

  it("preserves multiline prompts", () => {
    const config: InitialPromptConfig = {
      prompt: "Line 1\nLine 2\nLine 3",
    };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(["Line 1\nLine 2\nLine 3"]);
  });

  it("omits empty prompt but includes agent flag", () => {
    const config: InitialPromptConfig = { prompt: "", agent: "plan" };
    const args = buildInitialPromptArgs(config);
    expect(args).toEqual(["--agent", "plan"]);
  });
});

describe("consumeNoSessionMarker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ch-wrapper-test-"));
    delete process.env._CH_CLAUDE_NO_SESSION_MARKER_PATH;
  });

  afterEach(() => {
    delete process.env._CH_CLAUDE_NO_SESSION_MARKER_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when env var is not set", () => {
    expect(consumeNoSessionMarker()).toBe(false);
  });

  it("returns true and deletes marker when file exists", () => {
    const markerPath = join(tempDir, "no-session-marker");
    writeFileSync(markerPath, "");
    process.env._CH_CLAUDE_NO_SESSION_MARKER_PATH = markerPath;

    expect(consumeNoSessionMarker()).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("returns false when env var is set but file does not exist", () => {
    process.env._CH_CLAUDE_NO_SESSION_MARKER_PATH = join(tempDir, "nonexistent");
    expect(consumeNoSessionMarker()).toBe(false);
  });
});
