/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles src/bin/opencode-wrapper.ts to dist/bin/opencode.cjs
 * as a self-contained CJS bundle.
 */

import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/bin/opencode-wrapper.ts"),
      formats: ["cjs"],
      fileName: () => "opencode.cjs",
    },
    outDir: "dist/bin",
    rollupOptions: {
      // Externalize all Node.js built-in modules
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
    // Don't minify - makes debugging easier
    minify: false,
    // No sourcemaps for CLI scripts
    sourcemap: false,
    // Clear dist/bin on each build
    emptyOutDir: true,
  },
});
