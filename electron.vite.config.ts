import { defineConfig } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";
import { codehydraDefaults } from "./vite.defaults";

const appVersion = process.env.CODEHYDRA_VERSION ?? "0.0.0-dev";

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
