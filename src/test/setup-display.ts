/**
 * Display setup for Electron boundary tests.
 *
 * On Linux CI (where DISPLAY may not be set), this starts a virtual X server
 * using xvfb. This allows Electron boundary tests to run without a physical display.
 *
 * This file is used as a globalSetup in vitest.config.ts for boundary tests only.
 */

import { platform } from "os";

/** Cleanup function returned by xvfb start */
type CleanupFn = () => Promise<void>;

/** xvfb instance type (untyped package) */
interface XvfbInstance {
  start(callback: (err: Error | null) => void): void;
  stop(callback: () => void): void;
}

let cleanup: CleanupFn | null = null;

/**
 * Try to load xvfb package dynamically.
 * Returns null if package is not installed (expected on non-Linux platforms).
 */
async function tryLoadXvfb(): Promise<
  (new (options: { silent: boolean; xvfb_args: string[] }) => XvfbInstance) | null
> {
  try {
    // Use dynamic import with type assertion to handle optional package
    // The package may not be installed on Windows/macOS
    const module = await (Function('return import("xvfb")')() as Promise<{
      default: new (options: { silent: boolean; xvfb_args: string[] }) => XvfbInstance;
    }>);
    return module.default;
  } catch {
    return null;
  }
}

/**
 * Global setup: Start xvfb on Linux if no display is available.
 */
export async function setup(): Promise<void> {
  // Only needed on Linux
  if (platform() !== "linux") {
    return;
  }

  // Skip if DISPLAY is already set
  if (process.env["DISPLAY"]) {
    return;
  }

  // Try to load xvfb package
  const XvfbConstructor = await tryLoadXvfb();
  if (!XvfbConstructor) {
    console.log("[setup-display] xvfb not available, skipping virtual display setup");
    return;
  }

  const xvfb = new XvfbConstructor({
    silent: true,
    xvfb_args: ["-screen", "0", "1024x768x24", "-ac"],
  });

  await new Promise<void>((resolve, reject) => {
    xvfb.start((err: Error | null) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  cleanup = async () => {
    await new Promise<void>((resolve) => {
      xvfb.stop(() => resolve());
    });
  };

  console.log("[setup-display] Started xvfb virtual display");
}

/**
 * Global teardown: Stop xvfb if it was started.
 */
export async function teardown(): Promise<void> {
  if (cleanup) {
    await cleanup();
    cleanup = null;
    console.log("[setup-display] Stopped xvfb virtual display");
  }
}
