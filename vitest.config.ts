import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.{js,ts}"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    isolate: true,
    restoreMocks: true,
    clearMocks: true,
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
  },
  resolve: {
    alias: {
      $lib: resolve("./src/renderer/lib"),
      "@shared": resolve("./src/shared"),
    },
  },
});
