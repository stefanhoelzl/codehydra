/**
 * Tests for PlatformError.
 */

import { describe, it, expect } from "vitest";
import { PlatformError, isPlatformError, isPlatformErrorWithCode } from "./errors";

describe("PlatformError", () => {
  it("preserves code and message", () => {
    const error = new PlatformError("IPC_HANDLER_EXISTS", "Handler already exists");

    expect(error.code).toBe("IPC_HANDLER_EXISTS");
    expect(error.message).toBe("Handler already exists");
    expect(error.name).toBe("PlatformError");
  });

  it("extends Error", () => {
    const error = new PlatformError("IPC_HANDLER_NOT_FOUND", "Not found");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PlatformError);
  });

  it("has correct stack trace", () => {
    const error = new PlatformError("APP_NOT_READY", "App not ready");

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain("PlatformError");
  });

  it("works with different error codes", () => {
    const codes = [
      "IPC_HANDLER_EXISTS",
      "IPC_HANDLER_NOT_FOUND",
      "DIALOG_CANCELLED",
      "IMAGE_LOAD_FAILED",
      "APP_NOT_READY",
    ] as const;

    for (const code of codes) {
      const error = new PlatformError(code, `Error: ${code}`);
      expect(error.code).toBe(code);
    }
  });
});

describe("isPlatformError", () => {
  it("returns true for PlatformError", () => {
    const error = new PlatformError("IPC_HANDLER_EXISTS", "test");
    expect(isPlatformError(error)).toBe(true);
  });

  it("returns false for regular Error", () => {
    const error = new Error("test");
    expect(isPlatformError(error)).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isPlatformError(null)).toBe(false);
    expect(isPlatformError(undefined)).toBe(false);
    expect(isPlatformError("string")).toBe(false);
    expect(isPlatformError({})).toBe(false);
  });
});

describe("isPlatformErrorWithCode", () => {
  it("returns true for matching code", () => {
    const error = new PlatformError("IPC_HANDLER_EXISTS", "test");
    expect(isPlatformErrorWithCode(error, "IPC_HANDLER_EXISTS")).toBe(true);
  });

  it("returns false for non-matching code", () => {
    const error = new PlatformError("IPC_HANDLER_EXISTS", "test");
    expect(isPlatformErrorWithCode(error, "IPC_HANDLER_NOT_FOUND")).toBe(false);
  });

  it("returns false for non-PlatformError", () => {
    const error = new Error("test");
    expect(isPlatformErrorWithCode(error, "IPC_HANDLER_EXISTS")).toBe(false);
  });
});
