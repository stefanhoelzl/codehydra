import { defineConfig, mergeConfig } from "vite";
import baseConfig from "../vite.config.ext";

/**
 * Sidekick extension Vite config.
 *
 * Uses SSR mode because socket.io-client has conditional exports that resolve differently
 * for browser vs Node.js. Without SSR mode:
 * - Vite uses browser field remapping (package.json "browser" field)
 * - engine.io-client substitutes websocket.node.js → websocket.js (uses native WebSocket)
 * - Native WebSocket is unavailable in Node.js → runtime error
 *
 * SSR mode tells Vite to:
 * 1. Use Node.js module resolution (no browser field remapping)
 * 2. Resolve conditional exports with "node" condition
 * 3. Bundle dependencies that would otherwise be externalized
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      // Prefer Node.js exports over browser exports
      conditions: ["node"],
    },
    ssr: {
      // Bundle all dependencies (except our explicit externals)
      noExternal: true,
    },
    build: {
      // Enable SSR build mode
      ssr: true,
      lib: {
        entry: "src/extension.ts",
      },
      outDir: "dist",
      rollupOptions: {
        external: [
          // Optional native modules for socket.io (not required but avoids warnings)
          "bufferutil",
          "utf-8-validate",
        ],
      },
    },
  })
);
