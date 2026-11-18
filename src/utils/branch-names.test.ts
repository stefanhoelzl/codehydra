import { describe, expect, it } from "vitest";
import { clashingBranch, namesRuledOutBy } from "./branch-names";

describe("clashingBranch", () => {
  it.each([
    ["a", ["main", "a/b"], "a/b"],
    ["a/b", ["main", "a"], "a"],
    ["a/b/c", ["a"], "a"],
    ["a", ["a/b/c"], "a/b/c"],
  ])("%s clashes with an existing branch in %j", (name, existing, clash) => {
    expect(clashingBranch(name, existing)).toBe(clash);
  });

  it.each([
    ["a", ["a"]],
    ["a", ["ab", "a-b", "b/a"]],
    ["a/b", ["a/c", "a/bc", "ab"]],
    ["a", []],
  ])("%s does not clash with %j", (name, existing) => {
    expect(clashingBranch(name, existing)).toBeUndefined();
  });
});

describe("namesRuledOutBy", () => {
  it("rules out a branch's parents and every name nested under it", () => {
    expect(namesRuledOutBy("a/b/c")).toEqual({ exact: ["a", "a/b"], prefix: "a/b/c/" });
    expect(namesRuledOutBy("main")).toEqual({ exact: [], prefix: "main/" });
  });
});
