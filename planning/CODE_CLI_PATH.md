---
status: COMPLETED
last_updated: 2024-12-16
reviewers: [review-arch, review-typescript, review-testing, review-docs]
---

# CODE_CLI_PATH

## Overview

- **Problem**: CLI tools (`code`, `code-server`, `opencode`) aren't available in code-server's integrated terminal. Users must use full paths. Additionally, git operations (commit, rebase) don't open in the code-server editor.
- **Solution**: Create `<app-data>/bin/` directory with platform-specific wrapper scripts during setup, add to PATH when spawning code-server, and set EDITOR/GIT_SEQUENCE_EDITOR to make VS Code the default editor for git operations.
- **Risks**:
  - Script generation must handle all platforms correctly
  - Target binary paths differ between dev and production
  - Setup must regenerate scripts if paths change
- **Alternatives Considered**:
  1. **Direct PATH to node_modules**: Rejected - paths differ dev/prod, multiple directories needed
  2. **Symlinks**: Rejected - Windows requires admin for symlinks, cross-platform complexity
  3. **Shell rc modification**: Rejected - requires user configuration, invasive

## Architecture

```
<app-data>/
├── bin/                          # [NEW] CLI wrapper scripts
│   ├── code                      # Linux/macOS wrapper
│   ├── code.cmd                  # Windows wrapper
│   ├── code-server               # Linux/macOS wrapper
│   ├── code-server.cmd           # Windows wrapper
│   ├── opencode                  # Linux/macOS wrapper (if installed)
│   └── opencode.cmd              # Windows wrapper (if installed)
├── vscode/
│   ├── .setup-completed
│   └── ...
└── projects/
    └── ...
```

### Module Structure (Integrated with VscodeSetupService)

```
src/services/vscode-setup/
├── assets/                       # Existing assets
├── bin-scripts.ts                # [NEW] Utility - script generation functions
├── types.ts                      # Extended with bin script types
├── vscode-setup-service.ts       # Extended with setupBinDirectory()
└── ...
```

**Note**: Script generation is a utility module (pure functions), NOT a separate service. This follows the existing VscodeSetupService pattern where setup orchestration stays in one place.

### Script Generation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    VscodeSetupService                            │
├─────────────────────────────────────────────────────────────────┤
│  Dependencies:                                                   │
│    - FileSystemLayer (existing)                                  │
│    - PathProvider (existing)                                     │
│    - PlatformInfo [NEW]                                          │
│                                                                  │
│  setup()                                                         │
│    │                                                             │
│    ├──► Install extensions (existing)                           │
│    ├──► Copy settings (existing)                                │
│    │                                                             │
│    └──► [NEW] setupBinDirectory()                               │
│              │                                                   │
│              ├──► Create <app-data>/bin/                        │
│              │                                                   │
│              ├──► Resolve target binary paths                   │
│              │      - code-server: from BuildInfo/PathProvider  │
│              │      - opencode: optional, skip if not found     │
│              │                                                   │
│              ├──► Generate scripts via bin-scripts.ts           │
│              │      - Uses PlatformInfo for platform detection  │
│              │                                                   │
│              ├──► Write scripts via FileSystemLayer             │
│              │                                                   │
│              └──► makeExecutable() on Unix                      │
│                                                                  │
│  Progress event: "Creating CLI wrapper scripts..."              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### PATH and Environment Injection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     CodeServerManager                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  doStart()                                                       │
│    │                                                             │
│    ├──► Build cleanEnv (existing)                               │
│    │                                                             │
│    ├──► [NEW] Prepend binDir to PATH                            │
│    │         Uses path.delimiter from node:path                 │
│    │         Handles PATH/Path case sensitivity on Windows      │
│    │         PATH = binDir + delimiter + (PATH ?? Path ?? '')   │
│    │                                                             │
│    ├──► [NEW] Set EDITOR and GIT_SEQUENCE_EDITOR                │
│    │         Uses ABSOLUTE path to code wrapper in binDir       │
│    │         Makes VS Code the default editor for:              │
│    │           - git commit (commit message editing)            │
│    │           - git rebase -i (interactive rebase)             │
│    │           - Any tool respecting $EDITOR                    │
│    │         Value: "<binDir>/code --wait --reuse-window"       │
│    │                                                             │
│    └──► Spawn code-server with modified env                     │
│              │                                                   │
│              ▼                                                   │
│         Terminal inherits PATH + EDITOR vars                     │
│              │                                                   │
│              ├──► `code file.txt` works                         │
│              ├──► `git commit` opens in code-server             │
│              └──► `git rebase -i` opens in code-server          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Type Definitions

```typescript
// src/services/vscode-setup/types.ts (additions)

/** Paths to target binaries for wrapper script generation */
export interface BinTargetPaths {
  /** Path to code-server's remote-cli script */
  readonly codeRemoteCli: string;
  /** Path to code-server binary */
  readonly codeServerBinary: string;
  /** Path to opencode binary, or null if not installed */
  readonly opencodeBinary: string | null;
}

/** A generated wrapper script ready to write to disk */
export interface GeneratedScript {
  /** Filename without path (e.g., "code", "code.cmd") */
  readonly filename: ScriptFilename;
  /** Full script content */
  readonly content: string;
  /** Whether script needs executable permission (Unix only) */
  readonly needsExecutable: boolean;
}

/** Branded type for script filenames */
export type ScriptFilename = string & { readonly __brand: "ScriptFilename" };
```

## Wrapper Script Templates

Templates are **inline TypeScript template literals** in `bin-scripts.ts` (not separate files). The utility generates script content dynamically by substituting paths.

### Unix (Linux/macOS) - `code`

```bash
#!/bin/sh
exec '<path-to-code-server>/lib/vscode/bin/remote-cli/code-<platform>.sh' "$@"
```

### Unix (Linux/macOS) - `code-server`

```bash
#!/bin/sh
exec '<path-to-code-server-binary>' "$@"
```

### Unix (Linux/macOS) - `opencode`

```bash
#!/bin/sh
exec '<path-to-opencode-binary>' "$@"
```

### Windows - `code.cmd`

```cmd
@echo off
"<path-to-code-server>\lib\vscode\bin\remote-cli\code.cmd" %*
```

### Windows - `code-server.cmd` / `opencode.cmd`

```cmd
@echo off
"<path-to-binary>" %*
```

**Note**: Paths use single quotes on Unix (handles most special chars). Windows paths use double quotes.

## Binary Path Resolution

| Binary          | Development                                                    | Production                         |
| --------------- | -------------------------------------------------------------- | ---------------------------------- |
| code-server     | `require.resolve('code-server')` → `node_modules/code-server/` | `<appPath>/code-server/` (bundled) |
| code remote-cli | `<code-server>/lib/vscode/bin/remote-cli/code-{platform}.sh`   | Same relative path                 |
| opencode        | `require.resolve('opencode-ai')` or system PATH                | System PATH or bundled             |

**opencode handling**: If opencode binary cannot be found, skip wrapper generation and log a warning. Do not fail setup.

## Implementation Steps

- [x] **Step 1: Extend FileSystemLayer with makeExecutable()**
  - Add `makeExecutable(path: string): Promise<void>` to FileSystemLayer interface
  - Implement in DefaultFileSystemLayer using `fs.chmod(path, 0o755)`
  - No-op on Windows (files are executable by extension)
  - Files affected:
    - `src/services/platform/filesystem.ts`
  - Tests to write first:
    - `makeExecutable sets 0o755 on Unix` (unit, mocked)
    - `makeExecutable is no-op on Windows` (unit, mocked)
    - `makeExecutable on real file` (boundary test)

- [x] **Step 2: Add binDir to PathProvider**
  - Add `binDir` property: `<dataRootDir>/bin/`
  - Files affected:
    - `src/services/platform/path-provider.ts`
  - Tests to write first:
    - `PathProvider.binDir returns correct path`
    - `PathProvider.binDir is under dataRootDir`

- [x] **Step 3: Create bin-scripts utility module**
  - Pure functions for generating platform-specific wrapper scripts
  - Takes PlatformInfo for platform detection
  - Returns array of GeneratedScript objects
  - Files affected:
    - `src/services/vscode-setup/bin-scripts.ts` (new)
    - `src/services/vscode-setup/types.ts` (extend)
    - `src/services/vscode-setup/index.ts` (export)
  - Tests to write first:
    - `generateCodeScript Unix starts with shebang`
    - `generateCodeScript Unix uses exec`
    - `generateCodeScript Windows uses @echo off`
    - `generateCodeScript Windows uses .cmd extension`
    - `generateScripts uses Unix template on Linux`
    - `generateScripts uses Unix template on macOS`
    - `generateScripts uses Windows template on Windows`
    - `generateScripts handles paths with spaces`
    - `generateScripts generates consistent set per platform`
    - `generateScripts skips opencode when null`

- [x] **Step 4: Add PlatformInfo to VscodeSetupService and implement setupBinDirectory()**
  - Inject PlatformInfo as new constructor dependency
  - Implement `setupBinDirectory()` method:
    1. Create bin directory via FileSystemLayer.mkdir()
    2. Resolve target binary paths (handle missing opencode gracefully)
    3. Generate scripts via bin-scripts utility
    4. Write scripts via FileSystemLayer.writeFile()
    5. Call makeExecutable() for Unix scripts
  - Call from setup() with progress event "Creating CLI wrapper scripts..."
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.ts`
    - `src/main/index.ts` (pass PlatformInfo to constructor)
  - Tests to write first:
    - `setupBinDirectory creates bin directory`
    - `setupBinDirectory generates all scripts`
    - `setupBinDirectory calls makeExecutable on Unix`
    - `setupBinDirectory skips opencode if not found`
    - `setupBinDirectory handles mkdir failure`
    - `setupBinDirectory handles writeFile failure`
    - `setupBinDirectory emits progress event`

- [x] **Step 5: Update CodeServerConfig and Manager for binDir + EDITOR vars**
  - Add `binDir` to CodeServerConfig
  - In doStart(), after cleanEnv creation:
    1. Normalize PATH (handle PATH vs Path on Windows)
    2. Prepend binDir using `path.delimiter`
    3. Set EDITOR to absolute path: `"<binDir>/code" --wait --reuse-window`
    4. Set GIT_SEQUENCE_EDITOR to same value
  - Files affected:
    - `src/services/code-server/types.ts`
    - `src/services/code-server/code-server-manager.ts`
    - `src/main/index.ts`
  - Tests to write first:
    - `CodeServerManager prepends binDir to PATH`
    - `CodeServerManager preserves existing PATH entries`
    - `CodeServerManager preserves PATH entry order`
    - `CodeServerManager handles undefined PATH`
    - `CodeServerManager handles Windows Path case`
    - `CodeServerManager uses correct PATH separator (Unix)`
    - `CodeServerManager uses correct PATH separator (Windows)`
    - `CodeServerManager sets EDITOR with absolute path`
    - `CodeServerManager EDITOR includes --wait flag`
    - `CodeServerManager EDITOR includes --reuse-window flag`
    - `CodeServerManager sets GIT_SEQUENCE_EDITOR same as EDITOR`

- [x] **Step 6: Add boundary tests for bin setup**
  - Test real filesystem operations for script generation
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.boundary.test.ts` (new or extend existing)
  - Tests to write:
    - `setupBinDirectory creates bin directory on filesystem`
    - `setupBinDirectory writes executable scripts on Unix`
    - `setupBinDirectory scripts have correct content`
    - `generated scripts can be executed` (spawn and check exit code)

- [x] **Step 7: Add integration tests**
  - Test service wiring and end-to-end behavior
  - Files affected:
    - `src/services/vscode-setup/vscode-setup-service.integration.test.ts`
    - `src/services/code-server/code-server-manager.integration.test.ts`
  - Tests to write:
    - `VscodeSetupService.setup() calls setupBinDirectory()`
    - `CodeServerManager spawns with modified PATH environment`
    - `Generated scripts reference correct binary paths`

- [x] **Step 8: Update documentation**
  - **AGENTS.md**:
    - Add `bin/` to app-data directory structure under "Project Structure"
    - Document available CLI tools: `code`, `code-server`, `opencode`
    - Note that scripts are auto-generated during setup
    - Document EDITOR/GIT_SEQUENCE_EDITOR behavior for git operations
  - **docs/ARCHITECTURE.md**:
    - Update path structure to include `<app-data>/bin/`
    - Add subsection under "VS Code Setup" explaining wrapper script generation
    - Document PATH and EDITOR environment modifications in CodeServerManager

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                  | Description             | File                           |
| ------------------------------------------ | ----------------------- | ------------------------------ |
| `PathProvider.binDir correct`              | Verify binDir path      | `path-provider.test.ts`        |
| `makeExecutable sets 0o755 on Unix`        | Verify chmod call       | `filesystem.test.ts`           |
| `makeExecutable is no-op on Windows`       | No chmod on Windows     | `filesystem.test.ts`           |
| `generateCodeScript Unix shebang`          | Starts with `#!/bin/sh` | `bin-scripts.test.ts`          |
| `generateCodeScript Unix exec`             | Uses exec command       | `bin-scripts.test.ts`          |
| `generateCodeScript Windows @echo off`     | Proper cmd structure    | `bin-scripts.test.ts`          |
| `generateScripts platform detection`       | Correct template per OS | `bin-scripts.test.ts`          |
| `generateScripts paths with spaces`        | Handles special chars   | `bin-scripts.test.ts`          |
| `generateScripts consistent set`           | All tools generated     | `bin-scripts.test.ts`          |
| `generateScripts skips null opencode`      | Graceful skip           | `bin-scripts.test.ts`          |
| `setupBinDirectory creates dir`            | mkdir called            | `vscode-setup-service.test.ts` |
| `setupBinDirectory generates scripts`      | All scripts written     | `vscode-setup-service.test.ts` |
| `setupBinDirectory makeExecutable Unix`    | chmod on Unix scripts   | `vscode-setup-service.test.ts` |
| `setupBinDirectory skips missing opencode` | Graceful handling       | `vscode-setup-service.test.ts` |
| `setupBinDirectory mkdir failure`          | Error propagation       | `vscode-setup-service.test.ts` |
| `setupBinDirectory writeFile failure`      | Error propagation       | `vscode-setup-service.test.ts` |
| `CodeServerManager PATH prepend`           | binDir first in PATH    | `code-server-manager.test.ts`  |
| `CodeServerManager PATH preserved`         | Original entries kept   | `code-server-manager.test.ts`  |
| `CodeServerManager PATH order`             | Entry order maintained  | `code-server-manager.test.ts`  |
| `CodeServerManager PATH undefined`         | Handles missing PATH    | `code-server-manager.test.ts`  |
| `CodeServerManager Windows Path case`      | Handles Path vs PATH    | `code-server-manager.test.ts`  |
| `CodeServerManager PATH separator Unix`    | Uses `:`                | `code-server-manager.test.ts`  |
| `CodeServerManager PATH separator Windows` | Uses `;`                | `code-server-manager.test.ts`  |
| `CodeServerManager EDITOR absolute path`   | Full path to code       | `code-server-manager.test.ts`  |
| `CodeServerManager EDITOR --wait`          | Flag present            | `code-server-manager.test.ts`  |
| `CodeServerManager EDITOR --reuse-window`  | Flag present            | `code-server-manager.test.ts`  |
| `CodeServerManager GIT_SEQUENCE_EDITOR`    | Same as EDITOR          | `code-server-manager.test.ts`  |

### Boundary Tests

| Test Case                               | Description               | File                                    |
| --------------------------------------- | ------------------------- | --------------------------------------- |
| `makeExecutable on real file`           | Actually sets permissions | `filesystem.boundary.test.ts`           |
| `setupBinDirectory creates real dir`    | Real mkdir                | `vscode-setup-service.boundary.test.ts` |
| `setupBinDirectory writes real scripts` | Real file writes          | `vscode-setup-service.boundary.test.ts` |
| `generated scripts executable`          | Can spawn script          | `vscode-setup-service.boundary.test.ts` |

### Integration Tests

| Test Case                            | Description           | File                                       |
| ------------------------------------ | --------------------- | ------------------------------------------ |
| `Setup creates bin scripts`          | End-to-end setup      | `vscode-setup-service.integration.test.ts` |
| `CodeServerManager spawns with PATH` | Env passed to process | `code-server-manager.integration.test.ts`  |
| `Scripts reference correct paths`    | Path resolution works | `vscode-setup-service.integration.test.ts` |

### Manual Testing Checklist

- [ ] Fresh install - verify bin directory created during setup
- [ ] Open integrated terminal
- [ ] Run `echo $PATH` - verify bin directory is first
- [ ] Run `which code` - points to `<app-data>/bin/code`
- [ ] Run `code package.json` - file opens in editor
- [ ] Run `code --help` - shows help
- [ ] Run `which code-server` - points to `<app-data>/bin/code-server`
- [ ] Run `code-server --version` - shows version
- [ ] Run `which opencode` - points to `<app-data>/bin/opencode` (if installed)
- [ ] Run `opencode --help` - shows help (if installed)
- [ ] Run `echo $EDITOR` - shows absolute path with `--wait --reuse-window`
- [ ] Run `echo $GIT_SEQUENCE_EDITOR` - shows same as EDITOR
- [ ] Run `git commit` (with staged changes) - opens commit message in code-server
- [ ] Run `git rebase -i HEAD~2` - opens interactive rebase in code-server
- [ ] Close editor tab - git operation completes

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

**Note**: Uses `path.delimiter` from Node.js stdlib for PATH separator (no custom utility needed).

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Add `<app-data>/bin/` to directory structure; document `code`, `code-server`, `opencode` CLI tools; note auto-generation during setup; document EDITOR/GIT_SEQUENCE_EDITOR for git operations |
| `docs/ARCHITECTURE.md` | Add `bin/` to path structure table; add "CLI Wrapper Scripts" subsection under VS Code Setup; document PATH/EDITOR env modifications in CodeServerManager section                             |

### New Documentation Required

| File   | Purpose                         |
| ------ | ------------------------------- |
| (none) | Feature is transparent to users |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
