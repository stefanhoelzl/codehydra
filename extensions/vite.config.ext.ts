import { defineConfig, type UserConfig } from "vite";
import { codehydraDefaults } from "../vite.defaults";

/**
 * Base Vite configuration for VS Code extensions.
 * Individual extensions should merge this with their own config to provide the entry point.
 *
 * Note: Node.js built-in modules (path, fs, etc.) MUST be externalized because
 * VS Code extensions run in Node.js, not the browser. Without this, Vite replaces
 * them with browser stubs that throw errors at runtime.
 *
 * Extensions that use packages with conditional exports (like socket.io-client) may need
 * additional SSR settings - see sidekick/vite.config.ts for an example.
 */
const baseConfig: UserConfig = {
  plugins: [codehydraDefaults({ nodeBuiltins: true, external: ["vscode"] })],
  build: {
    lib: {
      entry: "", // Must be overridden by each extension
      formats: ["cjs"],
      fileName: () => "extension.cjs",
    },
    emptyOutDir: true,
  },
};

export default defineConfig(baseConfig);
