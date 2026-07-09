/**
 * Shared fake for `$lib/api`, resolved by `vi.mock("$lib/api")`.
 *
 * There is one instance per worker, so it does not matter which test file
 * imports a consuming component first: every file configures the same object.
 * Per-file `vi.mock` factories each build their own instance, which leaves the
 * component wired to whichever file loaded it first — invisible under
 * `isolate: true`, order-dependent breakage under `isolate: false`.
 *
 * Implementations are passed to `vi.fn(impl)` rather than set with
 * `.mockReturnValue()`, because `mockReset` restores the former and discards
 * the latter.
 */

import { vi, type Mock } from "vitest";

/**
 * Callbacks captured from `onState`. Shared across files, so tests that push
 * snapshots must clear it in `beforeEach`.
 */
export const stateCallbacks: Array<(state: unknown) => void> = [];

export const emitEvent: Mock = vi.fn();
export const sendDialogEvent: Mock = vi.fn();
export const sendNotificationEvent: Mock = vi.fn();

export const on: Mock = vi.fn(() => vi.fn());

export const onState: Mock = vi.fn((callback: (state: unknown) => void) => {
  stateCallbacks.push(callback);
  return vi.fn();
});
