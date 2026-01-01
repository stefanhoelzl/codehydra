import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  // Externalize socket.io ecosystem for proper ESM/CJS interop in Node tests
  // Fixes "this.opts.wsEngine is not a constructor" error in boundary tests
  ssr: {
    external: ["socket.io", "socket.io-client", "engine.io", "engine.io-client", "ws"],
  },
  test: {
    globals: true,
    isolate: true,
    restoreMocks: true,
    clearMocks: true,
    reporters: ["dot"],

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
          include: [
            "src/main/**/*.{test,spec}.{js,ts}",
            "src/services/**/*.{test,spec}.{js,ts}",
            "src/shared/**/*.{test,spec}.{js,ts}",
            "src/preload/**/*.{test,spec}.{js,ts}",
          ],
          exclude: ["**/*.boundary.test.{js,ts}"],
          setupFiles: ["./src/test/setup.ts"],
          // Use forks pool for better ESM/CJS interop with native modules like ws/socket.io
          pool: "forks",
        },
      },
      {
        // Boundary tests: test layer implementations against real external systems
        // Uses xvfb globalSetup for Electron tests on Linux CI
        extends: true,
        test: {
          name: "boundary",
          environment: "node",
          include: [
            "src/main/**/*.boundary.test.{js,ts}",
            "src/services/**/*.boundary.test.{js,ts}",
          ],
          setupFiles: ["./src/test/setup.ts"],
          globalSetup: ["./src/test/setup-display.ts"],
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
          setupFiles: ["./src/test/setup.ts"],
          pool: "forks",
        },
      },
    ],
  },
  resolve: {
    alias: {
      $lib: resolve("./src/renderer/lib"),
      "@shared": resolve("./src/shared"),
      "@services": resolve("./src/services"),
    },
  },
});
