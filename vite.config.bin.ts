/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles agent wrapper scripts to out/main/agents/ as self-contained CJS bundles:
 * - src/agents/opencode/wrapper.ts -> opencode-wrapper.cjs
 * - src/agents/claude/wrapper.ts -> claude-wrapper.cjs
 * - src/agents/claude/hook-handler.ts -> hook-handler.cjs
 *
 * Also copies compiled wrappers to ./dist/bin/ for production packaging.
 * Runtime copying to app-data/bin/ is handled by VscodeSetupService.setupBinDirectory().
 */

import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { codehydraDefaults } from "./vite.defaults";

export default defineConfig({
  plugins: [
    codehydraDefaults({ nodeBuiltins: true }),
    // Copy compiled wrappers to dist/bin after build completes
    viteStaticCopy({
      targets: [
        {
          src: "out/main/agents/opencode-wrapper.cjs",
          dest: "../../../dist/bin",
          rename: "opencode.cjs",
        },
        {
          src: "out/main/agents/claude-wrapper.cjs",
          dest: "../../../dist/bin",
          rename: "claude.cjs",
        },
        {
          src: "out/main/agents/hook-handler.cjs",
          dest: "../../../dist/bin",
          rename: "claude-code-hook-handler.cjs",
        },
      ],
      hook: "closeBundle",
    }),
  ],
  build: {
    lib: {
      entry: {
        "opencode-wrapper": resolve(__dirname, "src/agents/opencode/wrapper.ts"),
        "claude-wrapper": resolve(__dirname, "src/agents/claude/wrapper.ts"),
        "hook-handler": resolve(__dirname, "src/agents/claude/hook-handler.ts"),
      },
      formats: ["cjs"],
      fileName: (_, entryName) => `${entryName}.cjs`,
    },
    outDir: "out/main/agents",
    // Clear out/main/agents on each build
    emptyOutDir: true,
    // Don't report gzip sizes (not relevant for CLI scripts)
    reportCompressedSize: false,
  },
});
