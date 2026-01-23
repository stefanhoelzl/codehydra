import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";
import { codehydraDefaults } from "../vite.defaults";

export default defineConfig({
  plugins: [codehydraDefaults({ minify: true, sourcemap: true }), svelte()],
  root: resolve(__dirname),
  base: "./", // Relative paths work for custom domain, GitHub Pages subdirectory, and dev server
  build: {
    outDir: "dist",
    emptyOutDir: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        docs: resolve(__dirname, "docs.html"),
      },
    },
  },
});
