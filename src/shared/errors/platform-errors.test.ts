/**
 * Tests for PlatformError.
 */

import { describe, it, expect } from "vitest";
import { PlatformError } from "./platform-errors";

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
