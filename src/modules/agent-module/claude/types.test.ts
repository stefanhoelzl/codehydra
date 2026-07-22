// @vitest-environment node
/**
 * Focused tests for the pure helpers in claude/types.ts:
 * - isBackgroundWrapped (ch-bg marker detection)
 * - taskKeepsBusy (background task classification)
 */

import { describe, it, expect } from "vitest";
import { isBackgroundWrapped, taskKeepsBusy } from "./types";

describe("isBackgroundWrapped", () => {
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
