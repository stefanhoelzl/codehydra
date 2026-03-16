/**
 * AsyncWatcher — detects unexpected async activity during synchronous phases.
 *
 * Uses `node:async_hooks` to record any async resource types not in an allowed
 * set. Enable before the synchronous phase, then call `check()` to disable the
 * hook and throw if violations were recorded.
 */

import { createHook, type AsyncHook } from "node:async_hooks";

export class AsyncWatcher {
  private readonly hook: AsyncHook;
  private readonly allowedTypes: ReadonlySet<string>;
  private violations = new Set<string>();

  constructor(allowedTypes: readonly string[]) {
    this.allowedTypes = new Set(allowedTypes);
    this.hook = createHook({
      init: (_asyncId, type) => {
        if (!this.allowedTypes.has(type)) {
          this.violations.add(type);
        }
      },
    });
  }

  enable(): void {
    this.violations.clear();
    this.hook.enable();
  }

  check(): void {
    this.hook.disable();
    if (this.violations.size > 0) {
      const types = [...this.violations].sort().join(", ");
      throw new Error(`AsyncWatcher: unexpected async activity detected: ${types}`);
    }
  }
}
