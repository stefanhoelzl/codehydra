// @vitest-environment node
import { describe, it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { AsyncWatcher } from "./async-watcher";

describe("AsyncWatcher", () => {
  it("does not throw for promises only", async () => {
    const watcher = new AsyncWatcher(["PROMISE", "TickObject"]);
    watcher.enable();

    await Promise.resolve();
    await Promise.all([Promise.resolve(1), Promise.resolve(2)]);

    expect(() => watcher.check()).not.toThrow();
  });

  it("throws when FS I/O is performed", async () => {
    const watcher = new AsyncWatcher(["PROMISE", "TickObject"]);
    watcher.enable();

    await stat("/");

    expect(() => watcher.check()).toThrow("AsyncWatcher: unexpected async activity detected:");
  });

  it("throws when a timer is created", () => {
    const watcher = new AsyncWatcher(["PROMISE", "TickObject"]);
    watcher.enable();

    const handle = setTimeout(() => {}, 10_000);
    clearTimeout(handle);

    expect(() => watcher.check()).toThrow("AsyncWatcher: unexpected async activity detected:");
  });

  it("resets violations between uses", async () => {
    const watcher = new AsyncWatcher(["PROMISE", "TickObject"]);

    // First pass — FS I/O triggers violation
    watcher.enable();
    await stat("/");
    expect(() => watcher.check()).toThrow();

    // Second pass — promises only, should succeed
    watcher.enable();
    await Promise.resolve();
    expect(() => watcher.check()).not.toThrow();
  });

  it("check() disables the watcher so subsequent activity is not captured", async () => {
    const watcher = new AsyncWatcher(["PROMISE", "TickObject"]);
    watcher.enable();
    // Clean check — no violations
    expect(() => watcher.check()).not.toThrow();

    // Activity after check() should not be recorded
    await stat("/");

    // Re-enable with a clean slate — should pass
    watcher.enable();
    expect(() => watcher.check()).not.toThrow();
  });
});
