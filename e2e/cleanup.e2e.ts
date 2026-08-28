/**
 * Startup cleanup: the app sweeps its own data root of things nothing uses.
 *
 * The value this spec adds over `cleanup-module.integration.test.ts` is that it
 * runs against the *real* data root, so it proves what a mock cannot:
 *
 * - The `keepRecent` rule's name ordering matches the filenames electron-log
 *   actually produces. The integration test asserts against invented names, so
 *   a change to `generateSessionFilename()` would sail past it and quietly turn
 *   every session log into an "unrecognized" entry ranked oldest — which is to
 *   say, into something cleanup deletes first.
 * - The module is registered and its hook actually fires in a packaged app.
 *
 * The `bundle` rules are deliberately not asserted. They are gated on
 * `buildInfo.isDevelopment`, which comes from `_CH_BUILD_RELEASE` at build time,
 * and CI's packaged artifacts are dev-flavored (see env.ts) — so either outcome
 * would be correct here and the assertion would only encode which artifact
 * happened to run.
 */
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, resetDataState, type Agent } from "./env";
import { launchApp, useApp } from "./fixtures";

/** Matches the sweep's own limit: `{ kind: "keepRecent", path: "logs", keep: 20 }`. */
const LOG_KEEP = 20;

/** More than the limit, so the cut is guaranteed to bite whatever else is there. */
const SEEDED_LOGS = 25;

/** `cold: true` only means "don't launch for me" — this spec has to seed first. */
const app = useApp({ cold: true });

function seedStaleData(): void {
  // A retired tree: the IDE server we shipped before VSCodium.
  mkdirSync(join(DATA_ROOT, "code-server", "4.127.0", "lib"), { recursive: true });
  writeFileSync(join(DATA_ROOT, "code-server", "4.127.0", "lib", "node"), "stale binary");

  // Agent hook/MCP configs from before they moved under the temp root.
  mkdirSync(join(DATA_ROOT, "claude", "configs", "feature-a-1a2b3c"), { recursive: true });
  writeFileSync(
    join(DATA_ROOT, "claude", "configs", "feature-a-1a2b3c", "codehydra-hooks.json"),
    "{}"
  );

  // A screenshot directory whose project is gone, next to one that is still live.
  mkdirSync(join(DATA_ROOT, "screenshots", "ghost-project-deadbeef"), { recursive: true });
  mkdirSync(join(DATA_ROOT, "screenshots", "live-project-cafe1234"), { recursive: true });
  writeFileSync(join(DATA_ROOT, "screenshots", "live-project-cafe1234", "feature.png"), "png");

  // Session logs from a long time ago: dated 2020, so every real log outranks
  // them and they are what the cut reaches first.
  const logsDir = join(DATA_ROOT, "logs");
  mkdirSync(logsDir, { recursive: true });
  for (let i = 0; i < SEEDED_LOGS; i++) {
    const index = String(i).padStart(2, "0");
    // Plain text, not JSONL: the log-reading fixtures skip unparsable lines, so
    // these cannot be mistaken for something this run logged.
    writeFileSync(join(logsDir, `2020-01-01T00-00-${index}-seeded.log`), "seeded\n");
  }
}

function logFiles(): string[] {
  const logsDir = join(DATA_ROOT, "logs");
  return existsSync(logsDir) ? readdirSync(logsDir) : [];
}

test.beforeAll(async () => {
  // Warm start, same as every other warm spec: keep config.json, bundles, VSIXes.
  resetDataState({ keepConfig: true });
  seedStaleData();

  // Seeded *before* launch, so the app sees it the way a real upgrade would.
  expect(existsSync(join(DATA_ROOT, "code-server"))).toBe(true);
  expect(logFiles().length).toBeGreaterThanOrEqual(SEEDED_LOGS);

  await launchApp(app(), { agent: test.info().project.name as Agent });
});

test("retires directories and files nothing uses any more", async () => {
  // The sweep is fire-and-forget, so poll rather than assume it finished by the
  // time the UI came up — not blocking startup is the point of the design.
  await expect
    .poll(() => existsSync(join(DATA_ROOT, "code-server")), { timeout: 30_000 })
    .toBe(false);

  await expect
    .poll(() => existsSync(join(DATA_ROOT, "claude", "configs")), { timeout: 30_000 })
    .toBe(false);
});

test("prunes screenshot directories whose project is gone, and keeps the rest", async () => {
  await expect
    .poll(() => existsSync(join(DATA_ROOT, "screenshots", "ghost-project-deadbeef")), {
      timeout: 30_000,
    })
    .toBe(false);

  // Over-deleting here would silently drop the previews of every hibernated
  // workspace, which is exactly the failure a sweep must not have.
  expect(existsSync(join(DATA_ROOT, "screenshots", "live-project-cafe1234", "feature.png"))).toBe(
    true
  );
});

test("caps the log directory and keeps this launch's own log", async () => {
  // Exactly the limit: we seeded more than that, and this launch's own file is
  // newer than every seeded one, so the cut lands in a known place.
  await expect.poll(() => logFiles().length, { timeout: 30_000 }).toBe(LOG_KEEP);

  const remaining = logFiles();

  // The oldest seeded log is the first thing past the cut.
  expect(remaining).not.toContain("2020-01-01T00-00-00-seeded.log");

  // The regression this spec exists for: a real session log must still be here.
  // If `generateSessionFilename()` ever stops matching the rule's pattern, every
  // real log ranks "oldest" and this launch's own file is swept along with the
  // seeded ones — leaving nothing to debug the app with.
  const sessionLogs = remaining.filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name) && name !== "");
  expect(
    sessionLogs.some((name) => !name.includes("-seeded.")),
    `no real session log survived the sweep; remaining: ${remaining.join(", ")}`
  ).toBe(true);
});
