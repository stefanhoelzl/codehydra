import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
        },
        // bufferutil and utf-8-validate are optional native deps for ws (used by socket.io)
        external: ["bufferutil", "utf-8-validate"],
      },
    },
    plugins: [
      viteStaticCopy({
        targets: [
          { src: "src/services/vscode-setup/assets/extensions.json", dest: "assets" },
          { src: "src/services/vscode-setup/assets/*.vsix", dest: "assets" },
        ],
      }),
    ],
  },
  preload: {
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
    plugins: [svelte()],
    resolve: {
      alias: {
        $lib: resolve(__dirname, "src/renderer/lib"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
});
