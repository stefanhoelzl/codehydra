/**
 * e2e against the unpackaged dev build (`out/main/index.cjs`), for iterating on
 * selectors without paying `pnpm dist` on every change.
 *
 * The assignment runs after the static import above it, which is fine: `MODE` is read
 * lazily, when the app is launched, not when the config module is evaluated. This file
 * is re-evaluated in every Playwright worker, so the variable is set there too.
 */
import base from "./playwright.config";

process.env.CH_E2E_MODE = "dev";

export default base;
