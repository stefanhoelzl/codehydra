import { describe, it, expect } from "vitest";
import { ShellError, isShellError, isShellErrorWithCode } from "./shell-errors";

describe("ShellError", () => {
  describe("constructor", () => {
    it("creates error with code and message", () => {
      const error = new ShellError("WINDOW_NOT_FOUND", "Window not found");

      expect(error.code).toBe("WINDOW_NOT_FOUND");
      expect(error.message).toBe("Window not found");
      expect(error.handle).toBeUndefined();
      expect(error.name).toBe("ShellError");
    });

    it("creates error with code, message, and handle", () => {
      const error = new ShellError("VIEW_DESTROYED", "View was destroyed", "view-42");

      expect(error.code).toBe("VIEW_DESTROYED");
      expect(error.message).toBe("View was destroyed");
      expect(error.handle).toBe("view-42");
    });

    it("supports all error codes", () => {
      const codes = [
        "WINDOW_NOT_FOUND",
        "WINDOW_DESTROYED",
        "VIEW_NOT_FOUND",
        "VIEW_DESTROYED",
        "SESSION_NOT_FOUND",
        "NAVIGATION_FAILED",
      ] as const;

      for (const code of codes) {
        const error = new ShellError(code, `Error: ${code}`);
        expect(error.code).toBe(code);
      }
    });
  });

  describe("instanceof", () => {
    it("is instance of Error", () => {
      const error = new ShellError("WINDOW_NOT_FOUND", "Window not found");

      expect(error).toBeInstanceOf(Error);
    });

    it("is instance of ShellError", () => {
      const error = new ShellError("WINDOW_NOT_FOUND", "Window not found");

      expect(error).toBeInstanceOf(ShellError);
    });
  });
});

describe("isShellError", () => {
  it("returns true for ShellError instances", () => {
    const error = new ShellError("VIEW_NOT_FOUND", "View not found");

    expect(isShellError(error)).toBe(true);
  });

  it("returns false for regular Error", () => {
    const error = new Error("Regular error");

    expect(isShellError(error)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isShellError(null)).toBe(false);
    expect(isShellError(undefined)).toBe(false);
    expect(isShellError("error")).toBe(false);
    expect(isShellError({ code: "WINDOW_NOT_FOUND" })).toBe(false);
  });
});

describe("isShellErrorWithCode", () => {
  it("returns true when error has matching code", () => {
    const error = new ShellError("SESSION_NOT_FOUND", "Session not found");

    expect(isShellErrorWithCode(error, "SESSION_NOT_FOUND")).toBe(true);
  });

  it("returns false when error has different code", () => {
    const error = new ShellError("WINDOW_NOT_FOUND", "Window not found");

    expect(isShellErrorWithCode(error, "VIEW_NOT_FOUND")).toBe(false);
  });

  it("returns false for non-ShellError", () => {
    const error = new Error("Regular error");

    expect(isShellErrorWithCode(error, "WINDOW_NOT_FOUND")).toBe(false);
  });
});
