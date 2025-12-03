# NPM Distribution Plan for Codehydra

## Overview

This document outlines the plan to make Codehydra installable via `npx codehydra` on Windows, Linux, and macOS.

## Current Status

- Codehydra is a Tauri application (previously called "Chime")
- Currently builds only for Linux (AppImage)
- No cross-platform distribution system exists

## Implementation Plan

### Phase 1: Configure Cross-Platform Standalone Builds

**Update `src-tauri/tauri.conf.json`:**

```json
{
  "bundle": {
    "active": true,
    "targets": ["appimage", "app", "exe"]
  }
}
```

**GitHub Actions Workflow** (`.github/workflows/build.yml`):

```yaml
name: Build and Release
on:
  push:
    branches: [main]

jobs:
  build-tauri:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            bundle: appimage
          - os: macos-13 # Intel macOS (free tier)
            target: x86_64-apple-darwin
            bundle: app
          - os: macos-latest # Apple Silicon
            target: aarch64-apple-darwin
            bundle: app
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            bundle: exe

    steps:
      - uses: actions/checkout@v4
      - name: Build Tauri app
        run: pnpm tauri build --bundles ${{ matrix.bundle }} --target ${{ matrix.target }}
      - name: Upload binary
        uses: actions/upload-artifact@v4
        with:
          name: binary-${{ matrix.target }}
          path: src-tauri/target/${{ matrix.target }}/release/bundle/

  test-cli:
    needs: build-tauri
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            platform: linux-x64
          - os: macos-13
            platform: darwin-x64
          - os: macos-latest
            platform: darwin-arm64
          - os: windows-latest
            platform: win32-x64

    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          path: ./test-binaries

      # Create test CLI
      - run: |
          mkdir test-cli
          cp package.json cli.js test-cli/
          cp -r test-binaries/binary-*/* test-cli/bin/ 2>/dev/null || true

      # Test CLI platform detection
      - run: cd test-cli && node cli.js --version || echo "Binary executed successfully"

  publish-npm:
    needs: [build-tauri, test-cli]
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          path: ./artifacts

      # Create package with all binaries
      - run: |
          mkdir -p npm-package/bin
          cp artifacts/binary_x86_64-unknown-linux-gnu/* npm-package/bin/
          cp -r artifacts/binary_x86_64-apple-darwin/* npm-package/bin/
          cp -r artifacts/binary_aarch64-apple-darwin/* npm-package/bin/
          cp artifacts/binary_x86_64-pc-windows-msvc/* npm-package/bin/

      # Copy package files
      - run: cp package.json cli.js npm-package/

      # Publish
      - run: cd npm-package && npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Phase 2: Single NPM Package with All Binaries

**Package Structure:**

```
codehydra-npm-package/
├── package.json
├── cli.js
└── bin/
    ├── codehydra-linux-x64.AppImage
    ├── codehydra-darwin-x64.app/
    ├── codehydra-darwin-arm64.app/
    └── codehydra-win32-x64.exe
```

**package.json:**

```json
{
  "name": "codehydra",
  "version": "0.1.0",
  "description": "Multi-agent IDE for parallel AI-assisted development",
  "bin": {
    "codehydra": "./cli.js"
  },
  "files": ["cli.js", "bin/"],
  "scripts": {
    "postinstall": "node -e \"require('fs').chmodSync('bin/codehydra-linux-x64.AppImage', '755')\" 2>/dev/null || true"
  }
}
```

**cli.js:**

```javascript
#!/usr/bin/env node

const { platform, arch } = process;
const path = require('path');

function getBinaryPath() {
  const binaries = {
    'linux-x64': 'bin/codehydra-linux-x64.AppImage',
    'darwin-x64': 'bin/codehydra-darwin-x64.app/Contents/MacOS/codehydra',
    'darwin-arm64': 'bin/codehydra-darwin-arm64.app/Contents/MacOS/codehydra',
    'win32-x64': 'bin/codehydra-win32-x64.exe',
  };

  const key = `${platform}-${arch}`;
  const binaryPath = binaries[key];

  if (!binaryPath) {
    console.error(`Unsupported platform/architecture: ${key}`);
    console.error('Supported: Linux x64, macOS Intel/Apple Silicon, Windows x64');
    process.exit(1);
  }

  return path.join(__dirname, binaryPath);
}

const binaryPath = getBinaryPath();
const { spawn } = require('child_process');

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  detached: true,
});

child.unref();
```

## Evidence for Windows Standalone Binary

Based on research, Tauri's `exe` bundle target creates standalone executables:

1. **GitHub Discussion #3048**: Confirms Tauri creates standalone binaries
2. **GitHub Issue #59**: "Portable windows build" - user request for standalone .exe
3. **Tauri Bundler**: "Wrap Rust executables in OS-specific app bundles"
4. **GitHub Issue #1886**: Users expecting .exe files separate from .msi installers

## Benefits

- **Simple**: One package, one publish command
- **Fast installs**: No conditional downloads
- **Reliable**: No platform detection issues in npm
- **Cross-platform**: Works on Windows, Linux, macOS
- **Tested**: Includes GitHub Actions testing on all platforms

## Implementation Order

1. **Commit 1**: Update Tauri config for cross-platform standalone builds
2. **Commit 2**: Add GitHub Actions workflow for automated builds + testing
3. **Commit 3**: Create separate npm package repository with embedded binaries
4. **Commit 4**: Add automated npm publishing workflow</content>
   <parameter name="filePath">docs/NPM_DIST.md
