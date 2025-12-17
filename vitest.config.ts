import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
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
        // Node tests: main process and services
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
          setupFiles: ["./src/test/setup.ts"],
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
