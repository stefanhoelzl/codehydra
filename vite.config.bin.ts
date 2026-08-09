/**
 * Vite config for building CLI wrapper scripts.
 *
 * Compiles agent wrapper scripts to out/main/agents/ as self-contained CJS bundles:
 * - src/modules/agent-module/opencode/wrapper.ts -> opencode-wrapper.cjs
 * - src/modules/agent-module/claude/wrapper.ts -> claude-wrapper.cjs
 * - src/modules/agent-module/claude/hook-handler.ts -> hook-handler.cjs
 *
 * Also copies compiled wrappers to ./dist/bin/ for production packaging, and
 * composes the per-agent system prompts into the same directory.
 * Runtime copying to app-data/bin/ is handled by setupBinDirectory() from bin-setup.ts.
 */

import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { codehydraDefaults } from "./vite.defaults";

/**
 * Compose the per-agent CodeHydra system prompts from resources/prompts/.
 *
 * Every agent gets `shared.md`; an agent whose behavior differs adds its own
 * appendix (Claude's `ch-bg` only works against Claude's background_tasks, so
 * only Claude is told about it). Claude accepts exactly one prompt source —
 * `--append-system-prompt-file` is last-wins and cannot be combined with
 * `--append-system-prompt` — so the agent files are composed here rather than
 * passed as a list at launch.
 *
 * Emitted into dist/bin alongside the compiled wrappers, which the main build
 * copies into assets/bin and electron-builder ships to `bin` in extraResources
 * — outside the ASAR, where the agents can read them. Composing here rather
 * than in the main build is what lets a boundary test assert on the shipped
 * artifacts: CI runs `pnpm build:wrappers` before `pnpm test`, but the main
 * build only after it.
 */
function composeAgentPrompts(): Plugin {
  const AGENTS = [
    { name: "claude", appendix: "claude.md" },
    { name: "opencode", appendix: null },
  ] as const;

  return {
    name: "codehydra-compose-agent-prompts",
    closeBundle() {
      const promptsDir = resolve(__dirname, "resources/prompts");
      const outDir = resolve(__dirname, "dist/bin");
      const shared = readFileSync(resolve(promptsDir, "shared.md"), "utf-8").trimEnd();

      mkdirSync(outDir, { recursive: true });
      for (const agent of AGENTS) {
        const parts = [shared];
        if (agent.appendix) {
          parts.push(readFileSync(resolve(promptsDir, agent.appendix), "utf-8").trimEnd());
        }
        writeFileSync(
          resolve(outDir, `codehydra-prompt-${agent.name}.md`),
          `${parts.join("\n\n")}\n`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    codehydraDefaults({ nodeBuiltins: true }),
    // Copy compiled wrappers to dist/bin after build completes
    viteStaticCopy({
      targets: [
        {
          src: "out/main/agents/opencode-wrapper.cjs",
          dest: "../../../dist/bin",
          rename: "ch-opencode.cjs",
        },
        {
          src: "out/main/agents/claude-wrapper.cjs",
          dest: "../../../dist/bin",
          rename: "ch-claude.cjs",
        },
        {
          src: "out/main/agents/hook-handler.cjs",
          dest: "../../../dist/bin",
          rename: "claude-code-hook-handler.cjs",
        },
      ],
      hook: "closeBundle",
    }),
    composeAgentPrompts(),
  ],
  build: {
    lib: {
      entry: {
        "opencode-wrapper": resolve(__dirname, "src/modules/agent-module/opencode/wrapper.ts"),
        "claude-wrapper": resolve(__dirname, "src/modules/agent-module/claude/wrapper.ts"),
        "hook-handler": resolve(__dirname, "src/modules/agent-module/claude/hook-handler.ts"),
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
