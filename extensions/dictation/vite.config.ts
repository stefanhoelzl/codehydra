import { defineConfig, mergeConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import baseConfig from "../vite.config.ext";

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      viteStaticCopy({
        targets: [{ src: "src/audio/webview.html", dest: "audio" }],
      }),
      // Build audio-processor.ts as standalone IIFE for AudioWorklet
      {
        name: "build-audio-processor",
        async writeBundle() {
          const { build } = await import("vite");
          await build({
            configFile: false,
            build: {
              lib: {
                entry: "src/audio/audio-processor.ts",
                formats: ["iife"],
                name: "AudioProcessor",
                fileName: () => "audio-processor.js",
              },
              outDir: "dist/audio",
              emptyOutDir: false,
              minify: false,
              sourcemap: false,
            },
          });
        },
      },
    ],
    build: {
      lib: {
        entry: "src/extension.ts",
      },
      outDir: "dist",
    },
  })
);
