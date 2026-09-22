import { describe, it, expect } from "vitest";
import { constants as osConstants } from "node:os";
import { childExitCode } from "./child-exit";

describe("childExitCode", () => {
  it("passes an exit code through", () => {
    expect(childExitCode(0, null)).toBe(0);
    expect(childExitCode(42, null)).toBe(42);
  });

  it("reports a signal the way a shell does, as 128 + its number", () => {
    expect(childExitCode(null, "SIGTERM")).toBe(128 + osConstants.signals.SIGTERM);
    expect(childExitCode(null, "SIGINT")).toBe(128 + osConstants.signals.SIGINT);
  });

  it("falls back to 1 when there is neither", () => {
    expect(childExitCode(null, null)).toBe(1);
  });
});
