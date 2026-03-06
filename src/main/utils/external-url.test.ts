// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExecException } from "node:child_process";

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

// Mock child_process - the mock is hoisted so we use vi.hoisted to get a reference
const { mockExec } = vi.hoisted(() => {
  return {
    mockExec: vi.fn<(command: string, callback?: ExecCallback) => void>(),
  };
});

vi.mock("node:child_process", () => ({
  exec: mockExec,
}));

// Import after mocking
import { openExternal } from "./external-url";

describe("external-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("openExternal", () => {
    describe("scheme validation", () => {
      it("allows http:// URLs", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });
        await expect(openExternal("http://example.com")).resolves.toBeUndefined();
      });

      it("allows https:// URLs", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });
        await expect(openExternal("https://example.com")).resolves.toBeUndefined();
      });

      it("allows mailto: URLs", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });
        await expect(openExternal("mailto:test@example.com")).resolves.toBeUndefined();
      });

      it("throws for file:// scheme", async () => {
        await expect(openExternal("file:///etc/passwd")).rejects.toThrow(
          "URL scheme 'file:' is not allowed"
        );
      });

      it("throws for javascript: scheme", async () => {
        await expect(openExternal("javascript:alert(1)")).rejects.toThrow(
          "URL scheme 'javascript:' is not allowed"
        );
      });

      it("throws for data: scheme", async () => {
        await expect(openExternal("data:text/html,<script>alert(1)</script>")).rejects.toThrow(
          "URL scheme 'data:' is not allowed"
        );
      });

      it("throws for vbscript: scheme", async () => {
        await expect(openExternal("vbscript:alert")).rejects.toThrow(
          "URL scheme 'vbscript:' is not allowed"
        );
      });

      it("throws for invalid URLs", async () => {
        await expect(openExternal("not-a-url")).rejects.toThrow("Invalid URL");
      });
    });

    describe("Linux platform", () => {
      const originalPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "linux" });
      });

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("tries gdbus portal first", async () => {
        // Simulate success
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });

        await openExternal("https://example.com");

        expect(mockExec).toHaveBeenCalledTimes(1);
        expect(mockExec.mock.calls[0]?.[0]).toMatch(/^gdbus call.*OpenURI/);
        expect(mockExec.mock.calls[0]?.[0]).toContain("https://example.com");
      });

      it("falls back to xdg-open when gdbus fails", async () => {
        // First call (gdbus) fails, second call (xdg-open) succeeds
        mockExec
          .mockImplementationOnce((_command: string, callback?: ExecCallback) => {
            if (callback) callback(new Error("gdbus failed") as ExecException, "", "");
          })
          .mockImplementationOnce((_command: string, callback?: ExecCallback) => {
            if (callback) callback(null, "", "");
          });

        await openExternal("https://example.com");

        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[1]?.[0]).toBe('xdg-open "https://example.com"');
      });

      it("rejects with ExternalUrlError when all Linux openers fail", async () => {
        // Both gdbus and xdg-open fail
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(new Error("failed") as ExecException, "", "");
        });

        await expect(openExternal("https://example.com")).rejects.toThrow(
          "Failed to open external URL"
        );
      });
    });

    describe("macOS platform", () => {
      const originalPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
      });

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("uses open command", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });

        await openExternal("https://example.com");

        expect(mockExec).toHaveBeenCalledTimes(1);
        expect(mockExec.mock.calls[0]?.[0]).toBe('open "https://example.com"');
      });

      it("rejects with ExternalUrlError when open fails", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(new Error("failed") as ExecException, "", "");
        });

        await expect(openExternal("https://example.com")).rejects.toThrow(
          "Failed to open external URL"
        );
      });
    });

    describe("Windows platform", () => {
      const originalPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32" });
      });

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("uses start command", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });

        await openExternal("https://example.com");

        expect(mockExec).toHaveBeenCalledTimes(1);
        expect(mockExec.mock.calls[0]?.[0]).toBe('start "" "https://example.com"');
      });

      it("rejects with ExternalUrlError when start fails", async () => {
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(new Error("failed") as ExecException, "", "");
        });

        await expect(openExternal("https://example.com")).rejects.toThrow(
          "Failed to open external URL"
        );
      });
    });

    describe("URL escaping", () => {
      it("properly escapes URLs with special characters", async () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(null, "", "");
        });

        await openExternal("https://example.com/path?query=value&other=test");

        expect(mockExec.mock.calls[0]?.[0]).toBe(
          'open "https://example.com/path?query=value&other=test"'
        );
      });
    });

    describe("Unsupported platform", () => {
      const originalPlatform = process.platform;

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("rejects with ExternalUrlError for unsupported platform", async () => {
        Object.defineProperty(process, "platform", { value: "freebsd" });

        await expect(openExternal("https://example.com")).rejects.toThrow(
          "Unsupported platform 'freebsd'"
        );
        expect(mockExec).not.toHaveBeenCalled();
      });
    });

    describe("ExternalUrlError", () => {
      it("includes URL in error", async () => {
        Object.defineProperty(process, "platform", { value: "freebsd" });

        try {
          await openExternal("https://example.com");
          expect.fail("should have thrown");
        } catch (error) {
          expect((error as Error).name).toBe("ExternalUrlError");
          expect((error as Error & { url: string }).url).toBe("https://example.com");
        }
      });

      it("includes cause when platform command fails", async () => {
        Object.defineProperty(process, "platform", { value: "darwin" });
        const causeError = new Error("failed") as ExecException;
        mockExec.mockImplementation((_command: string, callback?: ExecCallback) => {
          if (callback) callback(causeError, "", "");
        });

        try {
          await openExternal("https://example.com");
          expect.fail("should have thrown");
        } catch (error) {
          expect((error as Error).name).toBe("ExternalUrlError");
          expect((error as Error & { cause: Error }).cause).toBe(causeError);
        }
      });
    });
  });
});
