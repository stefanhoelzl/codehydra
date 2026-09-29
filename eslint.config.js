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

const NO_INLINE_TYPE_IMPORT = {
  selector: "TSImportType",
  message: "Use a top-level `import type` declaration instead of inline import() type references.",
};

const NO_DYNAMIC_IMPORT = {
  selector: "ImportExpression",
  message: "Use a top-level `import` declaration instead of an inline dynamic import().",
};

// ---------------------------------------------------------------------------
// Intent contract: keep every carrier plain serializable data.
//
// The dispatcher validates six carriers with zod (intent payload, hook input context, hook
// result, provides, event, operation result). Those parse calls ARE the serializability gate
// for a backend that runs out of process — but only if no schema opts out of validating:
//
//   z.instanceof(Path)  does not merely permit a class instance, it *requires* one.
//   z.custom<T>()       with no validator function performs no validation at all
//                       (`z.custom().parse({ fn: () => {} })` passes) — an `as T` in a costume.
//
// A branded string (`z.string().brand<"WorkspacePath">()`) rejects a class instance, so with
// the escapes closed the existing parses do the work and no new runtime machinery is needed.
// ---------------------------------------------------------------------------

const NO_ZOD_INSTANCEOF = {
  selector: "CallExpression[callee.object.name='z'][callee.property.name='instanceof']",
  message:
    "z.instanceof() requires a class instance, which cannot cross a backend tunnel. Model the value as plain data (e.g. a branded path string, or `serializedErrorSchema` for an Error) and construct the class inside the handler.",
};

const NO_BARE_ZOD_CUSTOM = {
  selector:
    "CallExpression[callee.object.name='z'][callee.property.name='custom'][arguments.length=0]",
  message:
    "z.custom<T>() without a validator performs no validation — it is an `as T` assertion wearing a zod costume. Declare the shape structurally (z.object/z.enum/…) so the dispatcher's parse actually checks it.",
};

const NO_INTENT_ASSERTION_IN_DISPATCH = {
  selector: "CallExpression[callee.property.name='dispatch'] > TSAsExpression",
  message:
    "`dispatch({…} as XIntent)` asserts the payload instead of checking it, so a contract change is invisible here. Use the explicit type argument — `dispatch<XIntent>({…})` — which types the result identically and checks the argument.",
};

const NO_EVENT_ASSERTION_IN_EMIT = {
  selector: "CallExpression[callee.property.name='emit'] > TSAsExpression",
  message:
    "`emit({…} as XEvent)` asserts the payload instead of checking it. Drop the assertion (emit is typed to the events this operation declares) or use `satisfies XEvent`.",
};

// ---------------------------------------------------------------------------
// Error classification: branch on codes, never on text.
//
// An error's message (and a process's stderr/stdout) is for display. Its wording is localized
// (git, procps), changes between library versions, and embeds whatever it is about — a
// temp path spelling "TAR" once made a missing file read as a corrupt archive. Classify by the
// structured signal instead: `error.code`, an exit code, `ProcessResult.spawnError`, `name`,
// `instanceof`. See docs/PATTERNS.md (Error Classification). Production code only: tests may
// assert on the messages CodeHydra itself writes.
// ---------------------------------------------------------------------------

const TEXT_MATCH_METHOD = "/^(includes|startsWith|endsWith|match|matchAll|search|indexOf)$/";
const ERROR_TEXT_PROPERTY = "/^(message|stderr|stdout)$/";
const ERROR_TEXT_MESSAGE =
  "Do not classify an error by its text (message/stderr/stdout): it is localized, unstable and embeds paths. Branch on error.code, an exit code, ProcessResult.spawnError, name or instanceof. See docs/PATTERNS.md (Error Classification).";

const NO_ERROR_TEXT_MATCH = [
  // err.message.includes("…"), result.stderr.startsWith("…")
  {
    selector: `CallExpression[callee.property.name=${TEXT_MATCH_METHOD}][callee.object.property.name=${ERROR_TEXT_PROPERTY}]`,
    message: ERROR_TEXT_MESSAGE,
  },
  // err.message.toLowerCase().includes("…")
  {
    selector: `CallExpression[callee.property.name=${TEXT_MATCH_METHOD}][callee.object.callee.object.property.name=${ERROR_TEXT_PROPERTY}]`,
    message: ERROR_TEXT_MESSAGE,
  },
  // const message = getErrorMessage(err); message.includes("…")
  {
    selector: `CallExpression[callee.property.name=${TEXT_MATCH_METHOD}][callee.object.name=/^(message|msg|errMsg|errorMessage|stderr|stdout)$/]`,
    message: ERROR_TEXT_MESSAGE,
  },
  // getErrorMessage(err).includes("…")
  {
    selector: `CallExpression[callee.property.name=${TEXT_MATCH_METHOD}][callee.object.callee.name='getErrorMessage']`,
    message: ERROR_TEXT_MESSAGE,
  },
  // /…/.test(err.message)
  {
    selector: `CallExpression[callee.property.name='test'][arguments.0.property.name=${ERROR_TEXT_PROPERTY}]`,
    message: ERROR_TEXT_MESSAGE,
  },
];

const PRODUCTION_SOURCES = [
  "src/**/*.ts",
  "src/**/*.svelte",
  "extensions/*/src/**/*.ts",
  "extensions/*/src/**/*.svelte",
];
const TEST_SOURCES = [
  "**/*.test.ts",
  "**/*test-utils.ts",
  "**/*.state-mock.ts",
  "**/state-mock.ts",
  "src/test/**",
];

// Files where a dynamic import() is load-bearing and cannot be hoisted:
// - vite.config.ts: `await import("vite")` inside a plugin hook (importing vite
//   at module scope would be circular).
// - the two renderer tests below: they call vi.resetModules() and re-import a
//   module that reads `window.api` at module scope, so the import must happen
//   after the stub is installed.
const DYNAMIC_IMPORT_ALLOWED = [
  "**/vite.config.ts",
  "src/renderer/lib/api/index.test.ts",
  "src/renderer/lib/logging/index.test.ts",
];

export default tseslint.config(
  includeIgnoreFile(gitignorePath),
  // Ignore VS Code extensions node_modules and dist, but lint source
  // Ignore packages/ - standalone npm/PyPI launchers with own conventions
  { ignores: ["extensions/**/node_modules/", "extensions/**/dist/", "packages/"] },
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
      "no-restricted-syntax": ["error", NO_DYNAMIC_IMPORT, NO_INLINE_TYPE_IMPORT],
    },
  },
  {
    files: DYNAMIC_IMPORT_ALLOWED,
    rules: {
      "no-restricted-syntax": ["error", NO_INLINE_TYPE_IMPORT],
    },
  },
  {
    files: PRODUCTION_SOURCES,
    ignores: TEST_SOURCES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        NO_INLINE_TYPE_IMPORT,
        ...NO_ERROR_TEXT_MATCH,
      ],
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
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_|^[RT]$" },
      ],
    },
  },
  // zod confinement: zod is the intent system's dependency (src/intents/contract, item 2).
  // Renderer, preload, and shared consume contract *types* (type-only, erased at build) — they
  // must not import zod directly, so contract types never pull zod into those bundles. Two
  // pre-existing shared IPC/API message validators (ui-event, api-protocol) are exempted.
  {
    files: [
      "src/renderer/**/*.ts",
      "src/renderer/**/*.svelte",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
    ],
    ignores: ["src/shared/ui-event.ts", "src/shared/api-protocol.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["zod", "zod/*"],
              message:
                "zod is confined to the intent system (src/intents/contract). Import contract types (type-only) or a re-exported schema value; do not import zod in renderer/preload/shared. (Legacy exceptions: src/shared/ui-event.ts, src/shared/api-protocol.ts.)",
            },
          ],
        },
      ],
    },
  },
  // Intent contract hygiene. Scoped to the intent system, which is what a backend tunnel has
  // to serialize. `linterOptions.noInlineConfig` is on, so there is no per-line escape — an
  // exemption would have to be a visible `files:` block here, which is the point.
  {
    files: ["src/intents/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        NO_INLINE_TYPE_IMPORT,
        NO_ZOD_INSTANCEOF,
        NO_BARE_ZOD_CUSTOM,
        NO_INTENT_ASSERTION_IN_DISPATCH,
        NO_EVENT_ASSERTION_IN_EMIT,
      ],
    },
  },
  {
    files: ["src/intents/**/*.ts"],
    ignores: TEST_SOURCES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        NO_INLINE_TYPE_IMPORT,
        NO_ZOD_INSTANCEOF,
        NO_BARE_ZOD_CUSTOM,
        NO_INTENT_ASSERTION_IN_DISPATCH,
        NO_EVENT_ASSERTION_IN_EMIT,
        ...NO_ERROR_TEXT_MATCH,
      ],
    },
  },
  // The dispatch/emit assertion bans apply everywhere intents are dispatched, not just inside
  // the intent system — modules are where most dispatch sites live.
  {
    files: ["src/modules/**/*.ts", "src/main.ts"],
    ignores: ["**/*.test.ts", "**/*.test-utils.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        NO_INLINE_TYPE_IMPORT,
        NO_INTENT_ASSERTION_IN_DISPATCH,
        NO_EVENT_ASSERTION_IN_EMIT,
      ],
    },
  },
  // The same, plus the error-text ban, for the production files among them (the block above
  // also covers boundary-test-utils and state mocks, which may read test runners' messages).
  {
    files: ["src/modules/**/*.ts", "src/main.ts"],
    ignores: TEST_SOURCES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_DYNAMIC_IMPORT,
        NO_INLINE_TYPE_IMPORT,
        NO_INTENT_ASSERTION_IN_DISPATCH,
        NO_EVENT_ASSERTION_IN_EMIT,
        ...NO_ERROR_TEXT_MATCH,
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
