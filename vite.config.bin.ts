/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles src/agents/opencode/wrapper.ts to out/main/agents/opencode-wrapper.cjs
 * as a self-contained CJS bundle.
 *
 * Also copies wrapper scripts to ./app-data/bin/ for development use.
 */

import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { chmod } from "node:fs/promises";
import { codehydraDefaults } from "./vite.defaults";

export default defineConfig({
  plugins: [
    codehydraDefaults({ nodeBuiltins: true }),
    // Copy wrapper scripts to app-data/bin/ for development
    viteStaticCopy({
      targets: [
        // Shell scripts from resources/bin/
        {
          src: "resources/bin/*",
          dest: "../app-data/bin",
        },
        // Compiled opencode.cjs (built to out/main/agents/)
        {
          src: "out/main/agents/opencode-wrapper.cjs",
          dest: "../app-data/bin",
          rename: "opencode.cjs",
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
      entry: resolve(__dirname, "src/agents/opencode/wrapper.ts"),
      formats: ["cjs"],
      fileName: () => "opencode-wrapper.cjs",
    },
    outDir: "out/main/agents",
    // Clear out/main/agents on each build
    emptyOutDir: true,
    // Don't report gzip sizes (not relevant for CLI scripts)
    reportCompressedSize: false,
  },
});
