import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "path";

// Tests run in whatever shell launched them — a CodeHydra workspace terminal
// (GIT_OPTIONAL_LOCKS, `_CH_*` plumbing, `CH_*` config overrides), a Claude
// session (`CLAUDE_CODE_*`), pnpm (`npm_*`). An allowlist, not a denylist: a
// test sees what the OS and the tools it spawns need, plus what it sets up
// itself, and a new kind of leak cannot slip in unnoticed. Runs before any
// worker is forked. Names compare case-insensitively (Windows env is).
const ALLOWED_ENV = new Set(
  [
    // Processes and tools (git, node, the real claude/opencode binaries)
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TZ",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    // Windows system
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "OS",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "PSMODULEPATH",
    // Without it, a runner image's PowerShell rebuilds its module cache on
    // every start (~24s), and the blocking-process scan times out.
    "PSMODULEANALYSISCACHEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    // Network: proxies and corporate CAs
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    // Test runner and CI (timeouts widen under CI)
    "CI",
    "NODE_ENV",
    "TEST",
    "FORCE_COLOR",
    "NO_COLOR",
  ].map((name) => name.toUpperCase())
);
for (const key of Object.keys(process.env)) {
  const name = key.toUpperCase();
  if (ALLOWED_ENV.has(name) || name.startsWith("LC_") || name.startsWith("VITEST")) continue;
  delete process.env[key];
}

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  // Externalize socket.io ecosystem for proper ESM/CJS interop in Node tests
  // Fixes "this.opts.wsEngine is not a constructor" error in boundary tests
  ssr: {
    external: ["socket.io", "socket.io-client", "engine.io", "engine.io-client", "ws"],
  },
  test: {
    globals: true,
    // Test files in a worker share one module registry, so each module is
    // evaluated once. A per-file `vi.mock(id, factory)` builds a fresh mock the
    // already-cached consumer never sees, so mocked modules are shared fakes
    // under `__mocks__/` that every file mocks with a bare `vi.mock(id)`.
    // `pnpm test:canary` forces one registry per project to catch regressions.
    isolate: false,
    restoreMocks: true,
    clearMocks: true,
    // Required by the shared `__mocks__` fakes: without it a `.mockReturnValue()`
    // set by one test file survives into the next, because the fake is a single
    // instance shared across every file in the worker.
    mockReset: true,
    // On CI, also a JSON report (uploaded as an artifact): per-file and per-test
    // durations, which the dot reporter never prints.
    reporters: process.env.CI
      ? ["dot", ["json", { outputFile: "test-results/vitest.json" }]]
      : ["dot"],

    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/renderer/**/*.ts", "src/renderer/**/*.svelte"],
      exclude: ["**/*.test.ts", "**/test-*.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
    // Split test environments using projects configuration (vitest 4.x)
    projects: [
      {
        // Renderer tests: happy-dom environment with vscode-elements setup
        // Note: setup-matchers.ts excluded - it imports Node.js-only code (filesystem.state-mock)
        extends: true,
        test: {
          name: "renderer",
          environment: "happy-dom",
          include: ["src/renderer/**/*.{test,spec}.{js,ts}"],
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-renderer.ts"],
        },
      },
      {
        // Node tests: main process and services (excludes boundary tests)
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Everything under src/ that the renderer and boundary projects
          // don't claim. Enumerating directories here silently drops tests
          // whenever the tree is reorganized.
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["**/*.boundary.test.{js,ts}", "src/renderer/**"],
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-matchers.ts"],
          // Use forks pool for better ESM/CJS interop with native modules like ws/socket.io
          pool: "forks",
        },
      },
      {
        // Boundary tests: test layer implementations against real external systems
        extends: true,
        test: {
          name: "boundary",
          environment: "node",
          include: ["src/**/*.boundary.test.{js,ts}"],
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-matchers.ts"],
          // Compiles the fake claude binary once per run; on Windows the pkg
          // download/compile is too slow for a 10s test hook (see the file).
          globalSetup: ["./src/test/global-setup-boundary.ts"],
          pool: "forks",
        },
      },
      {
        // Extension tests: VS Code extensions (mocked vscode module)
        extends: true,
        test: {
          name: "extensions",
          environment: "node",
          include: ["extensions/**/*.{test,spec}.{js,ts}"],
          exclude: [
            "extensions/**/e2e/**",
            "extensions/**/*.e2e.{test,spec}.{js,ts}",
            "extensions/**/example.spec.ts",
          ],
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-matchers.ts"],
          pool: "forks",
        },
        resolve: {
          alias: {
            $lib: resolve("./extensions/markdown-review-editor/src/lib"),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      $lib: resolve("./src/renderer/lib"),
      "@shared": resolve("./src/shared"),
    },
  },
});
