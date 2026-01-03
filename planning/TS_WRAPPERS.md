---
status: COMPLETED
last_updated: 2026-01-03
reviewers:
  - review-typescript
  - review-arch
  - review-testing
  - review-platform
  - review-docs
---

# TS_WRAPPERS

## Overview

- **Problem**: CLI wrapper scripts are generated at runtime with dynamic paths baked in. The `opencode.cjs` script is embedded as a string template in TypeScript, making it hard to test and maintain. The generation adds complexity without significant benefit since most content is static.
- **Solution**: Convert wrapper scripts to static files that read paths from environment variables at runtime. Migrate `opencode.cjs` to TypeScript (`opencode-wrapper.ts`) compiled to CJS via Vite at build time, enabling proper testing, type coverage, and reuse of existing modules (`Path`, `@opencode-ai/sdk`).
- **Risks**:
  - Environment variables must be reliably set in all terminal contexts (mitigated: already done for `CODEHYDRA_OPENCODE_PORT`)
  - Build process adds one more Vite config (mitigated: follows existing extension build pattern)
- **Alternatives Considered**:
  - **Symlinks (`current` → version)**: Rejected - Windows requires admin/developer mode
  - **Version file (`.versions.json`)**: Rejected - shell scripts can't easily parse JSON
  - **Separate esbuild script**: Rejected - Vite already available, handles tree-shaking
  - **Use OpenCodeClient**: Rejected - too heavy (needs Logger, SSE, state management); SDK is lighter
  - **Use ProcessRunner**: Rejected - designed for Electron main process with Logger; spawnSync is simpler for standalone CLI

## Architecture

### Current Flow (Generated Scripts)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SETUP TIME                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WrapperScriptGenerationService                                             │
│       │                                                                     │
│       ├── resolveTargetPaths()                                              │
│       │       ├── codeRemoteCli: /app/code-server/4.106.3/lib/.../code      │
│       │       ├── opencodeBinary: /app/opencode/1.0.163/opencode            │
│       │       └── bundledNodePath: /app/code-server/4.106.3/lib/node        │
│       │                                                                     │
│       └── generateScripts(platformInfo, targetPaths, binDir)                │
│               │                                                             │
│               ├── bin/code      ← paths baked in at generation              │
│               ├── bin/opencode  ← paths baked in at generation              │
│               └── bin/opencode.cjs  ← version baked in as string template   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### New Flow (Static Scripts + Vite Build)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BUILD TIME                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Vite (vite.config.bin.ts)                                                  │
│       │                                                                     │
│       ├── Input: src/bin/opencode-wrapper.ts                                │
│       │     ├── imports: @opencode-ai/sdk (tree-shaken, only session.list)  │
│       │     └── imports: Path (tree-shaken)                                 │
│       │                                                                     │
│       └── Output: dist/bin/opencode.cjs (self-contained bundle)             │
│                                                                             │
│  vite-plugin-static-copy (in main build)                                    │
│       │                                                                     │
│       └── Copy resources/bin/* + dist/bin/* → out/main/assets/bin/          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         SETUP TIME                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  VscodeSetupService.setupBinDirectory()                                     │
│       │                                                                     │
│       └── Copy from assets/bin/ → <app-data>/bin/                           │
│           ├── code / code.cmd         (static shell scripts)                │
│           ├── opencode / opencode.cmd (static shell scripts)                │
│           └── opencode.cjs            (Vite-compiled TypeScript)            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         RUNTIME                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CodeServerManager.start()                                                  │
│       │                                                                     │
│       └── env: {                                                            │
│             CODEHYDRA_CODE_SERVER_DIR: "/app/code-server/4.106.3",          │
│             CODEHYDRA_OPENCODE_DIR: "/app/opencode/1.0.163",                │
│             CODEHYDRA_OPENCODE_PORT: "12345",  // existing                  │
│             PATH: "/app/bin:...",              // existing                  │
│           }                                                                 │
│                                                                             │
│  User runs `code file.txt` in terminal                                      │
│       │                                                                     │
│       ├── Unix: bin/code                                                    │
│       │   └── exec $CODEHYDRA_CODE_SERVER_DIR/lib/vscode/.../code-linux.sh  │
│       │                                                                     │
│       └── Windows: bin/code.cmd                                             │
│           └── %CODEHYDRA_CODE_SERVER_DIR%\lib\vscode\...\code.cmd           │
│                                                                             │
│  User runs `opencode` in terminal                                           │
│       │                                                                     │
│       ├── Unix: bin/opencode                                                │
│       │   └── exec $CODEHYDRA_CODE_SERVER_DIR/lib/node bin/opencode.cjs     │
│       │                                                                     │
│       └── Windows: bin/opencode.cmd                                         │
│           └── %CODEHYDRA_CODE_SERVER_DIR%\lib\node.exe bin\opencode.cjs     │
│                                                                             │
│  opencode.cjs (runs in Node.js)                                             │
│       │                                                                     │
│       ├── Validates $CODEHYDRA_OPENCODE_PORT (exit 1 if missing/invalid)    │
│       ├── Validates $CODEHYDRA_OPENCODE_DIR (exit 1 if missing)             │
│       ├── Uses @opencode-ai/sdk to list sessions from 127.0.0.1:<port>      │
│       ├── Finds matching session by directory (using Path.equals())         │
│       └── Spawns opencode[.exe] with --session flag (spawnSync)             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Module Dependencies (Tree-Shaken by Vite)

```
src/bin/opencode-wrapper.ts
    │
    ├── @opencode-ai/sdk
    │   └── createOpencodeClient() → sdk.session.list()
    │       (only HTTP client code bundled, not SSE/streaming)
    │
    ├── Path (from ../services/platform/path)
    │   └── constructor, equals(), toString()
    │
    └── node:child_process (external - not bundled)
        └── spawnSync
```

### Environment Variables

| Variable                    | Set By             | Used By                | Purpose                                       |
| --------------------------- | ------------------ | ---------------------- | --------------------------------------------- |
| `CODEHYDRA_CODE_SERVER_DIR` | CodeServerManager  | code, opencode scripts | Directory containing code-server installation |
| `CODEHYDRA_OPENCODE_DIR`    | CodeServerManager  | opencode.cjs           | Directory containing opencode binary          |
| `CODEHYDRA_OPENCODE_PORT`   | sidekick extension | opencode.cjs           | Port of running OpenCode server               |

**Note**: `CODEHYDRA_*_DIR` env vars point to directories only. Binary names (including `.exe` on Windows) are constructed by the scripts themselves based on platform detection.

## Implementation Steps

- [x] **Step 1: Create static shell wrapper scripts**
  - Create `resources/bin/code` (Unix shell script):
    ```sh
    #!/bin/sh
    if [ -z "$CODEHYDRA_CODE_SERVER_DIR" ]; then
      echo "Error: CODEHYDRA_CODE_SERVER_DIR not set." >&2
      echo "Make sure you're in a CodeHydra workspace terminal." >&2
      exit 1
    fi
    exec "$CODEHYDRA_CODE_SERVER_DIR/lib/vscode/bin/remote-cli/code-$(uname -s | tr '[:upper:]' '[:lower:]').sh" "$@"
    ```
  - Create `resources/bin/code.cmd` (Windows batch):
    ```batch
    @echo off
    if "%CODEHYDRA_CODE_SERVER_DIR%"=="" (
      echo Error: CODEHYDRA_CODE_SERVER_DIR not set. >&2
      echo Make sure you're in a CodeHydra workspace terminal. >&2
      exit /b 1
    )
    "%CODEHYDRA_CODE_SERVER_DIR%\lib\vscode\bin\remote-cli\code.cmd" %*
    ```
  - Create `resources/bin/opencode` (Unix shell script):
    ```sh
    #!/bin/sh
    if [ -z "$CODEHYDRA_CODE_SERVER_DIR" ]; then
      echo "Error: CODEHYDRA_CODE_SERVER_DIR not set." >&2
      exit 1
    fi
    BINDIR="$(dirname "$0")"
    exec "$CODEHYDRA_CODE_SERVER_DIR/lib/node" "$BINDIR/opencode.cjs" "$@"
    ```
  - Create `resources/bin/opencode.cmd` (Windows batch):
    ```batch
    @echo off
    if "%CODEHYDRA_CODE_SERVER_DIR%"=="" (
      echo Error: CODEHYDRA_CODE_SERVER_DIR not set. >&2
      exit /b 1
    )
    "%CODEHYDRA_CODE_SERVER_DIR%\lib\node.exe" "%~dp0opencode.cjs" %*
    ```
  - Add `.gitattributes` entries to force LF line endings for Unix scripts:
    ```
    resources/bin/code text eol=lf
    resources/bin/opencode text eol=lf
    ```
  - Files: `resources/bin/code`, `resources/bin/code.cmd`, `resources/bin/opencode`, `resources/bin/opencode.cmd`, `.gitattributes`
  - Test criteria: Scripts are syntactically valid shell/batch scripts

- [x] **Step 2: Create TypeScript opencode wrapper**
  - Create `src/bin/opencode-wrapper.ts` with the Node.js wrapper logic
  - Define types for session data:
    ```typescript
    interface OpenCodeSession {
      id: string;
      directory: string;
      parentID?: string | null;
      time?: { updated: number };
    }
    ```
  - Export `findMatchingSession` as a named export for focused testing:
    ```typescript
    export function findMatchingSession(
      sessions: OpenCodeSession[],
      directory: string
    ): OpenCodeSession | null;
    ```
  - Use `Path.equals()` for cross-platform directory comparison
  - Import `createOpencodeClient` from `@opencode-ai/sdk` for session listing
  - Construct SDK client URL with `http://127.0.0.1:${port}` (not localhost)
  - Read and validate env vars:
    - `CODEHYDRA_OPENCODE_PORT` - exit 1 with error if missing or invalid
    - `CODEHYDRA_OPENCODE_DIR` - exit 1 with error if missing
  - Define exit code constants:
    ```typescript
    const EXIT_SUCCESS = 0;
    const EXIT_ENV_ERROR = 1;
    const EXIT_SPAWN_FAILED = 2;
    ```
  - Construct binary path: `<CODEHYDRA_OPENCODE_DIR>/opencode[.exe]` based on `process.platform`
  - Use `spawnSync` with `shell: true` when binary path ends with `.cmd`
  - Robust async error handling:
    ```typescript
    async function main(): Promise<never> {
      // ... logic
      process.exit(exitCode);
    }
    main().catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
    ```
  - Session restoration behavior:
    1. Query OpenCode server at `http://127.0.0.1:<port>/session`
    2. Filter sessions by workspace directory match (using `Path.equals()`)
    3. Exclude sub-agent sessions (those with `parentID`)
    4. Select most recently updated session (`time.updated`)
    5. Invoke `opencode attach <url> [--session <id>]`
  - Files: `src/bin/opencode-wrapper.ts`
  - Test criteria: TypeScript compiles, imports resolve correctly

- [x] **Step 3: Create Vite config for bin wrapper**
  - Create `vite.config.bin.ts`:

    ```typescript
    import { builtinModules } from "node:module";
    import { defineConfig } from "vite";
    import { resolve } from "path";

    export default defineConfig({
      build: {
        lib: {
          entry: resolve(__dirname, "src/bin/opencode-wrapper.ts"),
          formats: ["cjs"],
          fileName: () => "opencode.cjs",
        },
        outDir: "dist/bin",
        rollupOptions: {
          external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        },
        minify: false,
        sourcemap: false,
      },
    });
    ```

  - Input: `src/bin/opencode-wrapper.ts`
  - Output: `dist/bin/opencode.cjs`
  - Externalize: All Node.js built-ins (`child_process`, `fs`, `path`, `os`, etc.)
  - Bundle: `@opencode-ai/sdk` and `Path` (tree-shaken)
  - Files: `vite.config.bin.ts`
  - Test criteria: `pnpm build:wrappers` produces valid CJS module; verify bundle size is reasonable (SDK tree-shaking working)

- [x] **Step 4: Add build script and update package.json**
  - Add `build:wrappers` script: `vite build --config vite.config.bin.ts`
  - Update `build` script order: `build:wrappers && build:extensions && electron-vite build`
  - Files: `package.json`
  - Test criteria: `pnpm build` runs wrapper build first, then extensions, then main build

- [x] **Step 5: Update vite config to copy static scripts**
  - Add `resources/bin/*` to vite-plugin-static-copy targets
  - Add `dist/bin/*` to vite-plugin-static-copy targets
  - Output to `out/main/assets/bin/`
  - Files: `electron.vite.config.ts`
  - Test criteria: Build output contains all wrapper scripts in assets/bin/

- [x] **Step 6: Add environment variables to code-server spawn**
  - Update `CodeServerConfig` type with `codeServerDir` and `opencodeDir` paths
  - Update `CodeServerManager.start()` to set env vars:
    - `CODEHYDRA_CODE_SERVER_DIR` = `this.config.codeServerDir` (from PathProvider.codeServerDir)
    - `CODEHYDRA_OPENCODE_DIR` = `this.config.opencodeDir` (from PathProvider.opencodeDir)
  - Use `path.toNative()` for environment variable values
  - Files: `src/services/code-server/types.ts`, `src/services/code-server/code-server-manager.ts`
  - Test criteria: Integration tests verify env vars are set in spawned process

- [x] **Step 7: Simplify VscodeSetupService bin directory setup**
  - Add `binAssetsDir` to PathProvider (points to `<appPath>/out/main/assets/bin/`)
  - Replace `WrapperScriptGenerationService` calls with file copy
  - Copy all files from assets/bin/ to <app-data>/bin/
  - Set executable permissions on Unix using `fs.promises.chmod(path, 0o755)` for files without `.cmd` extension
  - All script generation logic is removed; only MCP config generation (`generateOpencodeConfigContent`) remains
  - Files: `src/services/vscode-setup/vscode-setup-service.ts`, `src/services/platform/path-provider.ts`
  - Test criteria: Setup copies scripts correctly, Unix scripts have executable permissions (mode 0o755)

- [x] **Step 8: Delete obsolete generation code**
  - Remove `WrapperScriptGenerationService` class and test file
  - Remove script generation functions from `bin-scripts.ts`:
    - `generateScripts()`, `generateScript()`
    - `generateOpencodeScript()`, `generateOpencodeNodeScript()`
    - `generateUnixScript()`, `generateWindowsScript()`
    - `generateUnixOpencodeWrapper()`, `generateWindowsOpencodeWrapper()`
    - `extractOpencodeVersion()`
  - Keep `generateOpencodeConfigContent()` (MCP config still generated)
  - Update `src/services/vscode-setup/index.ts` exports
  - Files: `src/services/vscode-setup/wrapper-script-generation-service.ts` (delete), `src/services/vscode-setup/wrapper-script-generation-service.test.ts` (delete), `src/services/vscode-setup/bin-scripts.ts`, `src/services/vscode-setup/index.ts`
  - Test criteria: No references to removed code, build succeeds

- [x] **Step 9: Add focused tests for session matching**
  - Create `src/bin/opencode-wrapper.test.ts`
  - Test `findMatchingSession()` pure logic:
    - Filters by directory match (using Path comparison)
    - Excludes sub-agents (sessions with parentID)
    - Returns most recent match (highest time.updated)
    - Returns first session when time.updated values are equal
    - Handles sessions with missing/null time.updated
    - Returns null when no match
    - Handles empty sessions array
    - Cross-platform directory matching (`C:/foo` vs `C:\foo`)
  - Files: `src/bin/opencode-wrapper.test.ts`
  - Test criteria: Full coverage of findMatchingSession logic including edge cases

- [x] **Step 10: Update boundary tests**
  - Update `bin-scripts.boundary.test.ts` to test compiled CJS from dist/bin/
  - Happy path smoke test:
    - Mock HTTP server returns sessions at `/session`
    - All env vars set correctly
    - Verify spawn args include: binary path, `attach`, `http://127.0.0.1:<port>`, `--session <id>`
  - No matching session:
    - Mock server returns sessions for different directory
    - Verify spawn args: binary path, `attach`, URL (no --session flag)
  - Error cases:
    - Missing `CODEHYDRA_OPENCODE_PORT`: Exit 1 within 5s, stderr contains "CODEHYDRA_OPENCODE_PORT not set"
    - Invalid port (non-numeric, out of range): Exit 1, stderr contains error
    - Missing `CODEHYDRA_OPENCODE_DIR`: Exit 1, stderr contains error
    - Server unreachable: Exit 1 within 5s, stderr contains connection error
  - Verify SDK client URL uses `127.0.0.1` (not localhost)
  - Verify binary path construction: `<CODEHYDRA_OPENCODE_DIR>/opencode[.exe]`
  - Files: `src/services/vscode-setup/bin-scripts.boundary.test.ts`
  - Test criteria: Boundary tests pass, happy path wiring verified, <200ms per test

- [x] **Step 11: Update documentation**
  - Update AGENTS.md CLI Wrapper Scripts section:
    - Update wrapper script table (same scripts, same purpose)
    - Keep architecture diagram (flow remains: `opencode → opencode.cjs → binary`)
    - Add new env vars to Environment Variables table:
      - `CODEHYDRA_CODE_SERVER_DIR` - Directory containing code-server installation
      - `CODEHYDRA_OPENCODE_DIR` - Directory containing opencode binary
    - Remove references to script generation
    - Document that scripts only work in CodeHydra-managed terminals
    - Session restoration behavior unchanged
  - Files: `AGENTS.md`
  - Test criteria: Documentation accurately reflects new architecture

## Testing Strategy

### Focused Tests

Pure logic tests for `findMatchingSession()` function.

| #   | Test Case                     | Function              | Input/Output                            |
| --- | ----------------------------- | --------------------- | --------------------------------------- |
| 1   | Filters by directory match    | `findMatchingSession` | Sessions array + dir → matching session |
| 2   | Excludes sub-agents           | `findMatchingSession` | Sessions with parentID → filtered out   |
| 3   | Returns most recent match     | `findMatchingSession` | Multiple matches → highest time.updated |
| 4   | Returns first when time equal | `findMatchingSession` | Equal time.updated → first match        |
| 5   | Handles missing time.updated  | `findMatchingSession` | null/undefined time → treated as 0      |
| 6   | Returns null when no match    | `findMatchingSession` | No matching dir → null                  |
| 7   | Handles empty sessions array  | `findMatchingSession` | [] → null                               |
| 8   | Cross-platform path matching  | `findMatchingSession` | `C:/foo` matches `C:\foo` on Windows    |

### Boundary Tests

Real execution of compiled CJS with mock HTTP server at the external boundary.

| #   | Test Case                       | Setup                                          | Behavior Verified                                 |
| --- | ------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| 1   | Happy path smoke test           | Mock server returns sessions, all env vars set | Spawns binary with `attach <url> --session <id>`  |
| 2   | No matching session             | Mock server returns sessions for different dir | Spawns binary with `attach <url>` (no --session)  |
| 3   | Missing CODEHYDRA_OPENCODE_PORT | Env var not set                                | Exit 1, stderr: "CODEHYDRA_OPENCODE_PORT not set" |
| 4   | Invalid port (non-numeric)      | CODEHYDRA_OPENCODE_PORT="abc"                  | Exit 1, stderr contains error                     |
| 5   | Invalid port (out of range)     | CODEHYDRA_OPENCODE_PORT="99999"                | Exit 1, stderr contains error                     |
| 6   | Missing CODEHYDRA_OPENCODE_DIR  | Env var not set                                | Exit 1, stderr contains error                     |
| 7   | Server unreachable              | No mock server running                         | Exit 1 within 5s, graceful error                  |
| 8   | SDK uses 127.0.0.1              | Mock server on 127.0.0.1                       | Connection succeeds (not localhost)               |
| 9   | Binary path construction        | CODEHYDRA_OPENCODE_DIR set                     | Correct path with .exe on Windows                 |

### Integration Tests (Existing)

Verify CodeServerManager sets the new env vars.

| #   | Test Case                               | Entry Point                  | Boundary Mocks  | Behavior Verified                                            |
| --- | --------------------------------------- | ---------------------------- | --------------- | ------------------------------------------------------------ |
| 1   | Code-server spawn sets wrapper env vars | `CodeServerManager.start()`  | ProcessRunner   | `CODEHYDRA_CODE_SERVER_DIR` and `CODEHYDRA_OPENCODE_DIR` set |
| 2   | Setup copies bin scripts from assets    | `VscodeSetupService.setup()` | FileSystemLayer | Scripts copied to bin dir with correct permissions           |

### Manual Testing Checklist

- [ ] Run `code <file>` in workspace terminal - opens file in code-server
- [ ] Run `opencode` in workspace terminal - attaches to OpenCode server
- [ ] Run `git commit` in workspace terminal - opens editor in code-server
- [ ] Verify scripts work on fresh setup (first run after install)
- [ ] Verify scripts work after binary version update
- [ ] Test on Windows: `code.cmd` and `opencode.cmd` work correctly

## File Changes Summary

### New Files

| File                               | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `resources/bin/code`               | Static Unix shell wrapper for VS Code CLI         |
| `resources/bin/code.cmd`           | Static Windows batch wrapper for VS Code CLI      |
| `resources/bin/opencode`           | Static Unix shell wrapper that invokes Node.js    |
| `resources/bin/opencode.cmd`       | Static Windows batch wrapper that invokes Node.js |
| `src/bin/opencode-wrapper.ts`      | TypeScript source for opencode Node.js logic      |
| `src/bin/opencode-wrapper.test.ts` | Focused tests for findMatchingSession             |
| `vite.config.bin.ts`               | Vite config to compile wrapper to CJS             |

### Modified Files

| File                                                     | Changes                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `.gitattributes`                                         | Add LF line ending rules for Unix shell scripts                       |
| `package.json`                                           | Add `build:wrappers` script, update `build` order                     |
| `electron.vite.config.ts`                                | Add static-copy for resources/bin/_ and dist/bin/_                    |
| `src/services/code-server/types.ts`                      | Add `codeServerDir` and `opencodeDir` to CodeServerConfig             |
| `src/services/code-server/code-server-manager.ts`        | Set `CODEHYDRA_CODE_SERVER_DIR` and `CODEHYDRA_OPENCODE_DIR` env vars |
| `src/services/platform/path-provider.ts`                 | Add `binAssetsDir` property                                           |
| `src/services/vscode-setup/vscode-setup-service.ts`      | Replace generation with file copy from assets                         |
| `src/services/vscode-setup/bin-scripts.ts`               | Remove script generation functions, keep MCP config                   |
| `src/services/vscode-setup/index.ts`                     | Remove WrapperScriptGenerationService export                          |
| `src/services/vscode-setup/bin-scripts.boundary.test.ts` | Update to test compiled CJS                                           |
| `AGENTS.md`                                              | Update CLI Wrapper Scripts documentation, add env vars                |

### Deleted Files

| File                                                                  | Reason                |
| --------------------------------------------------------------------- | --------------------- |
| `src/services/vscode-setup/wrapper-script-generation-service.ts`      | Replaced by file copy |
| `src/services/vscode-setup/wrapper-script-generation-service.test.ts` | No longer needed      |

## Dependencies

No new dependencies required.

| Package | Purpose                                                         | Approved |
| ------- | --------------------------------------------------------------- | -------- |
| (none)  | `@opencode-ai/sdk` already a dependency, Vite already available | N/A      |

## Documentation Updates

### Files to Update

| File        | Changes Required                                                                |
| ----------- | ------------------------------------------------------------------------------- |
| `AGENTS.md` | Update CLI Wrapper Scripts section, add env vars to Environment Variables table |

### New Documentation Required

None - existing documentation sections will be updated.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
