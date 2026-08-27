/**
 * Focused tests for result rendering and output-mode selection.
 */

import { describe, it, expect } from "vitest";
import { EXIT, render, renderError, renderHuman, useJson } from "./output";

describe("useJson", () => {
  it("defaults to JSON when stdout is not a TTY", () => {
    // An agent's Bash call and a shell pipeline both land here.
    expect(useJson(undefined, false)).toBe(true);
  });

  it("defaults to human output at an interactive terminal", () => {
    expect(useJson(undefined, true)).toBe(false);
  });

  it("lets an explicit choice win in both directions", () => {
    expect(useJson(true, true)).toBe(true);
    expect(useJson(false, false)).toBe(false);
  });
});

describe("renderHuman", () => {
  it("prints a scalar bare so it composes with a pipeline", () => {
    expect(renderHuman(25448)).toBe("25448");
    expect(renderHuman("feature-a")).toBe("feature-a");
  });

  it("prints nothing for an empty result", () => {
    expect(renderHuman(null)).toBe("");
    expect(renderHuman(undefined)).toBe("");
    expect(renderHuman([])).toBe("");
  });

  it("aligns an object's keys", () => {
    expect(renderHuman({ port: 3000, sessionId: "abc" })).toBe("port       3000\nsessionId  abc");
  });

  it("prints a list of records as a table", () => {
    const table = renderHuman([
      { name: "a", branch: "main" },
      { name: "bbbb", branch: "topic" },
    ]);

    expect(table).toBe("name  branch\na     main\nbbbb  topic");
  });

  it("takes columns from every row, not just the first", () => {
    // A row missing an optional field must not shift the columns after it.
    const table = renderHuman([{ name: "a" }, { name: "b", url: "http://x" }]);

    expect(table).toBe("name  url\na\nb     http://x");
  });

  it("falls back to compact JSON for a nested value", () => {
    expect(renderHuman({ tags: [{ name: "x" }] })).toBe('tags  [{"name":"x"}]');
  });
});

describe("render", () => {
  it("emits JSON when asked, including for an empty result", () => {
    expect(render({ started: true }, true)).toBe('{"started":true}');
    expect(render(undefined, true)).toBe("null");
  });
});

describe("renderError", () => {
  it("emits a bare message for a person", () => {
    expect(renderError("worktree is locked", EXIT.FAILED, false)).toBe("worktree is locked");
  });

  it("emits a structured error carrying the exit code in JSON mode", () => {
    expect(renderError("not reachable", EXIT.UNREACHABLE, true)).toBe(
      '{"error":"not reachable","exitCode":3}'
    );
  });
});
