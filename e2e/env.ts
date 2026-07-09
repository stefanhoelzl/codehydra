/**
 * Roots, executable resolution, and the reset helpers for the e2e suite.
 *
 * `_CH_ROOT_DIR` relocates the app's data root *and* its bundles root together, in
 * every build flavor (path-provider.ts). So the suite has exactly one root to reason
 * about, and neither `~/.local/share/codehydra` nor the repo's `./app-data` is ever
 * touched — which matters, because "packaged" does not imply "production": a build's
 * `isDevelopment` comes from `_CH_BUILD_RELEASE` at build time, and CI's PR artifacts
 * are dev-flavored.
 *
 * The one `rm -rf` here refuses to run unless the root is under the OS temp dir. Left
 * unset, the app would resolve it to the directory holding every real CodeHydra
 * project, so a mistyped value must fail loudly rather than delete a home directory.
 */
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createServer } from "node:net";

export const REPO_ROOT = join(import.meta.dirname, "..");

export type Mode = "packaged" | "dev";
export type Agent = "opencode" | "claude";

/**
 * Read lazily, not at import time: `playwright.dev.config.ts` sets CH_E2E_MODE *after*
 * its static import of the base config, and static imports hoist.
 */
export function mode(): Mode {
  return process.env.CH_E2E_MODE === "dev" ? "dev" : "packaged";
}

/**
 * Deterministic so every Playwright worker and project resolves the same root:
 * `cold-start` seeds it, the warm projects reuse it. Overridable, but the guard
 * below still applies to whatever is set.
 */
export const ROOT_DIR =
  // `||`, not `??`: an empty string means "unset" here, as it does everywhere else.
  process.env._CH_ROOT_DIR || join(realpathSync(tmpdir()), "codehydra-e2e");

/** One root: the app puts config.json, projects/, and the binary bundles all here. */
export const DATA_ROOT = ROOT_DIR;

/**
 * Compare paths the way the filesystem does, not the way they were typed. `resolve()`
 * normalizes separators — `D:\a\_temp/ch-e2e` and `D:\a\_temp\ch-e2e` are the same
 * directory, but only one of them startsWith(`D:\a\_temp` + sep). Windows is also
 * case-insensitive.
 */
function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Disposable roots: under the OS temp dir, or under `RUNNER_TEMP`. GitHub's runner temp
 * is not inside `os.tmpdir()` on Linux (`/home/runner/work/_temp` vs `/tmp`), so CI needs
 * the second prefix.
 */
function disposableRoots(): string[] {
  const roots = [realpathSync(tmpdir())];
  const runnerTemp = process.env.RUNNER_TEMP;
  if (runnerTemp && existsSync(runnerTemp)) roots.push(realpathSync(runnerTemp));
  return roots.map(normalizePath);
}

/** Refuse to delete anything outside a disposable root. */
function assertDisposable(path: string): void {
  if (!path || !isAbsolute(path)) {
    throw new Error(`_CH_ROOT_DIR must be an absolute path, got: ${JSON.stringify(path)}`);
  }
  const target = normalizePath(existsSync(path) ? realpathSync(path) : path);
  const allowed = disposableRoots();
  const ok = allowed.some((root) => target === root || target.startsWith(root + sep));
  if (!ok) {
    throw new Error(
      `refusing to rm -rf a path outside ${allowed.join(" or ")}: ${target}\n` +
        `unset, _CH_ROOT_DIR resolves to your real CodeHydra data directory — use a temp path.`
    );
  }
}

/** Full wipe of the root. Cold start only. Guarded. */
export function resetRoot(): void {
  assertDisposable(ROOT_DIR);
  rmSync(ROOT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(ROOT_DIR, { recursive: true });
}

/**
 * Wipe the app's mutable state without touching bundles or installed extensions.
 * Safe by construction — it deletes named children, never the root itself.
 *
 * `keepConfig: true` preserves the agent choice, so warm specs skip the wizard.
 */
export function resetDataState(options: { keepConfig: boolean }): void {
  const entries = ["projects", "state.json", join("vscode", "user-data")];
  if (!options.keepConfig) entries.push("config.json");

  for (const entry of entries) {
    rmSync(join(DATA_ROOT, entry), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

/** The packaged binary under test. `CH_E2E_EXE` wins; otherwise infer from dist/. */
export function packagedExecutable(): string {
  const override = process.env.CH_E2E_EXE;
  if (override) return override;

  const dist = join(REPO_ROOT, "dist");
  const candidates: Record<string, string> = {
    // Extract the AppImage first (`--appimage-extract`); ubuntu runners have no libfuse2.
    //
    // Launch the inner binary, NOT AppRun. AppRun derives APPDIR by walking up from its
    // own location looking for a path that contains `$1` — and `$1` here is Playwright's
    // `--inspect=0`. The search fails, APPDIR ends up empty, and AppRun exec's whatever
    // `codehydra` it finds on PATH: a system-installed CodeHydra, silently, instead of the
    // build under test. Electron bundles its own libs, so skipping AppRun costs nothing.
    linux: join(dist, "squashfs-root", "codehydra"),
    win32: join(dist, "win-unpacked", "CodeHydra.exe"),
    darwin: join(
      dist,
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "CodeHydra.app",
      "Contents",
      "MacOS",
      "CodeHydra"
    ),
  };

  const exe = candidates[process.platform];
  if (!exe) throw new Error(`No packaged build layout known for platform ${process.platform}`);
  if (!existsSync(exe)) {
    throw new Error(
      `No packaged build at ${exe}\n` +
        `Run \`pnpm dist:${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}\` first ` +
        `(Linux: then \`cd dist && ./CodeHydra-linux-x64.AppImage --appimage-extract\`),\n` +
        `or set CH_E2E_EXE to a binary, or run \`pnpm test:e2e:dev\` against the dev build.`
    );
  }
  return exe;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
