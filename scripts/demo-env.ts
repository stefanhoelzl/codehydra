/**
 * Environment prep for `record-demo`, split into its own module so it can be
 * imported for its SIDE EFFECT ahead of the e2e fixtures.
 *
 * `e2e/env.ts` reads `_CH_ROOT_DIR` at module-eval time, so the variable has to
 * be set before that module is evaluated. ESM evaluates a module graph in import
 * order, so importing this file first is what lets record-demo.ts use plain
 * top-level imports for the fixtures instead of deferred dynamic ones.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/** X display the recording drives — a private Xvfb, never the user's session. */
export const DISPLAY = process.env.CH_DEMO_DISPLAY ?? ":99";

/** Isolated app data root — never the user's real one. */
export const APP_ROOT = process.env.CH_DEMO_ROOT ?? join(tmpdir(), "codehydra-demo-record");

/** Isolated Claude config dir (relocates .claude.json AND .credentials.json). */
export const CLAUDE_CONFIG_DIR = join(APP_ROOT, "claude-config");

// Strip WAYLAND_DISPLAY: with it set, Electron's Ozone takes the Wayland socket
// and ignores Xvfb entirely — the X grab then captures a black frame while the
// app renders fine off-screen. Point everything at our Xvfb and isolated config.
delete process.env.WAYLAND_DISPLAY;
delete process.env.XDG_SESSION_TYPE;

// Suppress Claude Code's project-onboarding panel, which is what prints
// "Welcome back <name>!" and "<email>'s Organization" over the first screen of a
// session. It renders whenever a project's onboarding steps are incomplete — and
// one of those steps is "create a CLAUDE.md", so every freshly scaffolded repo
// qualifies. `IS_DEMO` is Claude Code's own opt-out for exactly this case
// (agent-module/claude bundle: `HRo()` short-circuits on `process.env.IS_DEMO`).
process.env.IS_DEMO = "1";
process.env.DISPLAY = DISPLAY;
process.env._CH_ROOT_DIR = APP_ROOT;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
