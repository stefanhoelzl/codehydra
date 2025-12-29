# VS Code Extensions

This directory contains the source code for VS Code extensions used by CodeHydra.

## Directory Structure

```
extensions/
├── external.json             # External extensions (marketplace IDs)
├── sidekick/                 # Custom sidekick extension source
│   ├── package.json          # Extension manifest
│   ├── extension.js          # Extension entry point
│   ├── api.d.ts              # TypeScript declarations for third-party use
│   └── esbuild.config.js     # Build configuration
└── README.md                 # This file
```

## Build Process

Extensions are built via the `build:extensions` npm script:

```bash
npm run build:extensions
```

This:

1. Discovers all extension folders in `extensions/`
2. Reads each extension's `package.json` for metadata
3. Installs dependencies, builds, and packages each extension as a `.vsix` file
4. Generates `dist/extensions/manifest.json` with the complete extension manifest
5. Outputs `.vsix` files to `dist/extensions/`

The main `npm run build` command runs `build:extensions` before `electron-vite build`, ensuring the packaged extensions are available for bundling.

## Adding a New Extension

1. Create a new directory under `extensions/` (e.g., `extensions/my-extension/`)
2. Add required files:
   - `package.json` with VS Code extension manifest (must include `publisher`, `name`, `version`)
   - `extension.js` or TypeScript source
   - `.vscodeignore` to exclude dev files from the package
   - `npm run build` script to compile the extension
3. Run `npm run build:extensions` - the new extension will be auto-discovered and built

## External Extensions (external.json)

The `external.json` file lists marketplace extension IDs to install:

```json
["sst-dev.opencode", "publisher.another-extension"]
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
