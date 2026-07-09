/**
 * Shared fake for `electron`, resolved by `vi.mock("electron")`.
 *
 * There is one instance per worker, so it does not matter which test file
 * imports a consuming module (e.g. `electron-build-info.ts`) first: every file
 * configures the same object. Per-file `vi.mock` factories each build their own
 * instance, leaving the consumer wired to whichever file loaded it first —
 * invisible under `isolate: true`, order-dependent breakage under
 * `isolate: false`.
 *
 * Implementations are passed to `vi.fn(impl)` rather than set with
 * `.mockReturnValue()`, because `mockReset` restores the former and discards
 * the latter.
 */

import { vi, type Mock } from "vitest";

/** Mutable `app` state. Tests set these in `beforeEach`; call `resetElectronFake()` to restore. */
export const appState = {
  isPackaged: false,
  appPath: "/mock/app/path",
  version: "1.0.0-test",
};

export const app = {
  get isPackaged(): boolean {
    return appState.isPackaged;
  },
  getAppPath(): string {
    return appState.appPath;
  },
  getVersion(): string {
    return appState.version;
  },
};

export const ipcRenderer: {
  invoke: Mock;
  on: Mock;
  removeListener: Mock;
  send: Mock;
} = {
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
};

export const contextBridge: { exposeInMainWorld: Mock } = {
  exposeInMainWorld: vi.fn(),
};

/** Restore `appState` to its defaults. Shared across files, so tests must reset it. */
export function resetElectronFake(): void {
  appState.isPackaged = false;
  appState.appPath = "/mock/app/path";
  appState.version = "1.0.0-test";
}
