/**
 * Shared Vite defaults for consistent build behavior across all configs.
 *
 * Features:
 * - Fails build on Rollup warnings (always enabled)
 * - Configurable Node.js built-ins externalization
 * - Sensible defaults for minify/sourcemap
 *
 * Usage:
 *   import { codehydraDefaults } from "./vite.defaults";
 *   export default defineConfig({
 *     plugins: [codehydraDefaults({ nodeBuiltins: true })],
 *   });
 */

import { builtinModules } from "node:module";

/**
 * Minimal Vite plugin interface compatible with multiple Vite versions.
 * Using a minimal interface avoids type conflicts between vite 6 and vite 7
 * in the monorepo (root uses vite 7, some extensions use vite 6).
 */
interface VitePluginCompat {
  name: string;
  config?: () => Record<string, unknown>;
}

export interface CodehydraDefaultsOptions {
  /**
   * Include Node.js built-in modules in rollupOptions.external.
   * Includes both bare (fs) and prefixed (node:fs) forms.
   * @default false
   */
  nodeBuiltins?: boolean;

  /**
   * Additional modules to externalize.
   * Merged with nodeBuiltins if enabled.
   */
  external?: string[];

  /**
   * Enable minification.
   * @default false
   */
  minify?: boolean;

  /**
   * Enable sourcemaps.
   * @default false
   */
  sourcemap?: boolean;
}

const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * Shared Vite plugin for consistent build behavior across all configs.
 *
 * Always fails build on Rollup warnings to catch issues early.
 */
export function codehydraDefaults(options: CodehydraDefaultsOptions = {}): VitePluginCompat {
  const {
    nodeBuiltins: includeNodeBuiltins = false,
    external = [],
    minify = false,
    sourcemap = false,
  } = options;

  const externalModules = [...external, ...(includeNodeBuiltins ? nodeBuiltins : [])];

  return {
    name: "codehydra-defaults",
    config() {
      return {
        build: {
          minify,
          sourcemap,
          rollupOptions: {
            ...(externalModules.length > 0 && { external: externalModules }),
            onLog(
              level: string,
              log: { message?: string; code?: string },
              handler: (level: string, log: { message?: string }) => void
            ) {
              if (level === "warn") {
                // Allow circular dependency warnings from node_modules (e.g., Svelte internals)
                if (log.code === "CIRCULAR_DEPENDENCY" && log.message?.includes("node_modules")) {
                  return;
                }
                throw new Error(`Rollup warning: ${log.message}`);
              }
              handler(level, log);
            },
          },
        },
      };
    },
  };
}

/**
 * Create Svelte onwarn handler with configurable a11y behavior.
 *
 * Usage:
 *   svelte({ onwarn: createSvelteOnWarn({ allowA11y: true }) })
 */
export function createSvelteOnWarn(options: { allowA11y?: boolean } = {}) {
  const { allowA11y = false } = options;

  return (warning: { code?: string; message: string }) => {
    if (allowA11y && warning.code?.startsWith("a11y_")) {
      return;
    }
    throw new Error(`Svelte warning: ${warning.message}`);
  };
}
