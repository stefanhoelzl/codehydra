/**
 * Focused tests for operation hook helpers.
 */

import { describe, it, expect } from "vitest";
import {
  throwHookErrors,
  onlyDefined,
  mergeRecords,
  requireResult,
  mergeHookResults,
  collectErrorMessages,
} from "./hook-helpers";

describe("throwHookErrors", () => {
  it("does nothing for an empty error list", () => {
    expect(() => throwHookErrors([], "label")).not.toThrow();
  });

  it("rethrows a lone error raw (preserves identity and message)", () => {
    const original = new Error("provider exploded");
    try {
      throwHookErrors([original], "label");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBe(original);
    }
  });

  it("wraps multiple errors in an AggregateError with the given message", () => {
    const a = new Error("first");
    const b = new Error("second");
    try {
      throwHookErrors([a, b], "my-op hooks failed");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect(agg.message).toBe("my-op hooks failed");
      expect(agg.errors).toEqual([a, b]);
    }
  });
});

describe("onlyDefined", () => {
  it("returns undefined for empty results", () => {
    const results: { v?: number }[] = [];
    expect(onlyDefined(results, "v", "get")).toBeUndefined();
  });

  it("returns undefined when no result provides the field", () => {
    const results: { v?: number }[] = [{}, {}];
    expect(onlyDefined(results, "v", "get")).toBeUndefined();
  });

  it("returns the one defined value", () => {
    const results: { v?: number }[] = [{}, { v: 2 }, {}];
    expect(onlyDefined(results, "v", "get")).toBe(2);
  });

  it("treats null as a provided value", () => {
    const results: { v?: string | null }[] = [{}, { v: null }];
    expect(onlyDefined(results, "v", "get")).toBeNull();
  });

  it("throws when two results provide the field, naming the hook point and field", () => {
    const results: { v?: string | null }[] = [{ v: "x" }, { v: null }];
    expect(() => onlyDefined(results, "v", "get")).toThrow(
      'get hook conflict: "v" provided by multiple handlers'
    );
  });
});

describe("mergeRecords", () => {
  it("merges disjoint entries from multiple results", () => {
    const results: { env?: Record<string, string> }[] = [
      { env: { A: "1" } },
      {},
      { env: { B: "2" } },
    ];
    expect(mergeRecords(results, "env", "prepare")).toEqual({ A: "1", B: "2" });
  });

  it("returns an empty record when no result provides one", () => {
    const results: { env?: Record<string, string> }[] = [{}];
    expect(mergeRecords(results, "env", "prepare")).toEqual({});
  });

  it("throws on an entry two results set, naming the hook point, field and entry", () => {
    const results: { env?: Record<string, string> }[] = [{ env: { A: "1" } }, { env: { A: "1" } }];
    expect(() => mergeRecords(results, "env", "prepare")).toThrow(
      'prepare hook conflict: env "A" provided by multiple handlers'
    );
  });
});

describe("requireResult", () => {
  it("returns the value when defined", () => {
    expect(requireResult(42, "msg")).toBe(42);
  });

  it("passes through null (only undefined is missing)", () => {
    expect(requireResult<string | null>(null, "msg")).toBeNull();
  });

  it("throws the given message when undefined", () => {
    expect(() => requireResult(undefined, "hook did not provide result")).toThrow(
      "hook did not provide result"
    );
  });
});

describe("mergeHookResults", () => {
  it("merges disjoint fields from multiple results", () => {
    const merged = mergeHookResults([{ a: 1 }, { b: "x" }], "create");
    expect(merged).toEqual({ a: 1, b: "x" });
  });

  it("ignores undefined fields", () => {
    const merged = mergeHookResults([{ a: 1, b: undefined }, { b: "x" }], "create");
    expect(merged).toEqual({ a: 1, b: "x" });
  });

  it("throws on conflicting fields, naming the hook point and field", () => {
    expect(() => mergeHookResults([{ a: 1 }, { a: 2 }], "create")).toThrow(
      'create hook conflict: "a" provided by multiple handlers'
    );
  });

  it("returns empty object for no results", () => {
    expect(mergeHookResults([], "create")).toEqual({});
  });
});

describe("collectErrorMessages", () => {
  it("returns empty list when nothing failed", () => {
    expect(collectErrorMessages([{}, {}], [])).toEqual([]);
  });

  it("collects thrown-handler messages before per-result error strings", () => {
    const messages = collectErrorMessages(
      [{ error: "soft failure" }, {}],
      [new Error("hard failure")]
    );
    expect(messages).toEqual(["hard failure", "soft failure"]);
  });

  it("skips empty error strings", () => {
    expect(collectErrorMessages([{ error: "" }], [])).toEqual([]);
  });
});
