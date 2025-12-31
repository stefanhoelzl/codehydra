import { describe, it, expect } from "vitest";
import { createHandlerRegistry } from "./utils";

describe("createHandlerRegistry", () => {
  it("adds and invokes handlers via forEach", () => {
    const registry = createHandlerRegistry<(value: number) => void>();
    const results: number[] = [];

    registry.add((v) => results.push(v));
    registry.add((v) => results.push(v * 2));

    registry.forEach((h) => h(5));

    expect(results).toEqual([5, 10]);
  });

  it("returns unsubscribe function from add", () => {
    const registry = createHandlerRegistry<(value: string) => void>();
    const results: string[] = [];

    const unsubscribe = registry.add((v) => results.push(v));
    registry.forEach((h) => h("first"));

    unsubscribe();
    registry.forEach((h) => h("second"));

    expect(results).toEqual(["first"]);
  });

  it("clears all handlers", () => {
    const registry = createHandlerRegistry<() => void>();
    let callCount = 0;

    registry.add(() => callCount++);
    registry.add(() => callCount++);

    registry.clear();
    registry.forEach((h) => h());

    expect(callCount).toBe(0);
  });

  it("handles multiple unsubscribes for same handler gracefully", () => {
    const registry = createHandlerRegistry<() => void>();
    let callCount = 0;

    const handler = () => callCount++;
    const unsubscribe = registry.add(handler);

    unsubscribe();
    unsubscribe(); // Should not throw

    registry.forEach((h) => h());
    expect(callCount).toBe(0);
  });
});
