/**
 * Playwright global teardown: remove the run's root (see `removeRoot`).
 *
 * A leftover must not fail a run whose tests passed: a straggler process on
 * Windows can still hold a file, and the OS reaps its temp dir eventually.
 */
import { ROOT_DIR, removeRoot } from "./env";

export default async function globalTeardown(): Promise<void> {
  try {
    await removeRoot();
  } catch (error: unknown) {
    console.warn(`[e2e] could not remove ${ROOT_DIR}: ${String(error)}`);
  }
}
