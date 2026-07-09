/**
 * Tests for the pure log-level parsing helpers exported by `electron-log.ts`.
 *
 * The `ElectronLog` class itself is covered by `electron-log.boundary.test.ts`,
 * which drives the real `electron-log` module and asserts on the files it
 * writes. It is deliberately not tested through a module mock here: `logging.ts`
 * re-exports `ElectronLog`, so ~120 node-project test files load this module
 * with the real `electron-log/main`. A `vi.mock` in this one file binds only if
 * it happens to import first, which made the suite fail order-dependently under
 * a shared module registry — and, because the constructor mutates
 * `log.transports.*` on the real singleton, drove the real file transport at
 * the fake `/test/app-data/logs` path (EACCES).
 */

import { describe, it, expect } from "vitest";
import { parseLogLevel, parseLogLevelSpec, splitLogLevelSpec } from "./electron-log";

describe("ElectronLog log-level parsing", () => {
  describe("parseLogLevel", () => {
    it("parses valid log levels", async () => {
      expect(parseLogLevel("debug")).toBe("debug");
      expect(parseLogLevel("info")).toBe("info");
      expect(parseLogLevel("warn")).toBe("warn");
      expect(parseLogLevel("error")).toBe("error");
      expect(parseLogLevel("silly")).toBe("silly");
    });

    it("handles uppercase input", async () => {
      expect(parseLogLevel("ERROR")).toBe("error");
      expect(parseLogLevel("DEBUG")).toBe("debug");
    });

    it("handles whitespace", async () => {
      expect(parseLogLevel("  info  ")).toBe("info");
    });

    it("returns undefined for invalid input", async () => {
      expect(parseLogLevel("invalid")).toBeUndefined();
      expect(parseLogLevel("")).toBeUndefined();
      expect(parseLogLevel(undefined)).toBeUndefined();
    });
  });

  describe("parseLogLevelSpec", () => {
    it("validates plain log levels", async () => {
      expect(parseLogLevelSpec("debug")).toBe("debug");
      expect(parseLogLevelSpec("warn")).toBe("warn");
      expect(parseLogLevelSpec("error")).toBe("error");
      expect(parseLogLevelSpec("silly")).toBe("silly");
      expect(parseLogLevelSpec("info")).toBe("info");
    });

    it("validates combined level:filter format", async () => {
      expect(parseLogLevelSpec("debug:git,process")).toBe("debug:git,process");
      expect(parseLogLevelSpec("warn:network")).toBe("warn:network");
    });

    it("validates wildcard filter", async () => {
      expect(parseLogLevelSpec("debug:*")).toBe("debug:*");
    });

    it("trims whitespace", async () => {
      expect(parseLogLevelSpec("  debug  ")).toBe("debug");
    });

    it("returns undefined for invalid level", async () => {
      expect(parseLogLevelSpec("invalid")).toBeUndefined();
      expect(parseLogLevelSpec("invalid:git")).toBeUndefined();
    });

    it("returns undefined for empty or undefined input", async () => {
      expect(parseLogLevelSpec(undefined)).toBeUndefined();
      expect(parseLogLevelSpec("")).toBeUndefined();
      expect(parseLogLevelSpec("  ")).toBeUndefined();
    });

    it("returns undefined for level with empty filter", async () => {
      expect(parseLogLevelSpec("debug:")).toBeUndefined();
    });
  });

  describe("splitLogLevelSpec", () => {
    it("extracts level from plain spec", async () => {
      expect(splitLogLevelSpec("debug")).toEqual({ level: "debug", filter: undefined });
      expect(splitLogLevelSpec("warn")).toEqual({ level: "warn", filter: undefined });
    });

    it("extracts level and filter from combined spec", async () => {
      const result = splitLogLevelSpec("debug:git,process");
      expect(result.level).toBe("debug");
      expect(result.filter).toEqual(new Set(["git", "process"]));
    });

    it("treats * filter as undefined (all loggers)", async () => {
      expect(splitLogLevelSpec("debug:*")).toEqual({ level: "debug", filter: undefined });
    });
  });
});
