/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles src/agents/opencode/wrapper.ts to out/main/agents/opencode-wrapper.cjs
 * as a self-contained CJS bundle.
 *
 * Also copies wrapper scripts to ./app-data/bin/ (development) and ./dist/bin/ (production).
 */

import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { codehydraDefaults } from "./vite.defaults";

export default defineConfig({
  plugins: [
    codehydraDefaults({ nodeBuiltins: true }),
    // Copy shell scripts from resources/bin/ (these exist before build)
    viteStaticCopy({
      targets: [
        {
          src: "resources/bin/*",
          dest: "../app-data/bin",
        },
      ],
    }),
    // Copy compiled wrapper and set permissions after build completes
    {
      name: "copy-wrapper-scripts",
      closeBundle: async () => {
        const wrapperSrc = resolve(__dirname, "out/main/agents/opencode-wrapper.cjs");
        const appDataBin = resolve(__dirname, "app-data/bin");
        const distBin = resolve(__dirname, "dist/bin");

        // Ensure directories exist
        await mkdir(appDataBin, { recursive: true });
        await mkdir(distBin, { recursive: true });

        // Copy wrapper to both locations
        await copyFile(wrapperSrc, resolve(appDataBin, "opencode.cjs"));
        await copyFile(wrapperSrc, resolve(distBin, "opencode.cjs"));

        // Make shell scripts executable
        const scripts = ["code", "opencode"];
        for (const script of scripts) {
          try {
            await chmod(resolve(appDataBin, script), 0o755);
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
