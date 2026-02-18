# Release Workflow

## Version Format

| Component  | Release               | Development                      |
| ---------- | --------------------- | -------------------------------- |
| App        | `YYYY.MM.DD`          | `{date}-dev.{hash}[-dirty]`      |
| Extensions | `{major}.{commits}.0` | `{major}.{commits}.0-dev.{hash}` |

App version injected via Vite define (`__APP_VERSION__`) and logged on startup.
Extension versions use valid SemVer format (required by VS Code).

The `-dirty` suffix only appears in local dev builds when there are uncommitted changes.

## Triggering a Release

1. Go to **Actions** > **Release**
2. Click **Run workflow**

Summary and artifacts appear on the workflow run page.

## Auto-Update Requirements

CodeHydra uses `electron-updater` to automatically check for and apply updates from GitHub Releases.

### Supported Platforms

| Platform         | Auto-Update | Notes                                  |
| ---------------- | ----------- | -------------------------------------- |
| Windows (NSIS)   | Yes         | Installer downloaded and runs on quit  |
| macOS (DMG)      | Yes         | App bundle replaced on quit            |
| Linux (AppImage) | Yes         | AppImage replaced on quit              |
| Windows (dir)    | No          | Portable build, manual update required |
| Linux (.deb/rpm) | No          | Package manager handles updates        |

### Release Configuration

electron-builder automatically generates required metadata files:

- `latest.yml` (Windows)
- `latest-mac.yml` (macOS)
- `latest-linux.yml` (Linux)

**Important**: Releases must be **published** (not draft) for auto-update to detect them.

### Code Signing

| Platform | Requirement               | Impact                                                         |
| -------- | ------------------------- | -------------------------------------------------------------- |
| macOS    | Ad-hoc signed (rcodesign) | No Gatekeeper bypass; users right-click → Open on first launch |
| Windows  | Recommended               | SmartScreen may warn on unsigned installs                      |
| Linux    | Not required              | AppImages run without signatures                               |

### Behavior

- Checks once per day (24-hour interval)
- Downloads in background if update available
- Title bar shows "(X.Y.Z update available)" when ready
- Update applies automatically on next app quit
- First check delayed 10 seconds to avoid startup I/O contention

### Prerequisites

Releases can only be triggered from commits on the `main` branch. Branch protection ensures all commits have passed CI before merge, so no additional CI check is performed during release.

**Required branch protection settings for `main`:**

- Require status checks to pass before merging
- Required checks: `validate (ubuntu-24.04)`, `validate (windows-2025)`, `build`

## Artifacts

| Platform | Artifact Name                            |
| -------- | ---------------------------------------- |
| Windows  | `CodeHydra-{version}-win`                |
| Linux    | `CodeHydra-{version}-linux-x64.AppImage` |

## Changing Extension Major Version

To reset the extension version scheme (e.g., after breaking changes):

1. Edit `extensions/<name>/package.json`
2. Change `"version": "1.0.0-placeholder"` to `"version": "2.0.0-placeholder"`
3. Next build will produce `2.{commits}.0`

---

## npm and PyPI Publishing

The release workflow automatically publishes launcher packages to npm and PyPI after creating the GitHub Release. These launcher packages download the appropriate platform binary on first run.

### npm Package

- **Package name**: `codehydra`
- **Registry**: https://www.npmjs.com/package/codehydra
- **Usage**: `npx codehydra`

### PyPI Package

- **Package name**: `codehydra`
- **Registry**: https://pypi.org/project/codehydra/
- **Usage**: `uvx codehydra` or `pip install codehydra && codehydra`

### Trusted Publisher Setup

Both packages use OIDC trusted publishing for secure, token-free deployments.

#### npm Setup (one-time)

1. Create the initial package manually:

   ```bash
   cd packages/npm
   pnpm publish --access public
   ```

2. Configure trusted publisher at https://www.npmjs.com/package/codehydra/access:
   - Scroll to "Trusted Publishers" section
   - Click "Add GitHub Actions"
   - **Owner**: `stefanhoelzl`
   - **Repository**: `codehydra`
   - **Workflow filename**: `release.yaml`
   - **Environment**: (leave empty)

3. Recommended: Enable "Require two-factor authentication"

#### PyPI Setup (one-time)

1. Go to https://pypi.org/manage/account/publishing/

2. Add a pending publisher:
   - Click "Add a new pending publisher"
   - Select "GitHub Actions"
   - **PyPI Project Name**: `codehydra`
   - **Owner**: `stefanhoelzl`
   - **Repository name**: `codehydra`
   - **Workflow name**: `release.yaml`
   - **Environment name**: (leave empty)

The pending publisher automatically converts to a regular publisher on first successful publish.

---

## code-server Windows Builds

code-server doesn't publish Windows binaries. CodeHydra automatically builds and publishes Windows versions via GitHub Actions.

### Release Naming Convention

| Item           | Format                                | Example                             |
| -------------- | ------------------------------------- | ----------------------------------- |
| Git tag        | `code-server-windows-v{version}`      | `code-server-windows-v4.106.3`      |
| Release title  | `code-server {version} for Windows`   | `code-server 4.106.3 for Windows`   |
| Asset filename | `code-server-{version}-win32-x64.zip` | `code-server-4.106.3-win32-x64.zip` |

### Automation

- **Daily check**: `check-code-server-releases.yaml` runs at 6 AM UTC
- **Build trigger**: Automatically triggers builds for missing versions (>= 4.106.3)
- **Releases**: Published to GitHub Releases in this repository

### Package Layout

Matches official Linux/macOS releases:

```
code-server-{version}-win32-x64/
├── bin/
│   └── code-server.cmd       # Windows launcher script
├── lib/
│   ├── node.exe              # Bundled Node.js (downloaded for Windows)
│   └── vscode/               # VS Code distribution
├── out/
│   └── node/
│       └── entry.js          # Main entry point
├── package.json
├── LICENSE                   # MIT license from code-server
└── ThirdPartyNotices.txt     # Third-party licenses
```

### Manual Triggering

Both workflows support manual dispatch:

```bash
# Build a specific version (dry run for testing)
gh workflow run build-code-server-windows.yaml -f version="4.106.3" -f dry_run=true

# Check for missing versions (dry run)
gh workflow run check-code-server-releases.yaml -f dry_run=true
```
