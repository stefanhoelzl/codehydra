---
status: COMPLETE
last_updated: 2025-12-17
reviewers: [review-arch, review-typescript, review-testing, review-docs]
---

# BINARY_DISTRIBUTION

## Overview

- **Problem**: CodeHydra relies on code-server and opencode being pre-installed or available as devDependencies. This creates friction for users and complicates deployment.
- **Solution**: Download code-server and opencode binaries from GitHub releases during `npm install` (for development) and during the setup phase (for production). Share the same download logic between both paths. Create wrapper scripts in `app-data/bin/` that redirect to the downloaded binaries.
- **Risks**:
  - Network failures during download (mitigated: existing setup retry mechanism)
  - GitHub rate limiting (mitigated: downloads are infrequent, only on install/setup)
  - Large download sizes (~100MB+) (acceptable: one-time cost)
- **Alternatives Considered**:
  - Bundle binaries in the Electron app (rejected: increases app size significantly, complicates updates)
  - Keep as devDependencies (rejected: doesn't work for production builds)
  - Use system PATH binaries (rejected: requires manual installation)

## User Approvals

| Item                                    | Type                                                 | Status      |
| --------------------------------------- | ---------------------------------------------------- | ----------- |
| `ArchiveExtractor`                      | New boundary interface                               | ✅ Approved |
| `VscodeSetupService` constructor change | API change (adds `BinaryDownloadService` dependency) | ✅ Approved |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Binary Download Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  npm install                          App Setup (Production)                │
│       │                                      │                              │
│       v                                      v                              │
│  ┌─────────────────┐                 ┌─────────────────┐                    │
│  │ postinstall     │                 │ VscodeSetup     │                    │
│  │ script (tsx)    │                 │ Service         │                    │
│  └────────┬────────┘                 └────────┬────────┘                    │
│           │                                   │                             │
│           └───────────────┬───────────────────┘                             │
│                           │                                                 │
│                           v                                                 │
│              ┌────────────────────────┐                                     │
│              │ BinaryDownloadService  │  (shared download logic)            │
│              │  - isInstalled()       │                                     │
│              │  - download()          │                                     │
│              │  - getBinaryPath()     │                                     │
│              │  - createWrapperScripts()                                    │
│              └───────────┬────────────┘                                     │
│                          │                                                  │
│           ┌──────────────┼──────────────┐                                   │
│           │              │              │                                   │
│           v              v              v                                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                            │
│  │ HttpClient  │ │ FileSystem  │ │ Archive     │                            │
│  │ (fetch)     │ │ Layer       │ │ Extractor   │                            │
│  └─────────────┘ └─────────────┘ └─────────────┘                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Storage Layout:
┌─────────────────────────────────────────────────────────────────────────────┐
│ <app-data>/                                                                 │
│ ├── bin/                          (wrapper scripts)                         │
│ │   ├── code-server[.cmd]         → redirects to code-server/<ver>/bin/...  │
│ │   ├── opencode[.cmd]            → redirects to opencode/<ver>/opencode    │
│ │   └── code[.cmd]                (existing - VS Code remote CLI)           │
│ ├── code-server/                                                            │
│ │   └── <version>/                (e.g., 4.106.3/)                          │
│ │       ├── bin/                                                            │
│ │       │   └── code-server[.cmd]                                           │
│ │       ├── lib/                                                            │
│ │       │   ├── node[.exe]        (Windows only - bundled Node.js)          │
│ │       │   └── vscode/                                                     │
│ │       └── out/                                                            │
│ │           └── node/                                                       │
│ │               └── entry.js                                                │
│ ├── opencode/                                                               │
│ │   └── <version>/                (e.g., 0.1.47/)                           │
│ │       └── opencode[.exe]                                                  │
│ └── vscode/                       (existing - VS Code user data)            │
└─────────────────────────────────────────────────────────────────────────────┘

Wrapper Script Flow:
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  User runs:  app-data/bin/code-server --port 8080                           │
│                    │                                                        │
│                    v                                                        │
│  Wrapper script redirects to:                                               │
│    app-data/code-server/4.106.3/bin/code-server --port 8080                 │
│                                                                             │
│  User runs:  app-data/bin/opencode                                          │
│                    │                                                        │
│                    v                                                        │
│  Wrapper script redirects to:                                               │
│    app-data/opencode/0.1.47/opencode                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Phase 1: Core Download Infrastructure

- [x] **Step 1: Add dependencies for archive extraction**
  - Add `tar` package for `.tar.gz` extraction (macOS/Linux/Windows-opencode)
  - Add `yauzl` package for `.zip` extraction (Windows code-server)
  - Add `tsx` as devDependency for running TypeScript scripts
  - Files affected: `package.json`
  - Test criteria: Dependencies install successfully

- [x] **Step 2: Create error types for binary download**
  - Create `src/services/binary-download/errors.ts` with error types
  - Define `BinaryDownloadError` extending `ServiceError` with codes: `NETWORK_ERROR`, `EXTRACTION_FAILED`, `UNSUPPORTED_PLATFORM`, `INVALID_VERSION`
  - Define `ArchiveError` extending `ServiceError` with codes: `INVALID_ARCHIVE`, `EXTRACTION_FAILED`, `PERMISSION_DENIED`
  - Update `src/services/errors.ts` to include new error types in `SerializedError.type` union
  - Files affected:
    - `src/services/binary-download/errors.ts` (new)
    - `src/services/errors.ts`
  - Test criteria: Unit tests verify error creation and serialization

- [x] **Step 3: Create binary version constants and types**
  - Create `src/services/binary-download/versions.ts` with hardcoded versions
  - Define `CODE_SERVER_VERSION` and `OPENCODE_VERSION` constants
  - Define `BinaryType` as `'code-server' | 'opencode'`
  - Define `SupportedArch` as `'x64' | 'arm64'`
  - Define `SupportedPlatform` as `'darwin' | 'linux' | 'win32'`
  - Use discriminated union `BinaryConfig` for type-safe binary configuration
  - Use `satisfies` operator for configuration objects
  - Throw runtime error for unsupported Windows ARM64
  - Create `src/services/binary-download/types.ts` with `DownloadProgress`, callback types, etc.
  - Files affected:
    - `src/services/binary-download/versions.ts` (new)
    - `src/services/binary-download/types.ts` (new)
  - Test criteria: Unit tests verify URL generation for all valid platform combinations, error for invalid combinations

- [x] **Step 4: Create ArchiveExtractor interface and implementation**
  - Create interface with documented error contract:
    ```typescript
    interface ArchiveExtractor {
      /** @throws ArchiveError on failure */
      extract(archivePath: string, destDir: string): Promise<void>;
    }
    ```
  - Implement `TarExtractor` using `tar` package
  - Implement `ZipExtractor` using `yauzl` package
  - Create `DefaultArchiveExtractor` that selects based on file extension
  - Create mock factory for testing: `createMockArchiveExtractor()`
  - Files affected:
    - `src/services/binary-download/archive-extractor.ts` (new)
    - `src/services/binary-download/archive-extractor.test.ts` (new)
    - `src/services/binary-download/archive-extractor.test-utils.ts` (new)
    - `src/services/binary-download/archive-extractor.boundary.test.ts` (new)
  - Test criteria:
    - Unit tests with mocked dependencies
    - Boundary tests extract real archives

- [x] **Step 5: Update PlatformInfo to include architecture**
  - Add `arch` property to `PlatformInfo` interface: `SupportedArch` (from types.ts)
  - Update `NodePlatformInfo` to detect architecture via `process.arch`
  - Throw clear error for unsupported architectures (`ia32`, `arm`, `ppc64`, etc.):
    ```typescript
    throw new Error(`Unsupported architecture: ${arch}. CodeHydra requires x64 or arm64.`);
    ```
  - Update mock factory `createMockPlatformInfo()` to include arch
  - Files affected:
    - `src/services/platform/platform-info.ts`
    - `src/services/platform/platform-info.test.ts`
  - Test criteria: Unit tests verify arch detection and error on unsupported arch

- [x] **Step 6: Create BinaryDownloadService**
  - Create interface with complete method signatures:

    ```typescript
    interface BinaryDownloadService {
      /** Check if binary is installed at correct version */
      isInstalled(binary: BinaryType): Promise<boolean>;

      /** Download and extract binary. Throws BinaryDownloadError on failure. */
      download(binary: BinaryType, onProgress?: DownloadProgressCallback): Promise<void>;

      /** Get absolute path to binary executable (in versioned directory) */
      getBinaryPath(binary: BinaryType): string;

      /** Create wrapper scripts in binDir for all binaries */
      createWrapperScripts(): Promise<void>;
    }
    ```

  - Use injected `HttpClient`, `FileSystemLayer`, `ArchiveExtractor`, `PathProvider`, `PlatformInfo`
  - Implement streaming download to temporary file in `os.tmpdir()`, then extract
  - Ensure cleanup of temp files in finally block to prevent leaks on error
  - Handle platform/architecture detection via `PlatformInfo`
  - Select correct GitHub release URL based on binary type and platform
  - Create wrapper scripts in `binDir` that redirect to actual binaries
  - Files affected:
    - `src/services/binary-download/binary-download-service.ts` (new)
    - `src/services/binary-download/binary-download-service.test.ts` (new)
    - `src/services/binary-download/binary-download-service.test-utils.ts` (new)
    - `src/services/binary-download/index.ts` (new)
  - Test criteria: Unit tests verify download logic, URL selection, wrapper script generation, temp file cleanup

- [x] **Step 7: Create test utilities module**
  - Create `src/services/binary-download/test-utils.ts` with helpers:
    - `createTestTarGz(files: Record<string, string>): Promise<Buffer>` - generate test tar.gz
    - `createTestZip(files: Record<string, string>): Promise<Buffer>` - generate test zip
    - `mockGitHubReleaseResponse(assets: Asset[]): Response` - consistent API mocking
  - Files affected:
    - `src/services/binary-download/test-utils.ts` (new)
    - `src/services/binary-download/test-utils.test.ts` (new)
  - Test criteria: Helper functions work correctly

- [x] **Step 8: Create boundary tests for BinaryDownloadService**
  - Test actual downloads from GitHub releases (use HEAD requests to verify URLs)
  - Test archive extraction with real small test archives
  - Files affected:
    - `src/services/binary-download/binary-download-service.boundary.test.ts` (new)
  - Test criteria: Boundary tests pass with real network/filesystem

### Phase 2: Integration with npm install

- [x] **Step 9: Create postinstall download script**
  - Create `scripts/download-binaries.ts`
  - Instantiate real implementations of all interfaces
  - Use project-local `app-data/` directory (same as production uses in dev mode)
  - Call `BinaryDownloadService.download()` for code-server and opencode
  - Call `BinaryDownloadService.createWrapperScripts()` to create bin wrappers
  - Skip if binaries already present at correct version
  - Output progress to console: "Setting up code-server..." / "Setting up opencode..."
  - Files affected:
    - `scripts/download-binaries.ts` (new)
  - Test criteria: Script runs successfully via `tsx`

- [x] **Step 10: Update package.json postinstall**
  - Chain existing `patch-package` with new download script
  - Update postinstall: `"postinstall": "patch-package && tsx scripts/download-binaries.ts"`
  - Files affected: `package.json`
  - Test criteria: `npm install` downloads binaries automatically

- [x] **Step 11: Remove code-server and opencode-ai from devDependencies**
  - Remove `"code-server": "*"` from devDependencies
  - Remove `"opencode-ai": "*"` from devDependencies
  - Files affected: `package.json`
  - Test criteria: `npm install` succeeds without these packages

### Phase 3: Integration with App Setup and PathProvider

- [x] **Step 12: Update PathProvider with binary paths**
  - Add `codeServerDir` property: `<dataRoot>/code-server/<version>/`
  - Add `opencodeDir` property: `<dataRoot>/opencode/<version>/`
  - Add `codeServerBinaryPath` property: absolute path to actual binary (not wrapper)
  - Add `opencodeBinaryPath` property: absolute path to actual binary (not wrapper)
  - Import versions from `binary-download/versions.ts`
  - Example outputs:
    - Dev macOS: `codeServerDir` → `./app-data/code-server/4.106.3/`
    - Prod macOS: `codeServerDir` → `~/Library/Application Support/Codehydra/code-server/4.106.3/`
  - Files affected:
    - `src/services/platform/path-provider.ts`
    - `src/services/platform/path-provider.test.ts`
  - Test criteria: Unit tests verify correct paths for all platforms

- [x] **Step 13: Integrate BinaryDownloadService into VscodeSetupService**
  - **Requires approval**: Add `BinaryDownloadService` as constructor dependency
  - Add binary download as first steps in `setup()` method (before extension install)
  - Report progress via existing callback: "Setting up code-server...", "Setting up opencode..."
  - Download errors are surfaced through the same progress callback, allowing existing retry UI to handle failures
  - Create wrapper scripts after download completes
  - Skip download if binaries already installed (check version match)
  - Increment `CURRENT_SETUP_VERSION` to force re-setup for existing installations
  - **Note**: Incrementing CURRENT_SETUP_VERSION will cause all existing installations to re-run setup on next launch. Users will see the setup progress screen again.
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - `src/services/vscode-setup/vscode-setup-service.test.ts`
    - `src/services/vscode-setup/types.ts` (increment `CURRENT_SETUP_VERSION`)
  - Test criteria: Unit tests verify download integration

- [x] **Step 14: Update main process to use downloaded binaries**
  - Update `bootstrap()` to get `codeServerBinaryPath` from `PathProvider` (absolute path)
  - Remove development-mode fallback to `node_modules/code-server`
  - Pass absolute binary path to `CodeServerManager` - do NOT rely on PATH resolution
  - Instantiate `BinaryDownloadService` with real implementations
  - Pass `BinaryDownloadService` to `VscodeSetupService`
  - Files affected:
    - `src/main/index.ts`
  - Test criteria: App launches and uses downloaded binaries via absolute paths

- [x] **Step 15: Update VscodeSetupService opencode resolution**
  - If `require.resolve("opencode-ai")` exists, remove this fallback
  - Use `PathProvider.opencodeBinaryPath` for wrapper script target
  - The wrapper script in `binDir` already points to the correct binary
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - `src/services/vscode-setup/vscode-setup-service.test.ts`
  - Test criteria: Unit tests verify correct opencode path resolution

### Phase 4: Cleanup and Validation

- [x] **Step 16: Create integration tests**
  - Create `src/services/binary-download/binary-download-service.integration.test.ts`
  - Test multi-component flows: BinaryDownloadService + ArchiveExtractor + FileSystemLayer
  - Use real FileSystemLayer but mocked HttpClient
  - Test download → extract → verify flow
  - Files affected:
    - `src/services/binary-download/binary-download-service.integration.test.ts` (new)
  - Test criteria: Integration tests pass

- [x] **Step 17: Update existing integration tests**
  - Ensure integration tests work with downloaded binaries
  - Update any test setup that assumed node_modules binaries
  - Files affected: Various integration test files as needed
  - Test criteria: All integration tests pass

- [x] **Step 18: Update documentation**
  - Update `AGENTS.md`:
    - Update "CLI Wrapper Scripts" section to document versioned directory structure
    - Remove references to code-server/opencode as devDependencies
    - Add note that binaries are downloaded from GitHub releases during `npm install`
    - Document `<app-data>/code-server/<version>/` and `<app-data>/opencode/<version>/` paths
  - Update `docs/ARCHITECTURE.md`:
    - Add "Binary Distribution" section explaining download flow
    - Update "VS Code Setup" section to explain binary downloads happen before extension installation
    - Update directory structure diagrams to show versioned binary directories
  - Files affected:
    - `AGENTS.md`
    - `docs/ARCHITECTURE.md`
  - Test criteria: Documentation accurately reflects new behavior

- [x] **Step 19: Run full validation**
  - Run `npm run validate:fix`
  - Fix any issues that arise
  - Test manual app startup and setup flow
  - Files affected: Various (fixes)
  - Test criteria: `npm run validate:fix` passes, app works end-to-end

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                             | Description                                      | File                              |
| ----------------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `BinaryDownloadError serializes correctly`            | Verify error extends ServiceError                | `errors.test.ts`                  |
| `ArchiveError serializes correctly`                   | Verify error extends ServiceError                | `errors.test.ts`                  |
| `generates correct URLs for darwin-x64`               | Verify code-server URL for macOS Intel           | `versions.test.ts`                |
| `generates correct URLs for darwin-arm64`             | Verify code-server URL for macOS Apple Silicon   | `versions.test.ts`                |
| `generates correct URLs for linux-x64`                | Verify code-server URL for Linux x64             | `versions.test.ts`                |
| `generates correct URLs for linux-arm64`              | Verify code-server URL for Linux ARM64           | `versions.test.ts`                |
| `generates correct URLs for win32-x64`                | Verify code-server URL for Windows               | `versions.test.ts`                |
| `throws on win32-arm64`                               | Verify error for unsupported Windows ARM64       | `versions.test.ts`                |
| `generates correct opencode URLs`                     | Verify opencode URLs for all platforms           | `versions.test.ts`                |
| `TarExtractor calls tar.extract`                      | Mock tar module, verify correct options          | `archive-extractor.test.ts`       |
| `TarExtractor throws ArchiveError on corrupt archive` | Verify error handling                            | `archive-extractor.test.ts`       |
| `ZipExtractor extracts all entries`                   | Mock yauzl, verify extraction flow               | `archive-extractor.test.ts`       |
| `ZipExtractor throws ArchiveError on corrupt archive` | Verify error handling                            | `archive-extractor.test.ts`       |
| `selects TarExtractor for .tar.gz`                    | DefaultArchiveExtractor routes correctly         | `archive-extractor.test.ts`       |
| `selects ZipExtractor for .zip`                       | DefaultArchiveExtractor routes correctly         | `archive-extractor.test.ts`       |
| `downloads with progress callback`                    | Mock HTTP, verify progress is reported           | `binary-download-service.test.ts` |
| `throws BinaryDownloadError on HTTP 404`              | Verify network error handling                    | `binary-download-service.test.ts` |
| `throws BinaryDownloadError on network timeout`       | Verify timeout handling                          | `binary-download-service.test.ts` |
| `throws BinaryDownloadError on unsupported platform`  | Verify platform validation                       | `binary-download-service.test.ts` |
| `cleans up temp file on extraction failure`           | Verify cleanup in finally block                  | `binary-download-service.test.ts` |
| `skips download if version matches`                   | Returns early when isInstalled returns true      | `binary-download-service.test.ts` |
| `selects correct platform asset`                      | Verify platform/arch detection and URL selection | `binary-download-service.test.ts` |
| `creates wrapper scripts for Unix`                    | Verify shell script content and shebang          | `binary-download-service.test.ts` |
| `creates wrapper scripts for Windows`                 | Verify batch script content                      | `binary-download-service.test.ts` |
| `PathProvider returns codeServerDir`                  | Verify path includes version                     | `path-provider.test.ts`           |
| `PathProvider returns codeServerBinaryPath`           | Verify absolute binary path                      | `path-provider.test.ts`           |
| `PathProvider returns opencodeBinaryPath`             | Verify absolute binary path                      | `path-provider.test.ts`           |
| `PlatformInfo detects x64 arch`                       | Verify arch detection                            | `platform-info.test.ts`           |
| `PlatformInfo detects arm64 arch`                     | Verify arch detection                            | `platform-info.test.ts`           |
| `PlatformInfo throws on unsupported arch`             | Verify error for ia32, arm, etc.                 | `platform-info.test.ts`           |
| `VscodeSetupService downloads binaries first`         | Mock service, verify order                       | `vscode-setup-service.test.ts`    |
| `VscodeSetupService creates wrapper scripts`          | Mock service, verify called                      | `vscode-setup-service.test.ts`    |

### Integration Tests (vitest)

| Test Case                                    | Description                              | File                                          |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| `download and extract flow`                  | Real FileSystemLayer + mocked HttpClient | `binary-download-service.integration.test.ts` |
| `wrapper scripts are executable`             | Verify scripts have correct permissions  | `binary-download-service.integration.test.ts` |
| `VscodeSetupService + BinaryDownloadService` | Full setup flow with mocked HTTP         | `vscode-setup-service.integration.test.ts`    |

### Boundary Tests (vitest)

| Test Case                          | Description                  | File                                       |
| ---------------------------------- | ---------------------------- | ------------------------------------------ |
| `extracts real tar.gz archive`     | Extract a test tar.gz file   | `archive-extractor.boundary.test.ts`       |
| `extracts real zip archive`        | Extract a test zip file      | `archive-extractor.boundary.test.ts`       |
| `code-server release URL is valid` | HEAD request returns 200/302 | `binary-download-service.boundary.test.ts` |
| `opencode release URL is valid`    | HEAD request returns 200/302 | `binary-download-service.boundary.test.ts` |

### Manual Testing Checklist

- [ ] Fresh clone: `npm install` downloads both binaries
- [ ] Second `npm install`: binaries are skipped (already present)
- [ ] Verify wrapper scripts exist in `app-data/bin/`
- [ ] `app-data/bin/code-server --version` works
- [ ] `app-data/bin/opencode --version` works
- [ ] Delete `app-data/code-server/`: `npm install` re-downloads
- [ ] App startup: setup phase downloads binaries if missing
- [ ] App startup: setup skips download if binaries present
- [ ] code-server launches successfully from wrapper script
- [ ] opencode CLI wrapper works in terminal (inside code-server)
- [ ] Test on macOS (tar.gz extraction, both Intel and Apple Silicon if possible)
- [ ] Test on Linux (tar.gz extraction)
- [ ] Test on Windows (zip extraction for code-server, tar.gz for opencode)

## Dependencies

| Package        | Purpose                                           | Approved |
| -------------- | ------------------------------------------------- | -------- |
| `tar`          | Extract `.tar.gz` archives                        | ✅       |
| `yauzl`        | Extract `.zip` archives (Windows code-server)     | ✅       |
| `tsx`          | Run TypeScript postinstall script (devDependency) | ✅       |
| `@types/yauzl` | TypeScript types for yauzl (devDependency)        | ✅       |

## Documentation Updates

### Files to Update

| File                   | Section                   | Changes Required                                                             |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `AGENTS.md`            | CLI Wrapper Scripts       | Document versioned directory structure (`<app-data>/code-server/<version>/`) |
| `AGENTS.md`            | Dev Dependencies          | Remove references to code-server/opencode as devDependencies                 |
| `AGENTS.md`            | Binary Distribution (new) | Add note that binaries are downloaded from GitHub releases                   |
| `docs/ARCHITECTURE.md` | Binary Distribution (new) | Add section explaining download flow and wrapper scripts                     |
| `docs/ARCHITECTURE.md` | VS Code Setup             | Explain binary downloads happen before extension installation                |
| `docs/ARCHITECTURE.md` | Directory Structure       | Update diagrams to show versioned binary directories                         |

### New Documentation Required

| File | Purpose                              |
| ---- | ------------------------------------ |
| None | Existing docs cover the updated flow |

## Configuration Constants

```typescript
// src/services/binary-download/types.ts

export type BinaryType = "code-server" | "opencode";
export type SupportedArch = "x64" | "arm64";
export type SupportedPlatform = "darwin" | "linux" | "win32";

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number | null; // null if Content-Length not provided
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface BinaryConfig {
  readonly type: BinaryType;
  readonly version: string;
  readonly getUrl: (platform: SupportedPlatform, arch: SupportedArch) => string;
  readonly extractedBinaryPath: (platform: SupportedPlatform) => string;
}
```

```typescript
// src/services/binary-download/versions.ts

import type { BinaryConfig, BinaryType, SupportedArch, SupportedPlatform } from "./types.js";

export const CODE_SERVER_VERSION = "4.106.3";
export const OPENCODE_VERSION = "0.1.47"; // TODO: verify current version from sst/opencode releases

// GitHub repository for Windows code-server builds
const CODEHYDRA_REPO = "stefanhoelzl/codehydra";

// Architecture name mappings
const CODE_SERVER_ARCH = { x64: "amd64", arm64: "arm64" } as const;
const OPENCODE_ARCH = { x64: "x86_64", arm64: "aarch64" } as const;

function getCodeServerUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows code-server builds only support x64, got: ${arch}`);
    }
    return `https://github.com/${CODEHYDRA_REPO}/releases/download/code-server-windows-v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-win32-x64.zip`;
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const archName = CODE_SERVER_ARCH[arch];
  return `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${os}-${archName}.tar.gz`;
}

function getOpencodeUrl(platform: SupportedPlatform, arch: SupportedArch): string {
  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(`Windows opencode builds only support x64, got: ${arch}`);
    }
    return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode_x86_64_pc-windows-msvc.tar.gz`;
  }
  const archName = OPENCODE_ARCH[arch];
  const os = platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  return `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}/opencode_${archName}_${os}.tar.gz`;
}

export const BINARY_CONFIGS = {
  "code-server": {
    type: "code-server",
    version: CODE_SERVER_VERSION,
    getUrl: getCodeServerUrl,
    extractedBinaryPath: (platform: SupportedPlatform) =>
      platform === "win32" ? "bin/code-server.cmd" : "bin/code-server",
  },
  opencode: {
    type: "opencode",
    version: OPENCODE_VERSION,
    getUrl: getOpencodeUrl,
    extractedBinaryPath: (platform: SupportedPlatform) =>
      platform === "win32" ? "opencode.exe" : "opencode",
  },
} as const satisfies Record<BinaryType, BinaryConfig>;
```

```typescript
// src/services/binary-download/errors.ts

import { ServiceError } from "../errors.js";

export type BinaryDownloadErrorCode =
  | "NETWORK_ERROR"
  | "EXTRACTION_FAILED"
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_VERSION";

export class BinaryDownloadError extends ServiceError {
  readonly type = "binary-download" as const;
  constructor(
    message: string,
    readonly errorCode: BinaryDownloadErrorCode
  ) {
    super(message, errorCode);
  }
}

export type ArchiveErrorCode = "INVALID_ARCHIVE" | "EXTRACTION_FAILED" | "PERMISSION_DENIED";

export class ArchiveError extends ServiceError {
  readonly type = "archive" as const;
  constructor(
    message: string,
    readonly errorCode: ArchiveErrorCode
  ) {
    super(message, errorCode);
  }
}
```

## Wrapper Script Templates

```bash
# Unix wrapper script template (code-server)
#!/bin/sh
exec "<app-data>/code-server/<version>/bin/code-server" "$@"

# Unix wrapper script template (opencode)
#!/bin/sh
exec "<app-data>/opencode/<version>/opencode" "$@"
```

```batch
@rem Windows wrapper script template (code-server)
@echo off
"<app-data>\code-server\<version>\bin\code-server.cmd" %*

@rem Windows wrapper script template (opencode)
@echo off
"<app-data>\opencode\<version>\opencode.exe" %*
```

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
