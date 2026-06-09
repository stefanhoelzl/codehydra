// @vitest-environment node
/**
 * Focused tests for the pure helpers in claude/types.ts:
 * - configBusyDuringBackgroundShell (config parse/validate)
 * - taskKeepsBusy (background task classification)
 */

import { describe, it, expect } from "vitest";
import { configBusyDuringBackgroundShell, taskKeepsBusy } from "./types";

describe("configBusyDuringBackgroundShell", () => {
  const builder = configBusyDuringBackgroundShell();

  describe("parse (CLI/env)", () => {
    it.each([
      ["true", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ])("parses %s", (raw, expected) => {
      expect(builder.parse(raw)).toBe(expected);
    });

    it("rejects non-boolean strings (arrays are config.json-only)", () => {
      expect(builder.parse("ship-wait,vite")).toBeUndefined();
      expect(builder.parse("")).toBeUndefined();
    });
  });

  describe("validate (config.json)", () => {
    it("accepts booleans", () => {
      expect(builder.validate(true)).toBe(true);
      expect(builder.validate(false)).toBe(false);
    });

    it("accepts an array of valid regexes", () => {
      expect(builder.validate(["ship-wait", "^npx tsx"])).toEqual(["ship-wait", "^npx tsx"]);
      expect(builder.validate([])).toEqual([]);
    });

    it("rejects arrays with invalid regexes", () => {
      expect(builder.validate(["valid", "[unclosed"])).toBeUndefined();
    });

    it("rejects arrays with non-string entries and other types", () => {
      expect(builder.validate(["ok", 5])).toBeUndefined();
      expect(builder.validate("ship-wait")).toBeUndefined();
      expect(builder.validate(null)).toBeUndefined();
    });
  });
});

describe("taskKeepsBusy", () => {
  const runningShell = {
    id: "t1",
    type: "shell",
    status: "running",
    description: "Wait for PR merge",
    command: "npx tsx ship-wait.ts 512",
  };

  it("true keeps every running shell busy", () => {
    expect(taskKeepsBusy(true, runningShell)).toBe(true);
  });

  it("false never keeps busy", () => {
    expect(taskKeepsBusy(false, runningShell)).toBe(false);
  });

  it("patterns match the command (partial, case-sensitive)", () => {
    expect(taskKeepsBusy(["ship-wait"], runningShell)).toBe(true);
    expect(taskKeepsBusy(["^npx tsx"], runningShell)).toBe(true);
    expect(taskKeepsBusy(["SHIP-WAIT"], runningShell)).toBe(false);
    expect(taskKeepsBusy(["http\\.server"], runningShell)).toBe(false);
  });

  it("non-shell types never keep busy", () => {
    expect(taskKeepsBusy(true, { ...runningShell, type: "agent" })).toBe(false);
    expect(taskKeepsBusy(true, { id: "t1", status: "running", command: "sleep 60" })).toBe(false);
  });

  it("non-running status never keeps busy; missing status counts as running", () => {
    expect(taskKeepsBusy(true, { ...runningShell, status: "completed" })).toBe(false);
    expect(taskKeepsBusy(true, { id: "t1", type: "shell", command: "sleep 60" })).toBe(true);
  });

  it("patterns without a command never match", () => {
    expect(taskKeepsBusy(["ship-wait"], { id: "t1", type: "shell", status: "running" })).toBe(
      false
    );
  });
});
