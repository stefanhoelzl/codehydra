---
status: CLEANUP
last_updated: 2026-01-01
reviewers: [review-typescript, review-arch, review-docs]
---

# RELEASES

## Overview

- **Problem**: No automated release process. Manual artifact creation is error-prone.
- **Solution**: On-demand workflow that builds versioned artifacts and uploads them to GitHub Actions.
- **Risks**:
  - Version conflicts if workflow runs multiple times per day (mitigated with build number suffix)
- **Alternatives Considered**:
  - **Modify package.json version**: Rejected - Vite define allows dynamic version from git without modifying tracked files
  - **Date-based extension versions**: Rejected - conflicts when extension changes twice same day

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Release Workflow (manual dispatch)                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           check job                                          │
│  - Verify CI passed for HEAD (combined commit status)                       │
│  - Generate app version (YYYY.MM.DD or YYYY.MM.DD.N)                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           build job (matrix)                                 │
│                                                                              │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐       │
│  │        ubuntu-24.04          │    │        windows-2025          │       │
│  │  builder: --linux AppImage   │    │  builder: --win dir          │       │
│  └──────────────────────────────┘    └──────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           summary job                                        │
│  - Write to $GITHUB_STEP_SUMMARY                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Version Strategy

### App Version

Computed at build time via Vite `define`. No package.json modification needed.

| Mode        | Format                                 | Example                         |
| ----------- | -------------------------------------- | ------------------------------- |
| Dev (clean) | `{commit-date}-dev.{short-hash}`       | `2026.01.15-dev.a1b2c3d4`       |
| Dev (dirty) | `{commit-date}-dev.{short-hash}-dirty` | `2026.01.15-dev.a1b2c3d4-dirty` |
| Release     | `YYYY.MM.DD` or `YYYY.MM.DD.N`         | `2026.01.15` or `2026.01.15.2`  |

**Note**: The `-dirty` suffix only appears in local dev builds. Release builds run on clean CI commits.

### Extension Version (SemVer with Commit Count)

Extensions have `"version": "1.0.0-placeholder"` in package.json (placeholder with major version prefix). Version injected at build time using valid SemVer format (required by VS Code).

| Mode    | Format                           | Example               |
| ------- | -------------------------------- | --------------------- |
| Dev     | `{major}.{commits}.0-dev.{hash}` | `1.47.0-dev.a1b2c3d4` |
| Release | `{major}.{commits}.0`            | `1.47.0`              |

**Future-proof**: Bump major to `2` to reset the scheme without conflicts.

## Implementation Steps

- [x] **Step 1: Add app version via Vite define**
  - Add `getAppVersion()` function to `electron.vite.config.ts`
  - Define `__APP_VERSION__` constant for main and renderer
  - Add TypeScript declaration to `src/env.d.ts`
  - Files affected: `electron.vite.config.ts`, `src/env.d.ts`
  - Test criteria: `npm run build` injects correct version
  - See "App Version Implementation" section below

- [x] **Step 2: Log version on startup**
  - Log `__APP_VERSION__` at the start of main process bootstrap
  - Files affected: `src/main/index.ts` (in bootstrap function, after logger init)
  - Test criteria: Version appears in logs on app start

- [x] **Step 3: Update extension versions to major-only**
  - Change extension `"version"` to `"1.0.0-placeholder"` (placeholder with major version)
  - Update `build-extensions.ts` to inject version (see "Extension Version Injection" section below)
  - Files affected:
    - `extensions/sidekick/package.json`
    - `extensions/dictation/package.json`
    - `scripts/build-extensions.ts`
  - Test criteria: Manual verification

- [x] **Step 4: Create release workflow**
  - Create `.github/workflows/release.yaml` (see "Release Workflow" section below)
  - Files affected: `.github/workflows/release.yaml` (new)
  - Test criteria: Workflow shows summary and uploads artifacts

- [x] **Step 5: Update artifact naming in electron-builder**
  - Add `artifactName` to AppImage config for consistent naming
  - Files affected: `electron-builder.yaml`
  - Changes:
    ```yaml
    appImage:
      artifactName: ${productName}-${version}-linux-x64.${ext}
    ```
  - Test criteria: Linux artifact named `CodeHydra-{version}-linux-x64.AppImage`

- [x] **Step 6: Create documentation**
  - Create `docs/RELEASE.md` (see "Documentation" section below)
  - Add "Release Workflow" section to `AGENTS.md` after "VS Code Assets" section
  - Files affected: `docs/RELEASE.md` (new), `AGENTS.md`
  - Test criteria: Documentation is accurate

## Testing Strategy

No automated tests. Manual verification only.

### Manual Testing Checklist

- [ ] `npm run dev` - version logged on startup
- [ ] `npm run build` - `__APP_VERSION__` has git-based version
- [ ] Dirty working tree shows `-dirty` suffix
- [ ] `VERSION=2026.01.15 npm run build` uses that version
- [ ] Extension hash same when code unchanged
- [ ] Extension hash different when code changed
- [ ] Extension manifest.json has valid SemVer versions
- [ ] Workflow shows summary in GitHub Actions UI
- [ ] Artifacts uploaded correctly
- [ ] Windows artifact works
- [ ] Linux AppImage works

## Dependencies

None.

## File Changes Summary

```
.github/workflows/
└── release.yaml            # NEW

scripts/
└── build-extensions.ts     # Add version injection

extensions/
├── sidekick/package.json   # version: "1"
└── dictation/package.json  # version: "1"

docs/
└── RELEASE.md              # NEW

src/
├── env.d.ts                # Add __APP_VERSION__ declaration
└── main/index.ts           # Log version on startup

electron.vite.config.ts     # Add __APP_VERSION__ define
electron-builder.yaml       # Update artifact naming
AGENTS.md                   # Add Release Workflow section after VS Code Assets
```

## App Version Implementation

```typescript
// electron.vite.config.ts
import { execSync } from "node:child_process";

function getAppVersion(): string {
  if (process.env.VERSION) return process.env.VERSION;

  // Git commands will fail if not in a git repo - this is intentional
  // to catch misconfigured dev environments early
  const date = execSync("git log -1 --format=%cs", { encoding: "utf-8" }).trim().replace(/-/g, ".");
  const hash = execSync("git rev-parse --short=8 HEAD", { encoding: "utf-8" }).trim();
  const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim() ? "-dirty" : "";

  return `${date}-dev.${hash}${dirty}`;
}

// Add to main and renderer configs:
define: {
  __APP_VERSION__: JSON.stringify(getAppVersion());
}
```

```typescript
// src/env.d.ts
declare const __APP_VERSION__: string;
```

```typescript
// src/main/index.ts (in bootstrap function, after logger init)
logger.info(`CodeHydra ${__APP_VERSION__}`);
```

## Extension Version Injection

```typescript
// In scripts/build-extensions.ts

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

async function hashExtensionFolder(extDir: string): Promise<string> {
  const hash = createHash("sha256");
  async function processDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await processDir(fullPath);
      else if (entry.isFile()) {
        hash.update(fullPath.slice(extDir.length));
        hash.update(await readFile(fullPath));
      }
    }
  }
  await processDir(extDir);
  return hash.digest("hex").slice(0, 8);
}

function getCommitCount(extDir: string): string {
  // Will fail if git unavailable - intentional to catch dev env issues
  return execSync(`git rev-list --count HEAD -- "${extDir}"`, { encoding: "utf-8" }).trim();
}

async function getExtensionVersion(extDir: string, major: string): Promise<string> {
  const commits = getCommitCount(extDir);
  if (process.env.VERSION) {
    // Release: valid SemVer format required by VS Code
    return `${major}.${commits}.0`;
  }
  // Dev: SemVer with prerelease tag
  const hash = await hashExtensionFolder(extDir);
  return `${major}.${commits}.0-dev.${hash}`;
}
```

## Release Workflow

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      force:
        description: Skip CI status check
        type: boolean
        default: false

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-24.04
    outputs:
      should_build: ${{ steps.ci.outputs.passed }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - run: |
          if [[ "${{ inputs.force }}" == "true" ]]; then
            echo "passed=true" >> $GITHUB_OUTPUT
            echo "::warning::CI check skipped (force=true)"
            exit 0
          fi
          STATUS=$(gh api repos/${{ github.repository }}/commits/$(git rev-parse HEAD)/status --jq '.state')
          echo "passed=$([[ "$STATUS" = "success" ]] && echo true || echo false)" >> $GITHUB_OUTPUT
        id: ci
        env:
          GH_TOKEN: ${{ github.token }}

      - run: |
          TODAY=$(date -u +%Y.%m.%d)
          COUNT=$(gh run list --workflow=release.yaml --created=$(date -u +%Y-%m-%d) --json status --jq 'length')
          echo "version=$([[ "$COUNT" -le 1 ]] && echo "$TODAY" || echo "$TODAY.$COUNT")" >> $GITHUB_OUTPUT
        id: version
        if: steps.ci.outputs.passed == 'true'
        env:
          GH_TOKEN: ${{ github.token }}

  build:
    name: Build (${{ matrix.platform }})
    needs: check
    if: needs.check.outputs.should_build == 'true'
    strategy:
      matrix:
        include:
          - os: ubuntu-24.04
            platform: linux
            builder: --linux AppImage
          - os: windows-2025
            platform: win
            builder: --win dir
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - run: sudo apt-get update && sudo apt-get install -y libkrb5-dev
        if: runner.os == 'Linux'

      - run: echo "C:\Program Files\Git\bin" >> $env:GITHUB_PATH
        if: runner.os == 'Windows'

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci --force

      - run: for dir in extensions/*/; do (cd "$dir" && npm ci --force); done
        shell: bash

      - run: npm run build
        env:
          VERSION: ${{ needs.check.outputs.version }}

      - run: npx electron-builder ${{ matrix.builder }}

      - run: mv dist/win-unpacked dist/CodeHydra-${{ needs.check.outputs.version }}-win
        if: runner.os == 'Windows'

      - uses: actions/upload-artifact@v4
        with:
          name: CodeHydra-${{ needs.check.outputs.version }}-${{ matrix.platform }}
          path: dist/CodeHydra-*

  summary:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - run: |
          CODE_SERVER=$(grep 'CODE_SERVER_VERSION' src/services/binary-download/versions.ts | sed 's/.*"\(.*\)".*/\1/')
          OPENCODE=$(grep 'OPENCODE_VERSION' src/services/binary-download/versions.ts | sed 's/.*"\(.*\)".*/\1/')
          cat >> $GITHUB_STEP_SUMMARY << EOF
          # CodeHydra ${{ needs.check.outputs.version }}

          ## Bundled Versions
          | Component | Version |
          |-----------|---------|
          | code-server | $CODE_SERVER |
          | opencode | $OPENCODE |

          ## Commits
          EOF
          git log --oneline -20 >> $GITHUB_STEP_SUMMARY
```

## Documentation

### docs/RELEASE.md

```markdown
# Release Workflow

## Version Format

| Component  | Release               | Development                      |
| ---------- | --------------------- | -------------------------------- |
| App        | `YYYY.MM.DD`          | `{date}-dev.{hash}[-dirty]`      |
| Extensions | `{major}.{commits}.0` | `{major}.{commits}.0-dev.{hash}` |

App version injected via Vite define (`__APP_VERSION__`) and logged on startup.
Extension versions use valid SemVer format (required by VS Code).

The `-dirty` suffix only appears in local dev builds when there are uncommitted changes.

## Triggering a Build

1. Go to **Actions** → **Release**
2. Click **Run workflow**
3. Optionally check "Skip CI status check" to bypass CI gate

Summary and artifacts appear on the workflow run page.

## Artifacts

| Platform | Artifact Name                            |
| -------- | ---------------------------------------- |
| Windows  | `CodeHydra-{version}-win`                |
| Linux    | `CodeHydra-{version}-linux-x64.AppImage` |

## Changing Extension Major Version

To reset the extension version scheme (e.g., after breaking changes):

1. Edit `extensions/<name>/package.json`
2. Change `"version": "1"` to `"version": "2"`
3. Next build will produce `2.{commits}.0`
```

### AGENTS.md Addition (after "VS Code Assets" section)

```markdown
## Release Workflow

| Component  | Release Version       | Dev Version                      |
| ---------- | --------------------- | -------------------------------- |
| App        | `YYYY.MM.DD`          | `{date}-dev.{hash}[-dirty]`      |
| Extensions | `{major}.{commits}.0` | `{major}.{commits}.0-dev.{hash}` |

App version via `__APP_VERSION__` (Vite define), logged on startup.

**Trigger**: Manual via GitHub Actions (with optional force flag)
**Artifacts**: Windows dir, Linux AppImage
**Full details**: See [Release Workflow](docs/RELEASE.md).
```

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
