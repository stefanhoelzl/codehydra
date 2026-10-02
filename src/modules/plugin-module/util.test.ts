import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { describeIssue, isPlainObject, safeJsonParse } from "./util";

function firstIssue(schema: z.ZodType, value: unknown): z.core.$ZodIssue {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("expected a failure");
  return parsed.error.issues[0]!;
}

describe("describeIssue", () => {
  const strict = z.object({ a: z.object({ b: z.string().optional() }).strict() });

  it("names unknown keys with the noun, singular and plural", () => {
    expect(describeIssue(firstIssue(strict, { a: { x: 1 } }), "field")).toBe("a: unknown field x");
    expect(describeIssue(firstIssue(strict, { a: { x: 1, y: 2 } }), "field")).toBe(
      "a: unknown fields x, y"
    );
  });

  it("follows unknown keys with the hint", () => {
    expect(describeIssue(firstIssue(strict, { a: { x: 1 } }), "key", "a typo")).toBe(
      "a: unknown key x (a typo)"
    );
  });

  it("gives a rejected record key's own reason", () => {
    const record = z.record(
      z.string().refine((key) => key !== "bad", "not allowed"),
      z.string()
    );
    expect(describeIssue(firstIssue(record, { bad: "x" }), "key")).toBe("bad: not allowed");
  });

  it("passes any other issue's message through", () => {
    expect(describeIssue(firstIssue(z.object({ n: z.number() }), { n: "x" }), "key")).toMatch(
      /^n: /
    );
  });
});

describe("safeJsonParse / isPlainObject", () => {
  it("reads text that is not JSON as undefined", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("{")).toBeUndefined();
  });

  it("accepts only a mapping", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});
