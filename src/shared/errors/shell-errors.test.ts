import { describe, it, expect } from "vitest";
import { ShellError } from "./shell-errors";

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
