---
status: COMPLETED
last_updated: 2025-12-16
reviewers: [review-arch, review-docs, review-testing]
---

# CODE_SERVER_WINDOWS_BUILD

## Overview

- **Problem**: code-server doesn't publish Windows binaries. CodeHydra needs to distribute code-server for Windows to support the Windows platform.
- **Solution**: Create GitHub Actions workflows that automatically build and publish Windows versions of code-server to GitHub Releases. Package layout matches official Linux/macOS releases (code-server npm package already includes bundled Node.js at `lib/node`).
- **Risks**:
  - code-server npm install may break on Windows in future versions (mitigated: daily runs will catch failures quickly)
  - Node.js version requirement may change (mitigated: code-server bundles its own Node)
- **Alternatives Considered**:
  - WSL2/Docker: Rejected - need native Windows binary
  - Full source build: Rejected - too complex, requires porting bash scripts
  - npm install + electron-rebuild: Considered but not needed since we just package node_modules
  - Download Node.js separately: Not needed - code-server bundles Node at `lib/node`

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions (Daily @ 6 AM UTC)                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────┐                        │
│  │  check-code-server-releases.yaml        │                        │
│  │  (ubuntu-latest)                        │                        │
│  │                                         │                        │
│  │  Input: dry_run (optional, for testing) │                        │
│  │                                         │                        │
│  │  1. Fetch coder/code-server releases    │                        │
│  │  2. Filter >= MIN_VERSION (4.106.0)     │                        │
│  │  3. Fetch existing Windows builds       │                        │
│  │  4. Find missing versions               │                        │
│  │  5. Trigger build for each missing      │                        │
│  │     (or print what would trigger if dry)│                        │
│  └──────────────────┬──────────────────────┘                        │
│                     │                                               │
│                     │ gh workflow run (for each missing version)    │
│                     ▼                                               │
│  ┌─────────────────────────────────────────┐                        │
│  │  build-code-server-windows.yaml         │  (runs in parallel)    │
│  │  (windows-latest)                       │                        │
│  │                                         │                        │
│  │  Input: version (e.g., "4.106.3")       │                        │
│  │  Input: dry_run (optional, for testing) │                        │
│  │                                         │                        │
│  │  1. Setup Node.js 22                    │                        │
│  │  2. npm install code-server@{version}   │                        │
│  │  3. Flatten package structure           │                        │
│  │  4. Create bin/code-server.cmd launcher │                        │
│  │  5. Test package (run --version)        │                        │
│  │  6. Create zip package                  │                        │
│  │  7. Calculate SHA256 checksum           │                        │
│  │  8. Generate artifact attestation       │                        │
│  │  9. Create GitHub Release               │                        │
│  │     (or upload as artifact if dry_run)  │                        │
│  └─────────────────────────────────────────┘                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       GitHub Releases                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Tag: code-server-windows-v4.106.3                                  │
│  Title: code-server 4.106.3 for Windows                             │
│  Asset: code-server-4.106.3-win32-x64.zip (with attestation)        │
│         └── Standalone package matching Linux/macOS layout          │
│                                                                     │
│  Tag: code-server-windows-v4.106.2                                  │
│  Title: code-server 4.106.2 for Windows                             │
│  Asset: code-server-4.106.2-win32-x64.zip (with attestation)        │
│                                                                     │
│  ... (one release per version)                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Create build workflow**
  - Create `.github/workflows/build-code-server-windows.yaml`
  - Accepts `version` input via `workflow_dispatch` (required)
  - Accepts `dry_run` input via `workflow_dispatch` (optional, default false)
  - Runs on `windows-latest`
  - Installs Node.js 22, runs `npm install code-server@{version}`
  - Flattens package: moves contents of `node_modules/code-server/` to root (includes license files)
  - Creates `bin/code-server.cmd` launcher script (uses bundled `lib/node`)
  - Creates zip package matching Linux/macOS release layout
  - Calculates SHA256 checksum
  - Generates artifact attestation using `actions/attest-build-provenance`
  - If dry_run: uploads zip as workflow artifact for inspection
  - If not dry_run: creates GitHub Release with tag `code-server-windows-v{version}`
  - Uses `::notice::` workflow commands for status output
  - Files affected: `.github/workflows/build-code-server-windows.yaml`
  - Test criteria: Manual trigger with dry_run=true uploads artifact; dry_run=false creates release

- [x] **Step 2: Create check workflow**
  - Create `.github/workflows/check-code-server-releases.yaml`
  - Runs daily at 6 AM UTC via cron schedule
  - Can be manually triggered via `workflow_dispatch`
  - Accepts `dry_run` input (optional, default false)
  - Fetches all code-server releases from npm
  - Filters to versions >= MIN_VERSION using semver comparison
  - Fetches existing Windows builds from this repo's releases
  - Compares and finds missing versions
  - If dry_run: prints what builds would be triggered without triggering
  - If not dry_run: triggers build workflow for each missing version
  - Uses `::notice::` workflow commands for status output
  - Files affected: `.github/workflows/check-code-server-releases.yaml`
  - Test criteria: Manual trigger with dry_run=true shows versions without triggering

- [ ] **Step 3: Test end-to-end**
  - Manually trigger build workflow with `dry_run=true` to test without creating release
  - Download artifact and verify zip contents matches expected layout
  - Verify `bin/code-server.cmd` exists and launches correctly
  - Manually trigger build workflow with `dry_run=false` to create actual release
  - Verify release is created with correct assets and attestation
  - Manually trigger check workflow with `dry_run=true` to see what would be built
  - Manually trigger check workflow with `dry_run=false` to trigger actual builds
  - Test on Windows: extract zip and run `bin\code-server.cmd --help`
  - Test criteria: Complete flow works from check to published release

- [x] **Step 4: Update AGENTS.md**
  - Add section documenting code-server Windows builds
  - Document release naming convention (tag, title, asset filename)
  - Document that Windows builds are automated via GitHub Actions
  - Document where releases are published (GitHub Releases in this repo)
  - Document package layout matches Linux/macOS releases
  - Files affected: `AGENTS.md`
  - Test criteria: AGENTS.md includes code-server Windows build section

## Testing Strategy

### Manual Testing Checklist

- [ ] Trigger build workflow with `dry_run=true` and version "4.106.3"
- [ ] Verify workflow completes successfully
- [ ] Download artifact from workflow run and verify zip contents:
  - [ ] `bin/code-server.cmd` exists
  - [ ] `lib/node` exists (bundled Node.js from code-server)
  - [ ] `lib/vscode/` directory exists
  - [ ] `out/node/entry.js` exists
  - [ ] `package.json` exists at root
  - [ ] `LICENSE` file exists
  - [ ] `ThirdPartyNotices.txt` file exists
- [ ] Trigger build workflow with `dry_run=false` and version "4.106.3"
- [ ] Verify release is created with tag `code-server-windows-v4.106.3`
- [ ] Verify release title is "code-server 4.106.3 for Windows"
- [ ] Verify asset `code-server-4.106.3-win32-x64.zip` is attached
- [ ] Verify artifact attestation is present on the release
- [ ] Verify SHA256 in release notes matches actual file checksum
- [ ] Verify release notes contain link to upstream release
- [ ] Trigger check workflow with `dry_run=true`
- [ ] Verify it prints missing versions without triggering builds
- [ ] Trigger check workflow with `dry_run=false`
- [ ] Verify it triggers build workflows for missing versions
- [ ] Test on Windows: extract zip and run `bin\code-server.cmd --help`
- [ ] Verify bundled Node version: `lib\node --version`

## Dependencies

| Package | Purpose                                                  | Approved |
| ------- | -------------------------------------------------------- | -------- |
| None    | No new dependencies - uses GitHub Actions built-in tools | N/A      |

## Documentation Updates

### Files to Update

| File      | Changes Required                                                           |
| --------- | -------------------------------------------------------------------------- |
| AGENTS.md | Add section about code-server Windows builds and release naming convention |

### New Documentation Required

| File | Purpose                                           |
| ---- | ------------------------------------------------- |
| None | Workflow files are self-documenting with comments |

## Definition of Done

- [ ] All implementation steps complete
- [ ] Build workflow can be manually triggered and creates valid release
- [ ] Build workflow supports dry_run mode (uploads artifact for testing)
- [ ] Check workflow supports dry_run mode (prints without triggering)
- [ ] Package layout matches Linux/macOS releases (flattened structure)
- [ ] Package includes `bin/code-server.cmd` launcher script
- [ ] Package uses bundled Node.js from code-server (`lib/node`)
- [ ] Releases include artifact attestation for supply chain security
- [ ] Check workflow runs daily and triggers builds for missing versions
- [ ] Releases include LICENSE and ThirdPartyNotices.txt (MIT compliance)
- [ ] Release notes include SHA256 checksum and link to upstream release
- [ ] Documentation updated (AGENTS.md)
- [ ] User acceptance testing passed
- [ ] Changes committed

---

## Appendix: Workflow Source Code

### .github/workflows/build-code-server-windows.yaml

````yaml
name: Build code-server for Windows

on:
  workflow_dispatch:
    inputs:
      version:
        description: "code-server version to build (e.g., 4.106.3)"
        required: true
        type: string
      dry_run:
        description: "Test build without creating release (uploads as artifact instead)"
        required: false
        type: boolean
        default: false

permissions:
  contents: write # Required to create releases
  id-token: write # Required for artifact attestation
  attestations: write # Required for artifact attestation

env:
  NODE_VERSION: "22"

jobs:
  build:
    runs-on: windows-latest
    env:
      VERSION: ${{ inputs.version }}
      PACKAGE_DIR: code-server-${{ inputs.version }}-win32-x64
      ZIP_NAME: code-server-${{ inputs.version }}-win32-x64.zip
    steps:
      - name: Validate version format
        shell: bash
        run: |
          if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "::error::Invalid version format '$VERSION'. Expected semver (e.g., 4.106.3)"
            exit 1
          fi
          echo "::notice::Building code-server version $VERSION"
          if [ "${{ inputs.dry_run }}" = "true" ]; then
            echo "::notice::DRY RUN MODE - will upload as artifact instead of creating release"
          fi

      - name: Check if release already exists
        if: ${{ inputs.dry_run == false }}
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if gh release view "code-server-windows-v$VERSION" --repo ${{ github.repository }} &>/dev/null; then
            echo "::error::Release code-server-windows-v$VERSION already exists"
            exit 1
          fi

      - name: Verify version exists on npm
        shell: bash
        run: |
          if ! npm view "code-server@$VERSION" version &>/dev/null; then
            echo "::error::code-server@$VERSION not found on npm"
            exit 1
          fi

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Create build directory
        shell: bash
        run: mkdir -p build

      - name: Install code-server
        shell: bash
        working-directory: build
        run: npm install "code-server@$VERSION"

      - name: Create package directory with flattened structure
        shell: bash
        working-directory: build
        run: |
          mkdir -p "$PACKAGE_DIR"

          # Move contents of node_modules/code-server to package root (flattened)
          # This includes lib/node (bundled Node.js), lib/vscode, and license files
          cp -r node_modules/code-server/* "$PACKAGE_DIR/"

          # Verify bundled Node exists
          if [ ! -f "$PACKAGE_DIR/lib/node" ]; then
            echo "::error::Bundled Node.js not found at lib/node"
            exit 1
          fi

      - name: Create launcher script
        shell: bash
        working-directory: build
        run: |
          mkdir -p "$PACKAGE_DIR/bin"

          # Create Windows batch launcher script
          cat > "$PACKAGE_DIR/bin/code-server.cmd" << 'LAUNCHER'
          @echo off
          setlocal

          :: Get the directory where this script is located
          set "SCRIPT_DIR=%~dp0"

          :: Go up one level to package root
          set "ROOT_DIR=%SCRIPT_DIR%.."

          :: Run code-server with bundled node
          "%ROOT_DIR%\lib\node" "%ROOT_DIR%\out\node\entry.js" %*
          LAUNCHER

      - name: Test package
        shell: bash
        working-directory: build
        run: |
          # Run code-server --version using bundled node and entry point
          VERSION_OUTPUT=$("$PACKAGE_DIR/lib/node" "$PACKAGE_DIR/out/node/entry.js" --version)

          if [ $? -ne 0 ]; then
            echo "::error::Package test failed - code-server --version returned non-zero exit code"
            exit 1
          fi

          echo "::notice::Test passed: $VERSION_OUTPUT"

      - name: Create zip package
        shell: pwsh
        working-directory: build
        run: Compress-Archive -Path $env:PACKAGE_DIR -DestinationPath $env:ZIP_NAME

      - name: Calculate SHA256 checksum
        id: checksum
        shell: pwsh
        working-directory: build
        run: |
          $hash = (Get-FileHash -Path $env:ZIP_NAME -Algorithm SHA256).Hash.ToLower()
          echo "sha256=$hash" >> $env:GITHUB_OUTPUT

      - name: Generate artifact attestation
        if: ${{ inputs.dry_run == false }}
        uses: actions/attest-build-provenance@v2
        with:
          subject-path: build/${{ env.ZIP_NAME }}

      - name: Upload artifact (dry run)
        if: ${{ inputs.dry_run == true }}
        uses: actions/upload-artifact@v4
        with:
          name: ${{ env.ZIP_NAME }}
          path: build/${{ env.ZIP_NAME }}
          retention-days: 7

      - name: Create GitHub Release
        if: ${{ inputs.dry_run == false }}
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          SHA256: ${{ steps.checksum.outputs.sha256 }}
        working-directory: build
        run: |
          TAG="code-server-windows-v$VERSION"
          BUNDLED_NODE_VERSION=$("$PACKAGE_DIR/lib/node" --version)

          # Create release notes
          cat > release-notes.md << 'EOF'
          ## code-server $VERSION for Windows

          Windows build of [code-server $VERSION](https://github.com/coder/code-server/releases/tag/v$VERSION).

          ### Contents

          This is a standalone package that includes:
          - code-server $VERSION
          - Node.js $NODE_VERSION (bundled)

          Package layout matches official Linux/macOS releases.

          ### Usage

          Extract the zip and run:

          ```powershell
          bin\code-server.cmd --help
          ```

          Or directly with the bundled node:

          ```powershell
          lib\node out\node\entry.js --help
          ```

          ### Official Release Notes

          See the [upstream release notes](https://github.com/coder/code-server/releases/tag/v$VERSION) for changes in this version.

          ### Checksums

          **SHA256:**
          ```
          $SHA256  $ZIP_NAME
          ```

          ### Supply Chain Security

          This release includes an artifact attestation for supply chain security.
          Verify with: `gh attestation verify $ZIP_NAME --repo ${{ github.repository }}`

          ### License

          code-server is licensed under the MIT License. See included LICENSE file.
          Node.js is also MIT licensed.
          EOF

          # Replace placeholders
          sed -i "s/\$VERSION/$VERSION/g" release-notes.md
          sed -i "s/\$ZIP_NAME/$ZIP_NAME/g" release-notes.md
          sed -i "s/\$SHA256/$SHA256/g" release-notes.md
          sed -i "s/\$NODE_VERSION/$BUNDLED_NODE_VERSION/g" release-notes.md

          gh release create "$TAG" \
            --repo "${{ github.repository }}" \
            --title "code-server $VERSION for Windows" \
            --notes-file release-notes.md \
            "$ZIP_NAME"

      - name: Summary
        shell: bash
        env:
          SHA256: ${{ steps.checksum.outputs.sha256 }}
        working-directory: build
        run: |
          BUNDLED_NODE_VERSION=$("$PACKAGE_DIR/lib/node" --version)

          if [ "${{ inputs.dry_run }}" = "true" ]; then
            echo "::notice::DRY RUN complete - Package: $ZIP_NAME, Node: $BUNDLED_NODE_VERSION, SHA256: $SHA256"
          else
            echo "::notice::Release created: code-server-windows-v$VERSION - Package: $ZIP_NAME, Node: $BUNDLED_NODE_VERSION, SHA256: $SHA256"
          fi
````

### .github/workflows/check-code-server-releases.yaml

```yaml
name: Check code-server releases

on:
  schedule:
    - cron: "0 6 * * *" # Daily at 6 AM UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Show what would be built without triggering builds"
        required: false
        type: boolean
        default: false

permissions:
  contents: read
  actions: write # Required to trigger other workflows

env:
  MIN_VERSION: "4.106.0"

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Check mode
        run: |
          if [ "${{ inputs.dry_run }}" = "true" ]; then
            echo "::notice::DRY RUN MODE - will not trigger builds"
          fi

      - name: Get code-server releases from npm
        id: upstream
        run: |
          # Get all versions from npm
          ALL_VERSIONS=$(npm view code-server versions --json | jq -r '.[]')

          # Filter to versions >= MIN_VERSION
          MIN="${{ env.MIN_VERSION }}"
          FILTERED_VERSIONS=$(echo "$ALL_VERSIONS" | while read -r version; do
            # Compare versions using sort -V
            if [ "$(printf '%s\n' "$MIN" "$version" | sort -V | head -n1)" = "$MIN" ]; then
              # Exclude pre-release versions (containing -)
              if [[ ! "$version" =~ - ]]; then
                echo "$version"
              fi
            fi
          done)

          COUNT=$(echo "$FILTERED_VERSIONS" | grep -c . || echo "0")
          echo "::notice::Found $COUNT upstream versions >= $MIN"

          # Convert to JSON array
          VERSIONS_JSON=$(echo "$FILTERED_VERSIONS" | jq -R -s -c 'split("\n") | map(select(length > 0))')
          echo "versions=$VERSIONS_JSON" >> $GITHUB_OUTPUT

      - name: Get existing Windows builds
        id: existing
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # Get all releases with code-server-windows prefix
          EXISTING=$(gh release list \
            --repo "${{ github.repository }}" \
            --limit 1000 \
            --json tagName \
            --jq '.[] | select(.tagName | startswith("code-server-windows-v")) | .tagName | ltrimstr("code-server-windows-v")')

          COUNT=$(echo "$EXISTING" | grep -c . || echo "0")
          echo "::notice::Found $COUNT existing Windows builds"

          # Convert to JSON array
          EXISTING_JSON=$(echo "$EXISTING" | jq -R -s -c 'split("\n") | map(select(length > 0))')
          echo "versions=$EXISTING_JSON" >> $GITHUB_OUTPUT

      - name: Find missing versions
        id: missing
        run: |
          UPSTREAM='${{ steps.upstream.outputs.versions }}'
          EXISTING='${{ steps.existing.outputs.versions }}'

          # Find versions in upstream but not in existing
          MISSING=$(jq -n \
            --argjson upstream "$UPSTREAM" \
            --argjson existing "$EXISTING" \
            '$upstream - $existing')

          COUNT=$(echo "$MISSING" | jq 'length')

          if [ "$COUNT" -gt 0 ]; then
            MISSING_LIST=$(echo "$MISSING" | jq -r '. | join(", ")')
            echo "::notice::Missing $COUNT versions: $MISSING_LIST"
          fi

          echo "versions=$MISSING" >> $GITHUB_OUTPUT
          echo "missing_count=$COUNT" >> $GITHUB_OUTPUT

      - name: Trigger builds for missing versions
        if: steps.missing.outputs.missing_count != '0' && inputs.dry_run != true
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          MISSING='${{ steps.missing.outputs.versions }}'

          echo "$MISSING" | jq -r '.[]' | while read -r version; do
            gh workflow run build-code-server-windows.yaml \
              --repo "${{ github.repository }}" \
              -f version="$version"

            # Small delay to avoid rate limiting
            sleep 2
          done

      - name: Summary
        run: |
          COUNT="${{ steps.missing.outputs.missing_count }}"

          if [ "$COUNT" -eq 0 ]; then
            echo "::notice::All versions up to date!"
          elif [ "${{ inputs.dry_run }}" = "true" ]; then
            echo "::notice::DRY RUN - Would build $COUNT versions"
          else
            echo "::notice::Triggered $COUNT builds"
          fi
```

## Appendix: Release Naming Convention

| Item           | Format                                | Example                             |
| -------------- | ------------------------------------- | ----------------------------------- |
| Git tag        | `code-server-windows-v{version}`      | `code-server-windows-v4.106.3`      |
| Release title  | `code-server {version} for Windows`   | `code-server 4.106.3 for Windows`   |
| Asset filename | `code-server-{version}-win32-x64.zip` | `code-server-4.106.3-win32-x64.zip` |

## Appendix: Zip Contents

Package layout matches official Linux/macOS releases:

```
code-server-4.106.3-win32-x64.zip
└── code-server-4.106.3-win32-x64/
    ├── bin/
    │   └── code-server.cmd       # Windows launcher script
    ├── lib/
    │   ├── node                  # Bundled Node.js (from code-server npm package)
    │   └── vscode/               # VS Code distribution
    ├── out/
    │   └── node/
    │       └── entry.js          # Main entry point
    ├── package.json
    ├── LICENSE                   # MIT license from code-server
    └── ThirdPartyNotices.txt     # Third-party licenses
```

### Comparison with Official Linux Release

| Linux/macOS                      | Windows (our build)           |
| -------------------------------- | ----------------------------- |
| `bin/code-server` (shell script) | `bin/code-server.cmd` (batch) |
| `lib/node` (bundled Node.js)     | `lib/node` (same)             |
| `lib/vscode/`                    | `lib/vscode/`                 |
| `out/node/entry.js`              | `out\node\entry.js`           |

## Appendix: License Compliance

code-server is MIT licensed which permits:

- Commercial use
- Modification
- Distribution
- Private use

Requirements:

- Include copyright notice (LICENSE file)
- Include permission notice (LICENSE file)

We comply by including both LICENSE and ThirdPartyNotices.txt in every release.

Note: Node.js is also MIT licensed and can be freely redistributed.
