import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";
import { readFileSync } from "fs";
import { codehydraDefaults } from "../vite.defaults";
import { renderMarkdown } from "../src/shared/markdown";

const USER_GUIDE = resolve(__dirname, "../docs/USER_GUIDE.md");
const PLACEHOLDER = "<!--user-guide-->";

/**
 * Render docs/USER_GUIDE.md into docs.html's placeholder.
 *
 * The guide is the one source for this page, `ch guide` and the in-app help
 * dialog, so the page carries no hand-written copy of it. Rendered at build
 * time: the page is static HTML, and the markdown is ours, so it needs no
 * sanitizing. The dev server reloads when the guide changes.
 */
function userGuide(): Plugin {
  return {
    name: "codehydra-user-guide",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes(PLACEHOLDER)) return html;
        return html.replace(PLACEHOLDER, () => renderMarkdown(readFileSync(USER_GUIDE, "utf-8")));
      },
    },
    configureServer(server) {
      server.watcher.add(USER_GUIDE);
      server.watcher.on("change", (file) => {
        if (resolve(file) === USER_GUIDE) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

export default defineConfig({
  plugins: [codehydraDefaults({ minify: true, sourcemap: true }), svelte(), userGuide()],
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
