---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-13
reviewers: [review-arch, review-quality, review-testing, review-ui]
---

# Publish CodeHydra to npm and PyPI

## Overview

- **Problem**: Users cannot easily install and run CodeHydra without manually downloading binaries from GitHub Releases. Modern developers expect to run tools via `npx` or `uvx`.
- **Solution**: Create minimal launcher packages for npm and PyPI that download the appropriate platform binary on first run, cache it locally, and execute it with passed-through arguments.
- **Risks**:
  - Package names `codehydra` may be taken on npm/PyPI (mitigated: check availability first)
  - GitHub rate limiting for downloads (mitigated: unauthenticated limit of 60/hour sufficient; on rate limit errors show clear message with guidance to retry later or set `GITHUB_TOKEN` env var for 5000/hour)
- **Alternatives Considered**:
  - Platform-specific packages (esbuild pattern) - rejected due to ~200MB package sizes and complex CI
  - Pre-bundled binaries in packages - rejected for same reasons

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Release                           │
│  stefanhoelzl/codehydra/releases/download/v{version}/       │
│  CodeHydra-linux-x64.AppImage, CodeHydra-win-portable.zip   │
│  CodeHydra-darwin-x64.zip, CodeHydra-darwin-arm64.zip       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Download (first run only)
                              │ Show progress bar
                              │
┌──────────────────┐    ┌─────┴─────────┐    ┌────────────────┐
│   npm package    │    │  User cache   │    │  PyPI package  │
│   `codehydra`    │───▶│  .../releases │◀───│  `codehydra`   │
│   (2 files)      │    │               │    │  (2 files)     │
└──────────────────┘    └───────────────┘    └────────────────┘
         │                      │                    │
         ▼                      ▼                    ▼
    npx codehydra         cached binary        uvx codehydra
```

### Package Structure

```
packages/
├── npm/
│   ├── package.json      # Manifest with bin entry
│   └── codehydra.js      # Launcher script (~80 lines)
└── pypi/
    ├── pyproject.toml    # Manifest with scripts entry
    └── codehydra.py      # Launcher module (~80 lines)
```

### Cache Locations

| Platform | Cache Directory                                               |
| -------- | ------------------------------------------------------------- |
| Linux    | `~/.local/share/codehydra/releases/{version}/`                |
| macOS    | `~/Library/Application Support/Codehydra/releases/{version}/` |
| Windows  | `%LOCALAPPDATA%\Codehydra\releases\{version}\`                |

**Note**: The `releases/` subdirectory is managed exclusively by the launcher packages, separate from the main CodeHydra application's data directories (`projects/`, `workspaces/`, etc.).

### Download URL Mapping

| Platform + Arch | GitHub Release Asset             |
| --------------- | -------------------------------- |
| linux-x64       | `CodeHydra-linux-x64.AppImage`   |
| darwin-x64      | `CodeHydra-darwin-x64.zip`       |
| darwin-arm64    | `CodeHydra-darwin-arm64.zip`     |
| win32-x64       | `CodeHydra-win-portable-x64.zip` |

**Not supported**: linux-arm64, win32-arm64 (show clear error message with link to GitHub issues)

**URL pattern**: Hardcode `https://github.com/stefanhoelzl/codehydra/releases/download/v{version}/CodeHydra-{asset}` rather than querying GitHub API.

### Launcher Logic (both packages)

1. Determine package version (from package.json / importlib.metadata)
2. Determine platform and architecture
3. Check if binary exists in cache for this version
4. If not cached:
   - Show "Downloading CodeHydra {version}..."
   - Download from GitHub Releases with progress bar
     - If `Content-Length` header available: show percentage
     - If unknown: show bytes downloaded (e.g., "Downloaded 45 MB...")
     - Use atomic download: write to `.tmp` file, rename on success
     - Timeout: 5 minutes for download, 30 seconds for connection
   - Extract archive (zip) or copy directly (AppImage)
   - Set executable permissions (Unix)
   - On Linux with AppImage: may require FUSE; if execution fails, suggest `--appimage-extract-and-run`
5. Execute binary with all passed arguments

**Error handling**:

- Network failures: Retry up to 3 times with exponential backoff, then show clear error with manual download URL
- Rate limiting (HTTP 403): Show message to retry later or set `GITHUB_TOKEN` environment variable
- Corrupt/partial download: Clean up `.tmp` file, show error suggesting retry
- Unsupported platform: Show clear error with supported platforms list and link to GitHub issues

**macOS note**: Downloaded binaries may be quarantined by Gatekeeper. Users may need to right-click > Open or run `xattr -cr` on the binary.

**Version pinning**: Users can pin the npm/PyPI package version to control which CodeHydra version is downloaded (e.g., `npx codehydra@2025.1.13`).

## Testing Strategy

**Note**: These launcher packages are standalone scripts (~80 lines each) using only built-in Node.js/Python modules. They are external to the main TypeScript codebase and do not follow the project's abstraction layer patterns. Manual testing is appropriate for this scope.

### Manual Testing Checklist

**Happy path:**

- [ ] npm: `npm pack` in packages/npm, install locally, run `npx codehydra`
- [ ] npm: Verify download progress is shown on first run
- [ ] npm: Verify cached binary is used on subsequent runs
- [ ] npm: Verify arguments are passed through
- [ ] PyPI: `uv pip install .` in packages/pypi, run `codehydra`
- [ ] PyPI: Verify download progress is shown on first run
- [ ] PyPI: Verify cached binary is used on subsequent runs
- [ ] PyPI: Verify arguments are passed through

**Platform-specific:**

- [ ] Test on Linux (AppImage extraction)
- [ ] Test on macOS (zip extraction, Gatekeeper handling)
- [ ] Test on Windows (zip extraction)

**Error scenarios:**

- [ ] Test with network disconnected (should show clear error)
- [ ] Test with invalid version (should show 404 error with guidance)
- [ ] Test on unsupported platform (should show clear error)

## Prerequisites (User Setup)

Before the first release, configure OIDC trusted publishers on both platforms.

### npm Trusted Publisher Setup

Since the `codehydra` package doesn't exist yet on npm, you'll need to create it first:

1. **Create the package** (one-time):

   ```bash
   cd packages/npm
   pnpm publish --access public
   ```

   This requires an npm account and initial authentication.

2. **Configure trusted publisher** on npmjs.com:
   - Go to https://www.npmjs.com/package/codehydra/access
   - Scroll to "Trusted Publishers" section
   - Click "Add GitHub Actions"
   - Fill in:
     - **Owner**: `stefanhoelzl`
     - **Repository**: `codehydra`
     - **Workflow filename**: `release.yaml`
     - **Environment**: (leave empty)
   - Click "Add"

3. **Recommended security settings**:
   - Enable "Require two-factor authentication"
   - Consider enabling "Disallow tokens" after trusted publishing is confirmed working

**Note**: OIDC trusted publishing requires npm 10.0.0 or later.

### PyPI Trusted Publisher Setup

PyPI supports "pending publishers" for packages that don't exist yet:

1. **Go to** https://pypi.org/manage/account/publishing/

2. **Add a pending publisher**:
   - Click "Add a new pending publisher"
   - Select "GitHub Actions"
   - Fill in:
     - **PyPI Project Name**: `codehydra`
     - **Owner**: `stefanhoelzl`
     - **Repository name**: `codehydra`
     - **Workflow name**: `release.yaml`
     - **Environment name**: (leave empty or use `pypi` if using environments)
   - Click "Add"

3. **Note**: The pending publisher automatically converts to a regular publisher on first successful publish. The project name is NOT reserved until actually published.

## Implementation Steps

- [x] **Step 1: Create npm package**
  - Create `packages/npm/package.json` with name, bin entry, repository
  - Create `packages/npm/codehydra.js` with:
    - Platform/arch detection
    - Cache directory resolution
    - Download with progress (using fetch + streaming, atomic pattern)
    - Archive extraction (using built-in zlib)
    - Error handling (retry, cleanup, clear messages)
    - Binary execution with argument pass-through
  - Files: `packages/npm/package.json`, `packages/npm/codehydra.js`
  - Test: Manual local testing with `npm pack` and `npx`

- [x] **Step 2: Create PyPI package**
  - Create `packages/pypi/pyproject.toml` with name, scripts entry, hatchling backend
  - Create `packages/pypi/codehydra.py` with:
    - Platform/arch detection (platform module)
    - Cache directory resolution
    - Download with progress (urllib + custom progress, atomic pattern)
    - Archive extraction (zipfile module)
    - Error handling (retry, cleanup, clear messages)
    - Binary execution with argument pass-through (os.execv)
  - Files: `packages/pypi/pyproject.toml`, `packages/pypi/codehydra.py`
  - Test: Manual local testing with `uv pip install .` and `codehydra`

- [x] **Step 3: Update release workflow**
  - Add npm publish job with OIDC trusted publishing (no NPM_TOKEN needed)
    - Requires `id-token: write` permission
    - Use `pnpm version` for version injection, `pnpm publish` for publishing
    - **Must run AFTER GitHub Release is created** (so download URLs exist)
  - Add PyPI publish job with OIDC trusted publishing (no PYPI_TOKEN needed)
    - Requires `id-token: write` permission
    - Use official `pypa/gh-action-pypi-publish` action
    - Use `hatch version` for version injection, `uv build` for building
    - **Must run AFTER GitHub Release is created** (so download URLs exist)
  - Jobs can run in parallel with each other (no dependencies between npm and PyPI)
  - Files: `.github/workflows/release.yaml`
  - Test: Dry-run workflow locally or trigger test release

- [x] **Step 4: Update site**
  - Replace dev setup in `site/src/components/QuickStart.svelte` with user installation methods:
    - `npx codehydra` (Node.js users)
    - `uvx codehydra` (Python users)
    - Direct download links for each platform
  - Add link to GitHub Releases page (https://github.com/stefanhoelzl/codehydra/releases)
  - Remove existing developer setup instructions (clone, pnpm install, pnpm dev)
  - Files: `site/src/components/QuickStart.svelte`

- [x] **Step 5: Update documentation**
  - Add npm/PyPI installation instructions to README
  - Update docs/RELEASE.md with npm/PyPI trusted publishing section
  - Files: `README.md`, `docs/RELEASE.md`

## Dependencies

| Package               | Purpose                          | Approved |
| --------------------- | -------------------------------- | -------- |
| None for main project | Launcher packages are standalone | N/A      |

**npm package dependencies:** None (uses Node.js built-ins: https, fs, path, child_process, zlib)

**PyPI package dependencies:** None (uses Python built-ins: urllib, zipfile, platform, os, sys)

## Documentation Updates

### Files to Update

| File                                    | Changes Required                                                  |
| --------------------------------------- | ----------------------------------------------------------------- |
| `site/src/components/QuickStart.svelte` | Replace dev setup with user install methods + releases link       |
| `README.md`                             | Add installation section with `npx codehydra` and `uvx codehydra` |
| `docs/RELEASE.md`                       | Add npm/PyPI trusted publishing section, setup instructions       |

## Definition of Done

- [ ] `packages/npm/` contains working launcher
- [ ] `packages/pypi/` contains working launcher
- [ ] Release workflow publishes to npm and PyPI using OIDC trusted publishing
- [ ] Site updated with installation methods and releases link
- [ ] Manual testing passes on at least one platform
- [ ] Documentation updated (README, RELEASE.md)
- [ ] Trusted publishers configured on npmjs.com and pypi.org
- [ ] First release successfully publishes to npm and PyPI
