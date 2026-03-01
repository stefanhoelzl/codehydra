import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";
import { codehydraDefaults } from "./vite.defaults";

const appVersion = process.env._CH_VERSION ?? "0.0.0-dev";
const isDevBuild = process.env._CH_RELEASE !== "true";

// PostHog configuration - injected at build time from environment variables
// API key is stored in GitHub secrets and passed via CI, or in .env.local for local dev
const posthogApiKey = process.env.POSTHOG_API_KEY;
const posthogHost = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";

export default defineConfig({
  main: {
    build: {
      reportCompressedSize: false,
      // Bundle ESM-only packages that lack CJS exports (require() would fail)
      externalizeDeps: { exclude: ["@opencode-ai/sdk", "execa"] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        output: {
          // Output CJS to avoid ESM/CJS interop issues with externalized deps.
          // Electron 40's Node.js enforces strict ESM resolution (named imports
          // from CJS fail, subpath imports need .js). CJS require() works with
          // both CJS and ESM packages on Node.js 22.x.
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __IS_DEV_BUILD__: JSON.stringify(isDevBuild),
      // PostHog constants - undefined if not configured (telemetry disabled)
      __POSTHOG_API_KEY__: posthogApiKey ? JSON.stringify(posthogApiKey) : "undefined",
      __POSTHOG_HOST__: JSON.stringify(posthogHost),
    },
    plugins: [
      // bufferutil and utf-8-validate are optional native deps for ws (used by socket.io)
      codehydraDefaults({ external: ["bufferutil", "utf-8-validate"] }),
      viteStaticCopy({
        targets: [
          { src: "dist/extensions/*", dest: "assets/extensions" },
          { src: "resources/scripts/*", dest: "assets/scripts" },
          { src: "resources/bin/*", dest: "assets/bin" },
          { src: "dist/bin/*", dest: "assets/bin" },
        ],
        // electron-vite 5 builds the main process as "ssr" environment;
        // vite-plugin-static-copy defaults to "client" and skips otherwise.
        environment: "ssr",
      }),
    ],
  },
  preload: {
    plugins: [codehydraDefaults()],
    build: {
      reportCompressedSize: false,
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
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          background: resolve(__dirname, "src/renderer/background.html"),
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __IS_DEV_BUILD__: JSON.stringify(isDevBuild),
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
