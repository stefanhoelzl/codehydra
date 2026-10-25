# VS Code Extensions

This directory contains the source code for VS Code extensions used by CodeHydra.

> **`markdown-review-editor` talks OpenCode's 1.x server API only** (`@opencode-ai/sdk`).
> It does not work against OpenCode 2 servers yet — its `opencode-handler.ts` needs
> porting to `@opencode/client` (plus the server password and `location` scoping), the
> same migration the app's own client went through (`src/modules/agent-module/opencode/wire-v2.ts`).

## Directory Structure

```
extensions/
├── tsconfig.ext.json         # Shared TypeScript config (strict)
├── vite.config.ext.ts        # Base Vite config for extensions
├── external.json             # Optional: external extensions (currently absent)
├── sidekick/                 # Custom sidekick extension source
│   ├── src/                  # TypeScript source
│   │   ├── extension.ts      # Extension entry point
│   │   └── types.ts          # Internal type definitions
│   ├── package.json          # Extension manifest
│   ├── api.d.ts              # TypeScript declarations for third-party use
│   └── vite.config.ts        # Vite build configuration
├── markdown-review-editor/   # AI-assisted markdown review editor
│   ├── package.json          # Extension manifest
│   ├── src/                  # TypeScript source
│   │   ├── extension/        # VS Code extension host code
│   │   ├── webview/          # Svelte webview entry
│   │   └── lib/              # Shared components and utilities
│   ├── tests/                # Vitest unit tests
│   ├── vite.config.ts        # Webview build configuration
│   └── tsconfig.json         # TypeScript configuration
└── README.md                 # This file
```

## Build Process

Extensions are built via the `build:extensions` pnpm script:

```bash
pnpm build:extensions
```

This:

1. Discovers all extension folders in `extensions/`
2. Reads each extension's `package.json` for metadata
3. Installs dependencies, builds, and packages each extension as a `.vsix` file
4. Generates `dist/extensions/manifest.json` with the complete extension manifest
5. Outputs `.vsix` files to `dist/extensions/`

The main `pnpm build` command runs `build:extensions` before `electron-vite build`, ensuring the packaged extensions are available for bundling.

## Adding a New Extension

1. Create a new directory under `extensions/` (e.g., `extensions/my-extension/`)
2. Add required files:
   - `package.json` with VS Code extension manifest (must include `publisher`, `name`, `version`)
   - `src/extension.ts` - TypeScript source (all extensions must use TypeScript)
   - `vite.config.ts` - Vite config that merges with `../vite.config.ext.ts`
   - `.vscodeignore` to exclude dev files from the package
3. Run `pnpm build:extensions` - the new extension will be auto-discovered and built

**Note:** All extensions must use TypeScript with strict type checking. JavaScript is not supported.

## External Extensions (external.json)

The optional `external.json` file lists marketplace extensions to install, each pinned to a version (no file = none; there is none today):

```json
[{ "id": "publisher.name", "version": "1.2.3" }]
```

## Generated Manifest (dist/extensions/manifest.json)

At build time, `manifest.json` is generated with the complete extension configuration:

```json
{
  "marketplace": ["sst-dev.opencode"],
  "bundled": [
    {
      "id": "codehydra.sidekick",
      "version": "0.0.3",
      "vsix": "sidekick-0.0.3.vsix"
    }
  ]
}
```

- `marketplace`: Extensions installed from the VS Code marketplace (from `external.json`)
- `bundled`: Extensions packaged with the application (auto-discovered from extension folders)
