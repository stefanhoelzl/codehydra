/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles src/bin/opencode-wrapper.ts to dist/bin/opencode.cjs
 * as a self-contained CJS bundle.
 *
 * Also copies wrapper scripts to ./app-data/bin/ for development use.
 */

import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { chmod } from "node:fs/promises";

export default defineConfig({
  plugins: [
    // Copy wrapper scripts to app-data/bin/ for development
    viteStaticCopy({
      targets: [
        // Shell scripts from resources/bin/
        {
          src: "resources/bin/*",
          dest: "../app-data/bin",
        },
        // Compiled opencode.cjs (built to dist/bin/)
        {
          src: "dist/bin/opencode.cjs",
          dest: "../app-data/bin",
        },
      ],
    }),
    // Make shell scripts executable after copy
    {
      name: "chmod-scripts",
      closeBundle: async () => {
        const binDir = resolve(__dirname, "app-data/bin");
        const scripts = ["code", "opencode"];
        for (const script of scripts) {
          try {
            await chmod(resolve(binDir, script), 0o755);
          } catch {
            // Ignore errors (file might not exist on Windows)
          }
        }
      },
    },
  ],
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
