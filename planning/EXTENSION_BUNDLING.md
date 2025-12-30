---
status: COMPLETED
last_updated: 2025-12-30
reviewers: [review-arch, review-testing, review-docs]
---

# EXTENSION_BUNDLING

## Overview

- **Problem**: The `sst-dev.opencode` VS Code extension is downloaded from the marketplace at runtime during setup, requiring network access and having no version pinning
- **Solution**: Pin the extension version in `extensions/external.json` and download it at build time, bundling the .vsix in the distributable
- **Risks**:
  - Build script needs network access to VS Code Marketplace
  - Extension updates require rebuilding the app
  - If marketplace is down, builds fail (acceptable for build-time dependency)
- **Alternatives Considered**:
  - Adding version to `versions.ts` - rejected because extensions are conceptually separate from binaries
  - Keeping runtime download with version check - rejected because user wants strictly bundled versions

## Architecture

```
BUILD TIME:
┌─────────────────────────────────────────────────────────────────────┐
│  extensions/external.json                                           │
│  [{ "id": "sst-dev.opencode", "version": "0.0.13" }]                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  scripts/build-extensions.ts                                        │
│  1. Build local extensions (sidekick) → .vsix                       │
│  2. Download external extensions from marketplace → .vsix           │
│     - Parse id: "sst-dev.opencode" → publisher="sst-dev", name="opencode"
│     - URL: https://{publisher}.gallery.vsassets.io/_apis/public/    │
│            gallery/publisher/{publisher}/extension/{name}/{version}/│
│            assetbyname/Microsoft.VisualStudio.Services.VSIXPackage  │
│     - Fail build on any error (404, network, etc.)                  │
│  3. Generate manifest.json (flat array of all extensions)           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  dist/extensions/                                                   │
│  ├── codehydra-sidekick-0.0.3.vsix                                  │
│  ├── sst-dev-opencode-0.0.13.vsix                                   │
│  └── manifest.json                                                  │
│      [                                                              │
│        { "id": "codehydra.sidekick", "version": "0.0.3", "vsix": "..."},
│        { "id": "sst-dev.opencode", "version": "0.0.13", "vsix": "..."}
│      ]                                                              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  (vite-plugin-static-copy)
┌─────────────────────────────────────────────────────────────────────┐
│  out/main/assets/  (bundled in ASAR)                                │
│  ├── codehydra-sidekick-0.0.3.vsix                                  │
│  ├── sst-dev-opencode-0.0.13.vsix                                   │
│  └── manifest.json                                                  │
└─────────────────────────────────────────────────────────────────────┘

RUNTIME (setup):
┌─────────────────────────────────────────────────────────────────────┐
│  VscodeSetupService                                                 │
│  - Reads manifest.json (array of extensions)                        │
│  - Installs from local .vsix files only                             │
│  - Fails if bundled extension is missing (no fallback)              │
│  - Recovery: user must re-download the app                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Manifest schema change:**

Before:

```json
{
  "marketplace": ["sst-dev.opencode"],
  "bundled": [{ "id": "codehydra.sidekick", "version": "0.0.3", "vsix": "..." }]
}
```

After:

```json
[
  { "id": "codehydra.sidekick", "version": "0.0.3", "vsix": "codehydra-sidekick-0.0.3.vsix" },
  { "id": "sst-dev.opencode", "version": "0.0.13", "vsix": "sst-dev-opencode-0.0.13.vsix" }
]
```

## Implementation Steps

- [x] **Step 1: Update external.json format**
  - Change from array of strings to array of objects with id and version
  - File: `extensions/external.json`
  - Before: `["sst-dev.opencode"]`
  - After: `[{ "id": "sst-dev.opencode", "version": "X.Y.Z" }]`
  - Test criteria: JSON schema validation in build script rejects invalid format

- [x] **Step 2: Add marketplace download function to build script**
  - Add function to download .vsix from VS Code Marketplace API
  - Parse extension id by splitting on `.` - first part is publisher, second part is extension name
  - URL format: `https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}/extension/{name}/{version}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage`
  - Error handling: Throw error and stop build on any failure (network error, 404, invalid response). Build must fail if external extension cannot be downloaded - no partial builds allowed.
  - File: `scripts/build-extensions.ts`
  - Test criteria: Downloads correct version; build fails with clear error message on network/HTTP error

- [x] **Step 3: Update build script to generate new manifest format**
  - Read external.json with new format (array of `{ id, version }` objects)
  - Download each external extension to `dist/extensions/`
  - Generate manifest.json as a flat array (not object with bundled/marketplace keys)
  - All extensions (local + external) go into the same array
  - File: `scripts/build-extensions.ts`
  - Test criteria: manifest.json is an array containing all extensions

- [x] **Step 4: Update ExtensionsConfig type**
  - Change `ExtensionsConfig` from `{ marketplace: string[], bundled: BundledExtension[] }` to `BundledExtension[]`
  - Rename type to `ExtensionsManifest` (array of extensions)
  - Verify no other code reads old `manifest.marketplace` or `manifest.bundled` fields (grep for references)
  - Update `validateExtensionsConfig()` to validate array format
  - File: `src/services/vscode-setup/types.ts`
  - Test criteria: Type definitions match new schema, validation passes for array format

- [x] **Step 5: Simplify VscodeSetupService**
  - Update `preflight()` to iterate over array directly (remove marketplace/bundled distinction)
  - Update `installExtensions()` to iterate over array directly
  - Remove all marketplace-related code paths
  - Fail if bundled extension vsix is missing with clear error message
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`
  - Test criteria: Only installs from bundled vsix files; clear error on missing vsix

- [x] **Step 6: Update tests**
  - Remove marketplace-related test scenarios from vscode-setup-service tests
  - Update mock manifest.json fixtures to use new array format
  - Add test for installation failure (ProcessRunner returns error)
  - Ensure all behavioral mocks use in-memory state and resolve synchronously (<50ms per test)
  - Files: `src/services/vscode-setup/*.test.ts`, `src/services/vscode-setup/*.integration.test.ts`
  - Specific tests to remove/update:
    - Remove any tests checking marketplace extension installation
    - Update manifest fixtures from `{ marketplace: [], bundled: [...] }` to `[...]`
  - Test criteria: All tests pass with new schema

- [x] **Step 7: Set initial opencode extension version**
  - Check https://marketplace.visualstudio.com/items?itemName=sst-dev.opencode for current latest version
  - Update `extensions/external.json` with the current version
  - Run `npm run build:extensions` to verify download works
  - File: `extensions/external.json`
  - Test criteria: Extension downloads and bundles correctly

- [x] **Step 8: Update documentation**
  - Update AGENTS.md VS Code Assets section:
    - Change "External extension IDs (marketplace)" to "External extension IDs and versions (downloaded at build time)"
    - Update Build Process description to note external extensions are downloaded from marketplace during build
    - Update Runtime Flow to clarify external extensions are pre-bundled
    - Update manifest.json example to show new array format
  - Update docs/ARCHITECTURE.md VS Code Setup section:
    - Update manifest.json structure documentation (array format, no marketplace/bundled keys)
    - Update preflight check description (iterates array of extensions)
    - Note that external extensions are downloaded at build time, not runtime
  - Files: `AGENTS.md`, `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects new behavior

## Testing Strategy

### Integration Tests

| #   | Test Case                                   | Entry Point                      | Mock Setup                                                                                                  | Behavior Verified                                                          |
| --- | ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Setup installs all extensions               | `VscodeSetupService.setup()`     | FileSystemLayer: manifest.json array with 2 extensions, vsix files exist. ProcessRunner: returns exitCode 0 | Preflight passes after setup, all extensions present with correct versions |
| 2   | Preflight detects missing extension         | `VscodeSetupService.preflight()` | FileSystemLayer: manifest.json with 2 extensions, only 1 installed in extensions dir                        | Returns `missingExtensions` containing the missing extension id            |
| 3   | Preflight detects outdated extension        | `VscodeSetupService.preflight()` | FileSystemLayer: manifest.json with extension v2.0.0, extensions dir has v1.0.0 installed                   | Returns `outdatedExtensions` containing the outdated extension id          |
| 4   | Setup fails if vsix file missing            | `VscodeSetupService.setup()`     | FileSystemLayer: manifest.json references vsix, but file read throws ENOENT                                 | Returns error with message indicating which vsix file is missing           |
| 5   | Setup fails if extension installation fails | `VscodeSetupService.setup()`     | FileSystemLayer: vsix exists. ProcessRunner: returns exitCode 1 with stderr message                         | Returns error with installation failure message                            |

**Mock Performance Note**: All FileSystemLayer mocks use in-memory Map for file contents. ProcessRunner mocks resolve synchronously. Tests must complete in <50ms each.

### Manual Testing Checklist

- [ ] Run `npm run build:extensions` - verify external extension downloads
- [ ] Check `dist/extensions/manifest.json` - verify array format with all extensions
- [ ] Run `npm run build` - verify vsix files copied to out/main/assets/
- [ ] Run fresh setup (delete app-data) - verify extensions install without network
- [ ] Verify opencode extension works in code-server (Cmd+Esc opens opencode)
- [ ] Test build failure when marketplace is unreachable (use invalid version) - verify build stops with clear error

## Dependencies

| Package | Purpose                                                            | Approved |
| ------- | ------------------------------------------------------------------ | -------- |
| (none)  | Uses built-in fetch for download (build script, not service layer) | N/A      |

**Note**: Build scripts (`scripts/`) are outside the service layer boundary and can use Node.js built-in APIs directly. The External System Access Rules in AGENTS.md apply to `src/services/` code, not build scripts.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Update VS Code Assets section: change "External extension IDs (marketplace)" to "External extension IDs and versions (downloaded at build time)". Update Build Process to note external extensions downloaded during build. Update manifest.json example to array format. |
| `docs/ARCHITECTURE.md` | Update VS Code Setup section: update manifest.json structure (array format), update preflight check description, note external extensions downloaded at build time not runtime.                                                                                           |

### New Documentation Required

| File   | Purpose                         |
| ------ | ------------------------------- |
| (none) | Existing docs cover the pattern |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
