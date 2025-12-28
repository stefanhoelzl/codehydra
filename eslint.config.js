import js from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { includeIgnoreFile } from "@eslint/compat";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default tseslint.config(
  includeIgnoreFile(gitignorePath),
  // Ignore VS Code extensions node_modules and dist, but lint source
  { ignores: ["extensions/**/node_modules/", "extensions/**/dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // VS Code extensions - allow underscore-prefixed unused vars (interface implementations)
  {
    files: ["extensions/**/*.ts", "extensions/**/*.svelte"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Test utilities - allow underscore-prefixed unused vars (mock interface implementations)
  {
    files: ["**/*.test-utils.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // State mocks - allow empty object types for conditional interface extension
  // and unused type parameters in vitest module augmentation
  {
    files: ["**/state-mock.ts", "**/*.state-mock.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends", allowObjectTypes: "always" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_|^T$" },
      ],
    },
  },
  // markdown-review-editor CommentEditor.svelte - specific overrides
  {
    files: ["extensions/markdown-review-editor/src/lib/components/CommentEditor.svelte"],
    rules: {
      // @html is used intentionally for rendering trusted markdown content from user's own files
      "svelte/no-at-html-tags": "off",
      // $state + $effect pattern is valid for controlled inputs (requires Svelte 5.25+ for writable derived)
      "svelte/prefer-writable-derived": "off",
    },
  }
);
