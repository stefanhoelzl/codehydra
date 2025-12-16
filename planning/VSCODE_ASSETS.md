---
status: COMPLETED
last_updated: 2024-12-16
reviewers: [review-arch, review-docs]
---

# VSCODE_ASSETS

## Overview

- **Problem**: VS Code setup assets (settings, keybindings, extensions) are currently embedded as inline TypeScript code in `vscode-setup-service.ts`. This makes them hard to maintain and requires code changes for simple config updates. The custom codehydra extension is generated inline, making it difficult to add files.
- **Solution**: Move all assets to dedicated files in an `assets/` directory. Package the custom extension as a `.vsix` at build time. Install all extensions (bundled and marketplace) using the same `code-server --install-extension` mechanism.
- **Risks**:
  - Build complexity increases slightly (vsce packaging step)
  - Asset path resolution must work in both dev and production
- **Alternatives Considered**:
  - Runtime VSIX packaging: Rejected due to added runtime complexity and dependency on vsce
  - JSON imports (bundled at build): Rejected in favor of file copying for consistency and to keep assets as plain files

## Architecture

```
Build Time:
┌─────────────────────────────────────────────────────────────────┐
│  src/services/vscode-setup/assets/                              │
│  ├── settings.json                                              │
│  ├── keybindings.json                                           │
│  ├── extensions.json                                            │
│  └── codehydra-extension/                                       │
│      ├── package.json                                           │
│      └── extension.js                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  npm run build                                                  │
│  1. vsce package → codehydra.vscode-0.0.1.vsix                 │
│  2. electron-vite build + vite-plugin-static-copy               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  out/main/assets/  (bundled in ASAR in production)              │
│  ├── settings.json                                              │
│  ├── keybindings.json                                           │
│  ├── extensions.json                                            │
│  └── codehydra.vscode-0.0.1.vsix                               │
└─────────────────────────────────────────────────────────────────┘

Runtime (files COPIED to app-data before use by external processes):
┌─────────────────────────────────────────────────────────────────┐
│  ASAR: out/main/assets/                                         │
│  (Node.js fs module reads transparently from ASAR)              │
│  NOTE: External processes (code-server) cannot read from ASAR,  │
│  so all files are copied to <app-data> before use.              │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          │ fs.copyTree        │ fs.copyTree        │ fs.copyTree
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ <app-data>/      │ │ <app-data>/      │ │ <app-data>/vscode/   │
│ vscode/user-data/│ │ vscode/user-data/│ │ *.vsix               │
│ User/settings.json│ │ User/keybindings│ │         │            │
└──────────────────┘ └──────────────────┘ │         ▼            │
                                          │ code-server          │
                                          │ --install-extension  │
                                          │         │            │
                                          │         ▼            │
                                          │ vscode/extensions/   │
                                          └──────────────────────┘
```

### Path Resolution (Dev vs Production)

| Mode                        | `vscodeAssetsDir` resolves to                               |
| --------------------------- | ----------------------------------------------------------- |
| Development (`npm run dev`) | `path.join(app.getAppPath(), "out/main/assets")`            |
| Production (packaged app)   | Same path, but inside ASAR archive (transparent to Node.js) |

In both cases, files are read via Node.js `fs` module (ASAR-transparent) and copied to `<app-data>/vscode/` before any external process needs them.

## Implementation Steps

- [x] **Step 1: Add dev dependencies**
  - Add `@vscode/vsce` for packaging extensions
  - Add `vite-plugin-static-copy` for copying assets during build
  - Files affected: `package.json`
  - Test criteria: `npm install` succeeds

- [x] **Step 2: Create asset files**
  - Create `assets/settings.json` by extracting the settings object from `vscode-setup-service.ts` lines 200-213
  - Create `assets/keybindings.json` by extracting the keybindings array from `vscode-setup-service.ts` lines 216-219
  - Create `assets/extensions.json` with structure:
    ```json
    {
      "marketplace": ["sst-dev.opencode"],
      "bundled": ["codehydra.vscode-0.0.1.vsix"]
    }
    ```
  - Create `assets/codehydra-extension/package.json` by extracting from `vscode-setup-service.ts` lines 140-152
  - Create `assets/codehydra-extension/extension.js` by extracting from `vscode-setup-service.ts` lines 155-179
  - Files affected: New files in `src/services/vscode-setup/assets/`
  - Test criteria: Files exist with valid JSON/JS content

- [x] **Step 3: Update build configuration**
  - Add `build:extension` script to package.json:
    ```json
    "build:extension": "cd src/services/vscode-setup/assets/codehydra-extension && vsce package --no-dependencies -o ../codehydra.vscode-0.0.1.vsix"
    ```
  - Update `build` script to run extension packaging first:
    ```json
    "build": "npm run build:extension && electron-vite build"
    ```
  - Configure vite-plugin-static-copy in electron.vite.config.ts for main process:
    ```typescript
    viteStaticCopy({
      targets: [
        { src: "src/services/vscode-setup/assets/settings.json", dest: "assets" },
        { src: "src/services/vscode-setup/assets/keybindings.json", dest: "assets" },
        { src: "src/services/vscode-setup/assets/extensions.json", dest: "assets" },
        { src: "src/services/vscode-setup/assets/*.vsix", dest: "assets" },
      ],
    });
    ```
  - Files affected: `package.json`, `electron.vite.config.ts`
  - Test criteria: `npm run build` produces `out/main/assets/` with all files including `.vsix`

- [x] **Step 4: Update PathProvider**
  - Add `vscodeAssetsDir` property to PathProvider interface
  - Implement in DefaultPathProvider:
    ```typescript
    get vscodeAssetsDir(): string {
      return join(app.getAppPath(), "out", "main", "assets");
    }
    ```
  - Update mock factory in test-utils to include `vscodeAssetsDir` with default `/mock/assets`
  - Files affected: `src/services/platform/path-provider.ts`, `src/services/platform/path-provider.test-utils.ts`
  - Test criteria: PathProvider returns correct assets path in both dev and production

- [x] **Step 5: Update types.ts**
  - Remove `VscodeSettings` interface (lines 78-91)
  - Remove `VscodeKeybinding` interface (lines 70-73)
  - Add `ExtensionsConfig` interface:
    ```typescript
    /**
     * Structure of extensions.json asset file.
     */
    export interface ExtensionsConfig {
      /** Marketplace extension IDs (e.g., "sst-dev.opencode") */
      readonly marketplace: readonly string[];
      /** Bundled .vsix filenames (e.g., "codehydra.vscode-0.0.1.vsix") */
      readonly bundled: readonly string[];
    }
    ```
  - Files affected: `src/services/vscode-setup/types.ts`
  - Test criteria: Types compile without errors

- [x] **Step 6: Refactor VscodeSetupService**
  - Add `assetsDir` property initialized from `pathProvider.vscodeAssetsDir`
  - Remove `installCustomExtensions()` method entirely
  - Rename `installMarketplaceExtensions()` to `installExtensions()`
  - Add asset validation at start of `setup()`:
    - Check that settings.json, keybindings.json, extensions.json exist
    - Throw `VscodeSetupError` with type `"missing-assets"` if any are missing
  - Update `installExtensions()` to:
    - Load and parse extensions.json via `fs.readFile`
    - For each bundled vsix: copy from assetsDir to vscodeDir, then install
    - For each marketplace extension: install directly by ID
  - Update `writeConfigFiles()` to copy files using `fs.copyTree`:
    - Copy `assetsDir/settings.json` → `vscodeUserDataDir/User/settings.json`
    - Copy `assetsDir/keybindings.json` → `vscodeUserDataDir/User/keybindings.json`
    - Note: `copyTree` works for single files, not just directories
  - Update `setup()` to call `installExtensions()` instead of separate methods
  - Files affected: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test criteria: Service correctly validates, copies, and installs all assets

- [x] **Step 7: Update tests**
  - Update mocks to provide asset file content via `fs.readFile`:
    - Mock `readFile(assetsDir/extensions.json)` to return extensions config JSON
    - Mock `readFile(assetsDir/settings.json)` for validation check
    - Mock `readFile(assetsDir/keybindings.json)` for validation check
  - Update tests for `installExtensions()` (replaces `installMarketplaceExtensions`):
    - Test bundled vsix is copied to vscodeDir before install
    - Test code-server called with correct vsix path
    - Test marketplace extensions installed by ID
  - Remove tests for `installCustomExtensions()`
  - Add tests for:
    - File copying behavior in `writeConfigFiles()`
    - Missing asset validation throws `VscodeSetupError`
  - Files affected: `src/services/vscode-setup/vscode-setup-service.test.ts`
  - Test criteria: All tests pass

- [x] **Step 8: Update documentation**
  - Update AGENTS.md "VS Code Setup" section to document:
    - Asset files location: `src/services/vscode-setup/assets/`
    - Build process: vsce packages extension, vite-plugin-static-copy bundles assets
    - Runtime: assets copied from ASAR to app-data via PathProvider.vscodeAssetsDir
  - Update docs/ARCHITECTURE.md if VS Code Setup section exists
  - Files affected: `AGENTS.md`, `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects new asset structure

- [x] **Step 9: Validate and cleanup**
  - Run `npm run validate:fix`
  - Verify build produces correct output structure
  - Test setup flow end-to-end in dev mode
  - Files affected: None (validation only)
  - Test criteria: All checks pass, setup works correctly

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                         | Description                                               | File                         |
| ------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| installExtensions copies bundled vsix             | Verify vsix is copied to vscodeDir before install         | vscode-setup-service.test.ts |
| installExtensions installs bundled extensions     | Verify code-server called with vsix path                  | vscode-setup-service.test.ts |
| installExtensions installs marketplace extensions | Verify code-server called with extension ID               | vscode-setup-service.test.ts |
| installExtensions handles mixed extensions        | Verify both bundled and marketplace installed in order    | vscode-setup-service.test.ts |
| writeConfigFiles copies settings                  | Verify settings.json copied from assetsDir to User dir    | vscode-setup-service.test.ts |
| writeConfigFiles copies keybindings               | Verify keybindings.json copied from assetsDir to User dir | vscode-setup-service.test.ts |
| setup validates assets exist                      | Verify VscodeSetupError thrown if asset files missing     | vscode-setup-service.test.ts |
| setup runs all steps                              | Verify full setup flow with asset copying                 | vscode-setup-service.test.ts |

### Integration Tests

| Test Case             | Description                                  | File                |
| --------------------- | -------------------------------------------- | ------------------- |
| Build produces assets | Verify build output contains all asset files | Manual verification |
| VSIX is valid         | Verify packaged extension can be inspected   | Manual verification |

### Manual Testing Checklist

- [ ] Run `npm run build` and verify `out/main/assets/` contains:
  - settings.json
  - keybindings.json
  - extensions.json
  - codehydra.vscode-0.0.1.vsix
- [ ] Run app in dev mode, trigger setup, verify:
  - Settings applied in code-server
  - Keybindings work (Alt+T toggles panel)
  - Codehydra extension activates (sidebar closes, opencode terminal opens)
  - OpenCode extension installed

## Dependencies

| Package                 | Purpose                             | Approved |
| ----------------------- | ----------------------------------- | -------- |
| @vscode/vsce            | Package VS Code extensions as .vsix | [ ]      |
| vite-plugin-static-copy | Copy asset files during Vite build  | [ ]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `npm add -D <package>` (dev dependencies).**

## Documentation Updates

### Files to Update

| File                 | Changes Required                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGENTS.md            | Add "VS Code Assets" subsection under VS Code Setup explaining: asset location (`src/services/vscode-setup/assets/`), build process (vsce + vite-plugin-static-copy), runtime behavior (copied from ASAR to app-data), and PathProvider.vscodeAssetsDir |
| docs/ARCHITECTURE.md | Update VS Code Setup section to reflect .vsix-based installation instead of inline extension generation                                                                                                                                                 |

### New Documentation Required

None required.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
