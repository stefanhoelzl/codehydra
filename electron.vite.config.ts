import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";
import { execSync } from "node:child_process";
import { codehydraDefaults } from "./vite.defaults";

/**
 * Gets the application version.
 *
 * In release builds (VERSION env var set), uses that version directly.
 * In dev builds, generates a version from git: {commit-date}-dev.{short-hash}[-dirty]
 *
 * @returns Version string like "2026.01.15" (release) or "2026.01.15-dev.a1b2c3d4" (dev)
 */
function getAppVersion(): string {
  if (process.env.VERSION) return process.env.VERSION;

  // Git commands will fail if not in a git repo - this is intentional
  // to catch misconfigured dev environments early
  const date = execSync("git log -1 --format=%cs", { encoding: "utf-8" }).trim().replace(/-/g, ".");
  const hash = execSync("git rev-parse --short=8 HEAD", { encoding: "utf-8" }).trim();
  const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim() ? "-dirty" : "";

  return `${date}-dev.${hash}${dirty}`;
}

const appVersion = getAppVersion();

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [
      // bufferutil and utf-8-validate are optional native deps for ws (used by socket.io)
      codehydraDefaults({ external: ["bufferutil", "utf-8-validate"] }),
      viteStaticCopy({
        targets: [
          { src: "dist/extensions/*", dest: "assets" },
          { src: "resources/scripts/*", dest: "assets/scripts" },
          { src: "resources/bin/*", dest: "assets/bin" },
          { src: "dist/bin/*", dest: "assets/bin" },
        ],
      }),
    ],
  },
  preload: {
    plugins: [codehydraDefaults()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [codehydraDefaults(), svelte()],
    resolve: {
      alias: {
        $lib: resolve(__dirname, "src/renderer/lib"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
});
