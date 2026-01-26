import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";
import { codehydraDefaults } from "./vite.defaults";

const appVersion = process.env.CODEHYDRA_VERSION ?? "0.0.0-dev";

// PostHog configuration - injected at build time from environment variables
// API key is stored in GitHub secrets and passed via CI, or in .env.local for local dev
const posthogApiKey = process.env.POSTHOG_API_KEY;
const posthogHost = process.env.POSTHOG_HOST ?? "https://eu.posthog.com";

// Auto-update configuration - injected at build time
const updateProvider = process.env.CODEHYDRA_UPDATE_PROVIDER;
const updateOwner = process.env.CODEHYDRA_UPDATE_OWNER;
const updateRepo = process.env.CODEHYDRA_UPDATE_REPO;

export default defineConfig({
  main: {
    build: {
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      // PostHog constants - undefined if not configured (telemetry disabled)
      __POSTHOG_API_KEY__: posthogApiKey ? JSON.stringify(posthogApiKey) : "undefined",
      __POSTHOG_HOST__: JSON.stringify(posthogHost),
      // Auto-update constants - undefined if not configured (updates disabled)
      __UPDATE_PROVIDER__: updateProvider ? JSON.stringify(updateProvider) : "undefined",
      __UPDATE_OWNER__: updateOwner ? JSON.stringify(updateOwner) : "undefined",
      __UPDATE_REPO__: updateRepo ? JSON.stringify(updateRepo) : "undefined",
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
