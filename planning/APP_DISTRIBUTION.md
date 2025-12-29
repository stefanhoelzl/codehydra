---
status: CLEANUP
last_updated: 2025-12-29
reviewers: [review-arch, review-testing, review-docs]
---

# APP_DISTRIBUTION

## Overview

- **Problem**: CodeHydra has no way to create distributable packages for end users. Currently only runs in development mode via `npm run dev`.
- **Solution**: Add electron-builder configuration to create portable Windows exe and Linux AppImage distributables via npm scripts.
- **Risks**:
  - Native dependencies (socket.io's optional deps) may need special handling
  - First-run binary downloads need internet access (code-server, opencode downloaded at runtime)
- **Alternatives Considered**:
  - **Bundling binaries**: Rejected - would add ~500MB+ per platform, current runtime download approach is better
  - **electron-forge**: Rejected - electron-builder is more mature and better documented for our targets

## Architecture

```
Build Flow:
┌─────────────────────────────────────────────────────────────────┐
│                         npm run dist                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    npm run build                                │
│  (build:extensions → electron-vite build)                       │
│  Output: dist/extensions/*.vsix, out/main/*, out/renderer/*     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    electron-builder                             │
│  - Packages out/ directory (excludes dist/extensions/)          │
│  - Bundles node_modules (production only)                       │
│  - Creates platform-specific distributable in dist/             │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   Windows Portable      │     │    Linux AppImage       │
│   dist/                 │     │    dist/                │
│   CodeHydra-x.x.x.exe   │     │   CodeHydra-x.x.x.AppImage│
└─────────────────────────┘     └─────────────────────────┘
```

### Directory Structure

```
dist/                          # Mixed: extensions + final distributables
├── extensions/                # Extension builds (existing, unchanged)
│   ├── codehydra-sidekick-*.vsix
│   └── extensions.json
├── win-unpacked/              # Unpacked Windows app (for debugging)
├── linux-unpacked/            # Unpacked Linux app (for debugging)
├── CodeHydra-0.1.0.exe        # Windows portable executable
└── CodeHydra-0.1.0.AppImage   # Linux AppImage

out/                           # Compiled code (existing, unchanged)
├── main/                      # Main process code
│   ├── index.js
│   └── assets/                # Copied from dist/extensions/ by vite
│       ├── *.vsix
│       └── extensions.json
├── preload/                   # Preload scripts
│   └── index.cjs
└── renderer/                  # Renderer code
    └── index.html
```

**Note**: `dist/extensions/` is created by `build:extensions`, then copied to `out/main/assets/` by vite-plugin-static-copy. Electron-builder outputs to `dist/` but excludes `dist/extensions/` from the package (those are intermediate build artifacts, already included via `out/main/assets/`).

### Runtime Binary Download

Distributables do NOT include code-server or opencode binaries. These are downloaded on first launch:

```
First Launch Flow:
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  App Start   │ ──► │ Setup Check  │ ──► │ Download     │
│              │     │ (no marker)  │     │ Binaries     │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                                                 ▼
                                          ┌──────────────┐
                                          │ Write Marker │
                                          │ App Ready    │
                                          └──────────────┘
```

### Portable Mode Limitations

The Windows portable exe does NOT support true portable mode (storing data next to the exe). The `PathProvider` always computes data paths based on system locations:

- Windows: `%APPDATA%\Codehydra\`
- Linux: `~/.local/share/codehydra/`

True portable mode would require detecting the `PORTABLE_EXECUTABLE_DIR` environment variable (set by electron-builder's portable target) and overriding path computation. This is documented as a future enhancement.

## Implementation Steps

- [x] **Step 1: Install electron-builder**
  - Add `electron-builder` as dev dependency
  - Files affected: `package.json`, `package-lock.json`
  - Test criteria: `npm ls electron-builder` shows installed version

- [x] **Step 2: Create electron-builder configuration**
  - Create `electron-builder.yaml` with portable (Windows) and AppImage (Linux) targets
  - Configure file patterns, resources, and metadata
  - Exclude `dist/extensions/` from package (already included via `out/main/assets/`)
  - Files affected: `electron-builder.yaml` (new)
  - Test criteria: `npx electron-builder --help` works, config is valid YAML

- [x] **Step 3: Add extraResources for app icon**
  - Configure electron-builder to copy icon files outside ASAR
  - This ensures icons are accessible at runtime for app badge features
  - Files affected: `electron-builder.yaml`
  - Test criteria: Icon files present in unpacked resources directory after build

- [x] **Step 4: Add distribution npm scripts**
  - Add `dist`, `dist:win`, `dist:linux` scripts to package.json
  - Files affected: `package.json`
  - Test criteria: Scripts appear in `npm run` output

- [x] **Step 5: Add post-build validation**
  - Add validation script to verify build output is correct
  - Checks: `dist/extensions/` exists, `out/main/assets/*.vsix` exists, distributable size is reasonable
  - Files affected: `package.json` (validation in dist scripts)
  - Test criteria: Build fails if validation fails

- [x] **Step 6: Test Linux build**
  - Run `npm run dist:linux` on Linux
  - Verify AppImage is created in `dist/`
  - Verify AppImage runs and completes first-run setup
  - Files affected: None (build output)
  - Test criteria: `CodeHydra-0.1.0.AppImage` exists and launches successfully
  - **Note**: This step can only be performed on Linux

- [x] **Step 7: Test Windows build**
  - Run `npm run dist:win` on Windows
  - Verify portable exe is created in `dist/`
  - Verify exe runs and completes first-run setup
  - Files affected: None (build output)
  - Test criteria: `CodeHydra-0.1.0.exe` exists and launches successfully
  - **Note**: This step can only be performed on Windows

- [x] **Step 8: Update documentation**
  - Add distribution commands to AGENTS.md
  - Update ARCHITECTURE.md build process documentation
  - Files affected: `AGENTS.md`, `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects new commands and build flow

## Testing Strategy

### Automated Validation

Post-build validation runs automatically as part of `npm run dist:*` scripts:

```bash
# Validation checks (run after electron-builder):
# 1. dist/extensions/*.vsix exists (extension build worked)
# 2. Distributable file exists and size < 300MB
# 3. No unexpected files in dist/ root
```

### Manual Testing Checklist

Distribution builds are tested manually since they require platform-specific execution:

- [ ] **Linux AppImage**
  - [ ] Build completes without errors (`npm run dist:linux`)
  - [ ] `dist/CodeHydra-*.AppImage` file exists
  - [ ] File size is reasonable (verify, update expected range after first build)
  - [ ] AppImage has execute permission after build
  - [ ] Running AppImage launches the app
  - [ ] First-run setup downloads binaries successfully
  - [ ] Can create a project and workspace after setup
  - [ ] App stores data in `~/.local/share/codehydra/`

- [ ] **Windows Portable**
  - [ ] Build completes without errors (`npm run dist:win`)
  - [ ] `dist/CodeHydra-*.exe` file exists
  - [ ] File size is reasonable (verify, update expected range after first build)
  - [ ] Double-click exe launches the app
  - [ ] First-run setup downloads binaries successfully
  - [ ] Can create a project and workspace after setup
  - [ ] App stores data in `%APPDATA%\Codehydra\` (NOT portable - see Portable Mode Limitations)

### Build Validation

Before creating distributables, always run:

```bash
npm run validate:fix
```

This ensures the app builds and tests pass before packaging.

## Configuration Details

### electron-builder.yaml

```yaml
appId: com.codehydra.app
productName: CodeHydra
copyright: Copyright © 2025 CodeHydra

# Build directories
directories:
  output: dist
  buildResources: resources

# Files to include in the package
files:
  - out/**/*
  - package.json
  - "!out/**/*.map"
  - "!out/**/*.test.*"

# Copy icons outside ASAR for runtime access (app badge, etc.)
extraResources:
  - from: resources/icon.png
    to: icon.png
  - from: resources/icon.ico
    to: icon.ico

# ASAR archive settings
asar: true
# Note: No asarUnpack needed - simple-git is pure JS (spawns git CLI),
# and socket.io's optional native deps are already externalized in vite config

# Windows configuration
win:
  target:
    - target: portable
      arch: [x64]
  icon: resources/icon.ico

# Note: portable.useAppDirWhenRunning is NOT set because PathProvider
# doesn't support portable mode yet. Data goes to %APPDATA%\Codehydra\

# Linux configuration
linux:
  target:
    - target: AppImage
      arch: [x64]
  icon: resources/icon.png
  category: Development
  synopsis: Multi-workspace IDE for parallel AI agent development
  description: |
    CodeHydra is a multi-workspace IDE designed for parallel AI agent development.
    Each workspace runs in an isolated environment with its own VS Code instance.

# AppImage-specific settings
appImage:
  artifactName: ${productName}-${version}.${ext}

# macOS configuration (future enhancement - not implemented)
# mac:
#   target:
#     - target: dmg
#       arch: [x64, arm64]
#   icon: resources/icon.png
#   category: public.app-category.developer-tools
```

### npm Scripts

```json
{
  "scripts": {
    "dist": "npm run build && electron-builder",
    "dist:win": "npm run build && electron-builder --win",
    "dist:linux": "npm run build && electron-builder --linux"
  }
}
```

### Script Usage

| Command              | Platform   | Output                          |
| -------------------- | ---------- | ------------------------------- |
| `npm run dist`       | Current OS | Platform-specific distributable |
| `npm run dist:win`   | Windows    | `dist/CodeHydra-x.x.x.exe`      |
| `npm run dist:linux` | Linux      | `dist/CodeHydra-x.x.x.AppImage` |

**Note**: Cross-platform builds have limitations:

- Windows portable can only be built on Windows
- Linux AppImage can only be built on Linux
- macOS DMG can only be built on macOS (future)

For cross-platform releases, CI/CD with platform-specific runners is required (see Future Enhancements).

## Dependencies

| Package          | Purpose                        | Approved |
| ---------------- | ------------------------------ | -------- |
| electron-builder | Create platform distributables | [ ]      |

**User must approve all dependencies before implementation begins.**

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                      |
| ---------------------- | --------------------------------------------------------------------- |
| `AGENTS.md`            | Add `dist`, `dist:win`, `dist:linux` to Essential Commands table      |
| `docs/ARCHITECTURE.md` | Document that `dist/` now contains both extensions and distributables |

### New Documentation Required

None - distribution process is documented in AGENTS.md and this plan.

## Future Enhancements

These are explicitly out of scope for this plan but documented for future reference:

1. **CI/CD Release Workflow**
   - GitHub Actions workflow triggered by tags
   - Matrix build on Windows/Linux/macOS runners
   - Auto-publish to GitHub Releases

2. **Code Signing**
   - Windows: EV certificate for SmartScreen trust
   - macOS: Apple Developer certificate + notarization
   - Linux: GPG signing for AppImage

3. **Auto-Update**
   - Add `electron-updater` dependency
   - Configure publish settings in electron-builder.yaml
   - Implement update UI in the app

4. **True Portable Mode (Windows)**
   - Detect `PORTABLE_EXECUTABLE_DIR` environment variable
   - Override `PathProvider.dataRootDir` when in portable mode
   - Store data next to exe instead of `%APPDATA%`

5. **Additional Architectures**
   - Linux arm64 AppImage
   - Windows arm64 (requires code-server arm64 builds)

6. **Additional Targets**
   - Windows NSIS installer (for users who prefer installers)
   - Linux Flatpak/Snap (for sandboxed distribution)
   - macOS DMG and App Store (MAS) build

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed (manual testing checklist)
- [ ] Changes committed
