// @vitest-environment node
/**
 * Focused tests for the pure helpers in claude/types.ts:
 * - isBackgroundWrapped (ch-bg marker detection)
 * - taskKeepsBusy (background task classification)
 */

import { describe, it, expect } from "vitest";
import {
  ALL_HOOK_NAMES,
  isBackgroundWrapped,
  registeredHooks,
  taskKeepsBusy,
  WRAPPER_HOOK_NAMES,
} from "./types";

describe("isBackgroundWrapped", () => {
  it("matches the ch bg subcommand form", () => {
    // The canonical spelling. Missing it would silently make every wrapped
    // shell keep the workspace busy again.
    expect(isBackgroundWrapped("ch bg npm run dev")).toBe(true);
  });

  it("matches the subcommand form through a shell and an absolute path", () => {
    expect(isBackgroundWrapped('bash -c "ch bg npm run dev"')).toBe(true);
    expect(isBackgroundWrapped("/app-data/bin/ch bg npm run dev")).toBe(true);
  });

  it("tolerates extra whitespace between the words", () => {
    expect(isBackgroundWrapped("ch  bg npm run dev")).toBe(true);
  });

  it("does not match a command that merely starts with those letters", () => {
    expect(isBackgroundWrapped("ch bgfoo")).toBe(false);
    expect(isBackgroundWrapped("switch bg")).toBe(false);
  });

  it("matches the ch-bg wrapper as a leading command", () => {
    expect(isBackgroundWrapped("ch-bg npm run dev")).toBe(true);
  });

  it("matches ch-bg nested in a shell invocation or an absolute path", () => {
    expect(isBackgroundWrapped('bash -c "ch-bg npm run dev"')).toBe(true);
    expect(isBackgroundWrapped("/app-data/bin/ch-bg npm run dev")).toBe(true);
  });

  it("does not match when ch-bg is part of a larger token", () => {
    expect(isBackgroundWrapped("xch-bg npm run dev")).toBe(false);
    expect(isBackgroundWrapped("ch-bgx npm run dev")).toBe(false);
  });

  it("does not match an unwrapped command", () => {
    expect(isBackgroundWrapped("npm run dev")).toBe(false);
    expect(isBackgroundWrapped("")).toBe(false);
  });
});

describe("taskKeepsBusy", () => {
  const runningShell = {
    id: "t1",
    type: "shell",
    status: "running",
    description: "Start the dev server",
    command: "npm run serve",
  };

  it("keeps an unwrapped running shell busy by default", () => {
    expect(taskKeepsBusy(runningShell)).toBe(true);
  });

  it("excludes a shell invoked through the ch-bg wrapper", () => {
    expect(taskKeepsBusy({ ...runningShell, command: "ch-bg npm run serve" })).toBe(false);
    expect(taskKeepsBusy({ ...runningShell, command: 'bash -c "ch-bg npm run serve"' })).toBe(
      false
    );
  });

  it("subagents always keep busy, wrapper marker notwithstanding", () => {
    expect(taskKeepsBusy({ id: "t1", type: "subagent", status: "running" })).toBe(true);
  });

  it("non-shell, non-subagent types never keep busy", () => {
    expect(taskKeepsBusy({ ...runningShell, type: "agent" })).toBe(false);
  });

  it("non-running status never keeps busy; missing status counts as running", () => {
    expect(taskKeepsBusy({ ...runningShell, status: "completed" })).toBe(false);
    expect(taskKeepsBusy({ id: "t1", type: "shell", command: "sleep 60" })).toBe(true);
  });

  it("a shell without a command keeps busy (unwrapped by definition)", () => {
    expect(taskKeepsBusy({ id: "t1", type: "shell", status: "running" })).toBe(true);
  });
});

describe("hook registration", () => {
  it("registers every hook except the wrapper-synthesized ones", () => {
    const registered = new Set(registeredHooks().map(([name]) => name));

    for (const name of WRAPPER_HOOK_NAMES) {
      expect(registered.has(name)).toBe(false);
    }
    // Both derive from the same map, so a hook is registered exactly when the
    // bridge accepts it — there is no third state to fall into.
    expect(registered.size + WRAPPER_HOOK_NAMES.size).toBe(ALL_HOOK_NAMES.length);
  });

  it("scopes only the tool-ish hooks with a matcher", () => {
    const withMatcher = registeredHooks()
      .filter(([, register]) => register.matcher !== undefined)
      .map(([name]) => name);

    expect(new Set(withMatcher)).toEqual(
      new Set(["PermissionRequest", "PreToolUse", "PostToolUse"])
    );
  });
});
