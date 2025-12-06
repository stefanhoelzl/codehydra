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
  },
  resolve: {
    alias: {
      $lib: resolve("./src/renderer/lib"),
    },
  },
});
