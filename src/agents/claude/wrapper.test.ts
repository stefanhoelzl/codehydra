// @vitest-environment node
/**
 * Focused tests for wrapper pure functions.
 * Tests buildInitialPromptArgs function.
 */

import { describe, it, expect } from "vitest";
import { buildInitialPromptArgs, buildPermissionArgs, type InitialPromptConfig } from "./wrapper";

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
});
