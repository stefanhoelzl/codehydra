---
status: COMPLETED
last_updated: 2025-12-29
reviewers:
  - review-arch
  - review-typescript
  - review-testing
  - review-docs
---

# PATH_NORMALIZATION

## Overview

- **Problem**: Windows paths with backslashes cause failures throughout the application. The deep code review revealed **15+ path comparison points**, **4 different normalization functions**, and **6+ Maps using raw paths as keys** - all with inconsistent handling. GitHub issue #4 (workspace deletion on Windows) is a symptom of this systemic problem.

- **Solution**: Introduce a `Path` class (similar to Python's `pathlib.Path`) that encapsulates all path operations. The class normalizes paths on construction to a canonical internal format:
  - **POSIX separators**: Always forward slashes (`/`)
  - **Absolute paths required**: Throws error on relative paths (use `new Path(Path.cwd(), relativePath)` explicitly)
  - **Case normalization**: Lowercase on Windows (case-insensitive filesystem)
  - **Clean format**: No trailing slashes, no `..` or `.` segments

- **Risks**:
  - Large refactoring scope (touches many files)
  - Potential serialization issues (JSON storage, IPC)
  - Breaking changes during migration

- **Alternatives Considered**:
  1. **Ad-hoc normalization everywhere**: Current state - rejected due to inconsistency
  2. **Simple normalization functions**: Rejected - too easy to forget to call
  3. **Branded string types only**: Rejected - doesn't enforce normalization
  4. **Path class (chosen)**: Type-safe, self-normalizing, encapsulates all logic

## Architecture

### Path Class Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Path Class                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  CONSTRUCTOR (normalizes automatically)                                 │
│  ──────────────────────────────────────                                 │
│  new Path(base)              → normalized path (must be absolute)       │
│  new Path(base, ...parts)    → joined and normalized                    │
│  new Path(otherPath, ...parts) → extend existing Path                   │
│                                                                         │
│  STATIC METHODS                                                         │
│  ──────────────────────────────────────                                 │
│  Path.cwd()                  → current working directory as Path        │
│                                                                         │
│  INTERNAL STATE (readonly, computed once)                               │
│  ──────────────────────────────────────                                 │
│  _value: string             // "c:/users/name/project" (always POSIX)   │
│                             // lowercase on Windows, preserved on Unix  │
│                                                                         │
│  ACCESSORS (all derived from _value)                                    │
│  ──────────────────────────────────────                                 │
│  .toString()            → normalized string (for Map keys, comparison)  │
│  .toNative()            → OS-native format (for node:fs, spawning)      │
│  .basename              → filename/directory name                        │
│  .dirname               → parent directory as Path                       │
│  .extension             → file extension (e.g., ".ts")                   │
│  .segments              → ["c:", "users", "name", "project"]            │
│                                                                         │
│  OPERATIONS                                                             │
│  ──────────────────────────────────────                                 │
│  .equals(other)         → boolean (handles string or Path, never throws)│
│  .startsWith(prefix)    → boolean                                       │
│  .isChildOf(parent)     → boolean (proper containment check)            │
│  .relativeTo(base)      → string (relative path)                        │
│                                                                         │
│  JSON SERIALIZATION                                                     │
│  ──────────────────────────────────────                                 │
│  .toJSON()              → calls toString() (for JSON.stringify)         │
│  .valueOf()             → calls toString() (for implicit conversion)    │
│  [Symbol.toStringTag]   → "Path" (for debugging)                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Internal State?

Normalization is computed once and cached because:

1. **Not trivial**: Involves separator replacement, case conversion, validation
2. **Called frequently**: `toString()` used for Map keys, logging, comparisons
3. **Immutable object**: Safe to cache - value never changes
4. **Performance**: Map lookups happen often; recomputing would be wasteful

### Normalization Rules

```
INPUT                           NORMALIZED (Windows)         NORMALIZED (Unix)
───────────────────────────────────────────────────────────────────────────
C:\Users\Name\Project           c:/users/name/project        (N/A)
C:\Users\Name\Project\          c:/users/name/project        (N/A)
C:/Users/Name/Project           c:/users/name/project        (N/A)
/home/user/project              /home/user/project           /home/user/project
/home/user/project/             /home/user/project           /home/user/project
\\server\share\folder           //server/share/folder        (UNC on Windows)

RELATIVE PATHS - THROW ERROR (must use Path.cwd() explicitly)
───────────────────────────────────────────────────────────────────────────
./relative/path                 ERROR: Path must be absolute
../parent/path                  ERROR: Path must be absolute
foo/bar                         ERROR: Path must be absolute

To convert relative paths:
  new Path(Path.cwd(), "./relative/path")  → absolute path
```

### Data Flow

```
                    EXTERNAL WORLD
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
   ▼                      ▼                      ▼
File Dialog          Git Output             Config Files
(native: C:\...)     (POSIX: C:/...)        (stored POSIX)
   │                      │                      │
   └──────────────────────┼──────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │  new Path(...)  │ ← SINGLE ENTRY POINT
                │  validates:     │
                │  - is absolute  │
                │  normalizes:    │
                │  - to POSIX /   │
                │  - to lowercase*│
                └────────┬────────┘
                         │
                         ▼
          ┌────────────────────────────────┐
          │      INTERNAL CODEHYDRA        │
          │                                │
          │   All code works with Path     │
          │   objects exclusively          │
          │                                │
          │   Map<string, T> uses          │
          │   path.toString() as key       │
          │                                │
          │   Comparisons use              │
          │   path.equals(other)           │
          │                                │
          └───────────────┬────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
   FileSystem        Process           Serialize
   Operations        Spawning          (JSON/IPC)
        │                 │                 │
        ▼                 ▼                 ▼
  path.toNative()  path.toNative()   path.toString()
  (internal)       (internal)             │
        │                 │               ▼
        ▼                 ▼          JSON string
   node:fs/execa    CLI args        (normalized)
   (OS-native)      (OS-native)
```

### Key Insight: Git Already Returns POSIX Paths!

**Discovery**: Git commands return POSIX-style paths (forward slashes) even on Windows:

- `git worktree list --porcelain` → `C:/Users/...`
- `git rev-parse --show-toplevel` → `C:/Users/...`

**Current bug**: The code normalizes these to native format (`path.normalize()` → backslashes), then later has to convert back. We should keep them as POSIX from the start!

**Verification**: Add boundary test on Windows CI to confirm git's POSIX output format before removing normalization.

### Serialization Strategy

```typescript
// Path serializes to normalized string in JSON automatically
const project = { id: "my-app-12345678", path: new Path("/home/user/project") };
JSON.stringify(project);
// → {"id":"my-app-12345678","path":"/home/user/project"}

// Deserialize by wrapping - already normalized, minimal overhead
const data = JSON.parse(json);
const projectPath = new Path(data.path);
```

### IPC Boundary Responsibility

**IMPORTANT**: IPC handlers are THE conversion point between Path objects and strings.

```
Renderer (strings) ──IPC──► Main Process IPC Handlers ──► Services (Path objects)
                              │
                              ├─ INCOMING: new Path(payload.path)
                              └─ OUTGOING: path.toString() (automatic via toJSON)
```

- **Shared types in `src/shared/` remain unchanged** - they use `string` for paths
- **IPC payloads use strings** - renderer sends/receives strings
- **Internal services use Path** - all business logic works with Path objects
- **Conversion happens in IPC handlers** (CoreModule, UiModule)

### Migration of Persisted Data

Projects stored in `config.json` may have native paths from older versions:

```json
{ "path": "C:\\Users\\Name\\project" }
```

**Strategy**: Auto-migrate on read. When loading config:

1. `new Path(config.path)` normalizes to POSIX
2. Save back to persist the normalized format
3. Self-healing - old data automatically upgraded

**Note**: Cross-platform serialization is NOT a concern - CodeHydra runs on a single machine and only handles local paths.

## Deep Code Review Findings

### Entry Points - Complete Inventory

| Location                   | Entry Type          | Current                    | What It Receives      | Fix                            |
| -------------------------- | ------------------- | -------------------------- | --------------------- | ------------------------------ |
| `ui/index.ts:120`          | File dialog         | Raw                        | Native (C:\...)       | `new Path(result)`             |
| `core/index.ts:189`        | IPC projectOpen     | Raw                        | String from renderer  | `new Path(payload.path)`       |
| `core/index.ts:273`        | IPC workspaceRemove | Via resolver               | String                | Already resolved               |
| `simple-git-client.ts:122` | Git worktree list   | `path.normalize()`         | **POSIX (C:/...)**    | Keep as-is, wrap with `Path`   |
| `simple-git-client.ts:82`  | Git rev-parse       | `path.normalize()`         | **POSIX (C:/...)**    | Keep as-is, wrap with `Path`   |
| `plugin-server.ts:484`     | Socket auth         | `normalizeWorkspacePath()` | Native from extension | `new Path(auth.workspacePath)` |
| `mcp-server.ts:430`        | MCP header          | Resolver                   | String                | `new Path(header)`             |
| All `PathProvider` methods | Construction        | `path.join()`              | N/A                   | Return `Path` objects          |
| `project-store.ts`         | JSON config         | Raw string                 | Stored POSIX          | `new Path(config.path)`        |

### Maps Using Paths as Keys - All Need Updating

| Location                        | Map                   | Current Key             | New Key                 |
| ------------------------------- | --------------------- | ----------------------- | ----------------------- |
| `app-state.ts:46`               | `openProjects`        | Raw `projectPath`       | `path.toString()`       |
| `app-state.ts:47`               | `lastBaseBranches`    | Raw `projectPath`       | `path.toString()`       |
| `view-manager.ts:71`            | `workspaceViews`      | Raw `workspacePath`     | `path.toString()`       |
| `view-manager.ts:76`            | `workspaceUrls`       | Raw `workspacePath`     | `path.toString()`       |
| `view-manager.ts:100`           | `workspacePartitions` | Raw `workspacePath`     | `path.toString()`       |
| `opencode-server-manager.ts:75` | `servers`             | Raw `workspacePath`     | `path.toString()`       |
| `agent-status-manager.ts:225`   | `providers`           | `WorkspacePath` branded | `path.toString()`       |
| `plugin-server.ts:170`          | `connections`         | Normalized ✓            | Already correct pattern |

### Path Comparisons - All Locations

| Location                                   | Current Code                      | Issue             | Fix                              |
| ------------------------------------------ | --------------------------------- | ----------------- | -------------------------------- |
| `app-state.ts:349`                         | Local `normalizePath()`           | Ad-hoc function   | `path.equals(other)`             |
| `mcp-server/workspace-resolver.ts:71`      | `w.path === normalizedPath`       | Mixed formats     | `path.equals(other)`             |
| `view-manager.ts:334,508,526`              | `=== workspacePath`               | No normalization  | `path.equals(other)`             |
| `renderer/stores/projects.svelte.ts:45,57` | `w.path === _activeWorkspacePath` | Assumes format    | Document or compare Path strings |
| `git-worktree-provider.ts:362`             | `normalizeWorktreePath()`         | Custom function   | `path.equals(other)`             |
| `git-worktree-provider.ts:530`             | Path containment check            | Uses `startsWith` | `path.isChildOf(parent)`         |
| `core/index.ts:285,310`                    | `=== workspace.path`              | Direct comparison | `path.equals(other)`             |

### Functions to Delete (Replaced by Path Class)

| Function                   | Location                   | Lines   | Fate               |
| -------------------------- | -------------------------- | ------- | ------------------ |
| `normalizePath()`          | `paths.ts:47-67`           | 20      | Delete, use `Path` |
| `normalizeWorkspacePath()` | `plugin-protocol.ts:24-39` | 15      | Delete, use `Path` |
| `normalizeWorktreePath()`  | `git-worktree-provider.ts` | Private | Delete, use `Path` |
| Local `normalizePath()`    | `app-state.ts:341-344`     | Inline  | Delete, use `Path` |

### Current Bug: Git POSIX Paths Converted to Native

```typescript
// simple-git-client.ts:122 - CURRENT (buggy)
// Git returns POSIX: "C:/Users/foo"
// path.normalize() converts to native: "C:\Users\foo"
worktreePath = path.normalize(line.substring("worktree ".length));

// FIXED
// Keep POSIX format, wrap with Path (no conversion needed)
worktreePath = new Path(line.substring("worktree ".length));
```

## Implementation Steps

### Phase 1: Path Class Foundation

- [x] **Step 1.1: Create Path class**
  - File: `src/services/platform/path.ts`
  - Constructor: `new Path(base: string | Path, ...parts: string[])`
  - Static: `Path.cwd()` for current working directory
  - Validation: Throw error on relative paths, null, undefined, empty, invalid parts
  - Normalization: Extract into private static `normalize()` method for SRP
  - Platform detection: Inject via `PlatformInfo` for testability (follow existing pattern)
  - Methods (see Appendix for complete implementation):
    - `toString()`, `toNative()`, `toJSON()`, `valueOf()`
    - `equals()` - returns false for invalid strings (never throws)
    - `startsWith()`, `isChildOf()`, `relativeTo()`
  - Accessors: `basename`, `dirname`, `extension`, `segments`
  - Debugging: `[Symbol.toStringTag]` returns `"Path"`
  - Files affected: New file
  - Test criteria: All normalization rules work on both platforms

- [x] **Step 1.2: Add comprehensive Path tests**
  - File: `src/services/platform/path.test.ts`
  - Organize into three describe blocks:
    - `describe("Path (cross-platform)")` - tests for both platforms
    - `describe.skipIf(process.platform !== "win32")("Path (Windows)")`
    - `describe.skipIf(process.platform === "win32")("Path (Unix)")`
  - Test all normalization scenarios (see Testing Strategy)
  - Test edge cases: root path, multiple slashes, whitespace, special chars
  - Test `equals()` returns false for invalid input (doesn't throw)
  - Test criteria: 100% coverage of Path class

- [x] **Step 1.3: Export Path from services**
  - File: `src/services/index.ts`
  - Test criteria: `Path` importable from `../services`

### Phase 2: PathProvider Migration

- [x] **Step 2.1: Update PathProvider interface**
  - Return `Path` instead of `string` for all path properties
  - File: `src/services/platform/path-provider.ts`
  - Test criteria: Interface uses Path types

- [x] **Step 2.2: Update DefaultPathProvider implementation**
  - Construct Path objects internally
  - File: `src/services/platform/path-provider.ts`
  - Test criteria: All properties return Path objects

- [x] **Step 2.3: Update PathProvider consumers**
  - Migrate all code using PathProvider
  - Files: `vscode-setup-service.ts`, `code-server-manager.ts`, `binary-download-service.ts`, etc.
  - Test criteria: Consumers work with Path objects

- [x] **Step 2.4: Update PathProvider consumer tests**
  - Update all test files using `createMockPathProvider` to work with Path objects
  - Tests should use `.toString()` when comparing path values
  - Tests should use `path.dirname` accessor instead of `dirname()` function
  - Files: All `*.test.ts` files that import `createMockPathProvider`:
    - `src/services/binary-download/binary-download-service.test.ts`
    - `src/services/binary-download/binary-download-service.boundary.test.ts`
    - `src/services/binary-download/binary-download-service.integration.test.ts`
    - `src/services/vscode-setup/wrapper-script-generation-service.test.ts`
    - `src/services/vscode-setup/vscode-setup-service.test.ts`
    - `src/services/opencode/opencode-client.boundary.test.ts`
    - `src/main/index.test.ts`
    - And any other files using PathProvider mocks
  - Test criteria: All PathProvider consumer tests pass

### Phase 3: FileSystemLayer Integration

- [x] **Step 3.1: Update FileSystemLayer to accept Path**
  - Accept `Path` (or `Path | string` for gradual migration)
  - Convert to native internally via `path.toNative()`
  - File: `src/services/platform/filesystem.ts`
  - Test criteria: FileSystemLayer accepts Path, handles conversion internally

- [x] **Step 3.2: Update FileSystemLayer tests**
  - Test Path acceptance
  - File: `src/services/platform/filesystem.test.ts`
  - Test criteria: Tests verify Path input works

### Phase 4: GitClient Migration

- [x] **Step 4.1: Add boundary test for git POSIX output**
  - Verify git returns POSIX paths on Windows CI before removing normalization
  - File: `src/services/git/simple-git-client.boundary.test.ts`
  - Test criteria: Boundary test confirms git output format on Windows

- [x] **Step 4.2: Update IGitClient interface**
  - Path parameters and return types
  - File: `src/services/git/git-client.ts`
  - Test criteria: Interface uses Path types

- [x] **Step 4.3: Update SimpleGitClient**
  - **Key fix**: Stop converting git's POSIX output to native
  - Wrap git output with `new Path()` directly
  - Convert to native only when passing to simple-git
  - File: `src/services/git/simple-git-client.ts`
  - Test criteria: Git operations preserve POSIX paths

- [x] **Step 4.4: Update GitWorktreeProvider**
  - Use Path for all path operations
  - Replace `startsWith` with `isChildOf()` for containment checks
  - Delete `normalizeWorktreePath()` method
  - File: `src/services/git/git-worktree-provider.ts`
  - Test criteria: Worktree operations work correctly

### Phase 5: Core Domain Updates

**Important**: There are TWO Workspace types that must be kept distinct:

- **Internal `Workspace`** (`git/types.ts`): `{ name: string, path: Path, branch, metadata }` - no projectId
- **IPC `Workspace`** (`shared/api/types.ts`): `{ projectId, name: WorkspaceName, path: string, branch, metadata }` - has projectId

The IPC types remain unchanged (string paths). A conversion layer bridges the gap.

- [x] **Step 5.1: Create type conversion utilities**
  - Create `src/main/api/workspace-conversion.ts` with:

    ```typescript
    import type { Workspace as InternalWorkspace } from "../../services/git/types";
    import type { Workspace as IpcWorkspace, ProjectId } from "../../shared/api/types";

    /** Convert internal Workspace to IPC Workspace for sending to renderer */
    export function toIpcWorkspace(
      internal: InternalWorkspace,
      projectId: ProjectId
    ): IpcWorkspace {
      return {
        projectId,
        name: internal.name as WorkspaceName,
        path: internal.path.toString(),
        branch: internal.branch,
        metadata: internal.metadata,
      };
    }
    ```

  - File: `src/main/api/workspace-conversion.ts` (new)
  - Test criteria: Conversion function correctly transforms types

- [x] **Step 5.2: Update git/types.ts to use Path**
  - Internal `Workspace.path` becomes `Path`
  - Internal `WorktreeInfo.path` becomes `Path`
  - **Keep shared/api/types.ts unchanged** (IPC uses string)
  - Files: `src/services/git/types.ts`
  - Test criteria: Internal types use Path

- [x] **Step 5.3: Update GitWorktreeProvider**
  - Return internal Workspace with `path: Path`
  - File: `src/services/git/git-worktree-provider.ts`
  - Test criteria: Provider returns Path-based workspaces

- [x] **Step 5.4: Update AppState**
  - Store internal Workspace types internally
  - Use `toIpcWorkspace()` when building Project objects for IPC
  - Use `path.toString()` for Map keys
  - Delete inline `normalizePath()` function
  - File: `src/main/app-state.ts`
  - Test criteria: Project/workspace lookups work on Windows

- [x] **Step 5.5: Update ViewManager**
  - ViewManager receives normalized strings from AppState (which uses Path)
  - Map keys already use normalized strings
  - File: `src/main/managers/view-manager.ts`
  - Note: No change needed - AppState provides normalized paths
  - Test criteria: View management works

- [x] **Step 5.6: Update all Phase 5 tests**
  - Update test files for git types and app-state
  - Files: `src/services/git/*.test.ts`, `src/main/app-state.test.ts`, etc.
  - Test criteria: All tests pass

### Phase 6: IPC Boundary Updates

IPC handlers are THE conversion point between Path objects and strings.

- [x] **Step 6.1: Update IPC handlers in CoreModule**
  - **Incoming**: Wrap path strings with `new Path()` immediately
  - **Outgoing**: Path objects serialize automatically via `toJSON()`
  - File: `src/main/modules/core/index.ts`
  - Note: Already handled - paths flow through AppState which normalizes
  - Test criteria: Paths normalized at entry, strings sent to renderer

- [x] **Step 6.2: Update UiModule (file dialogs)**
  - Wrap `showOpenDialog` results with `new Path()`
  - File: `src/main/modules/ui/index.ts`
  - Note: Dialog paths go to renderer then to projectOpen which normalizes
  - Test criteria: Dialog paths are Path objects

- [x] **Step 6.3: Update ID generation**
  - Use `path.toString()` in `generateProjectId()` for consistent hashing
  - Ensures same ID regardless of input format (`C:\foo` vs `C:/foo`)
  - File: `src/shared/api/id-utils.ts`
  - Test criteria: Same ID for equivalent paths in different formats

### Phase 7: Service Updates

- [x] **Step 7.1: Update OpenCodeServerManager**
  - Use `Path` for workspace tracking
  - Remove manual `.replace(/\\/g, "/")`
  - File: `src/services/opencode/opencode-server-manager.ts`
  - Test criteria: OpenCode starts correctly on Windows

- [x] **Step 7.2: Update AgentStatusManager**
  - Use `WorkspacePath` (now Path-based) for Map keys
  - File: `src/services/opencode/agent-status-manager.ts`
  - Note: AgentStatusManager receives normalized paths from AppState callbacks
  - Test criteria: Agent status tracking works

- [x] **Step 7.3: Update PluginServer**
  - Use `Path` for connection tracking
  - Delete `normalizeWorkspacePath` import (now local function using Path)
  - File: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Plugin connections work on Windows

- [x] **Step 7.4: Update MCP Server**
  - Use `Path` in workspace resolution
  - File: `src/services/mcp-server/*.ts`
  - Test criteria: MCP requests resolve correctly

- [x] **Step 7.5: Update ProjectStore**
  - Store normalized paths in JSON
  - Load with `new Path()` (auto-migrates old native paths)
  - File: `src/services/project/project-store.ts`
  - Test criteria: Projects persist and load correctly

### Phase 8: Cleanup

- [x] **Step 8.1: Delete deprecated normalization functions**
  - `normalizeWorkspacePath` from `plugin-protocol.ts` - DELETED
  - `normalizeWorktreePath` from `git-worktree-provider.ts` - Already deleted in Phase 4
  - `normalizePath` from `paths.ts` - DELETED
  - Local functions from `app-state.ts` - Already using Path class
  - Files: Multiple
  - Test criteria: No duplicate normalization logic

- [x] **Step 8.2: Audit for remaining ad-hoc normalization**
  - Remaining `.replace(/\\/g` usages are legitimate:
    - `path.ts` - Core Path class normalization (correct)
    - `code-server-manager.ts:41` - URL encoding for HTTP (correct)
    - `bin-scripts.ts:177` - Generated JS for Node.js wrapper (correct)
    - `keepfiles-service.test.ts` - Local test helper (acceptable)
  - Files: Various
  - Test criteria: No ad-hoc path handling

### Phase 9: Renderer Updates

- [x] **Step 9.1: Document renderer path handling**
  - Paths in renderer are normalized strings (from IPC)
  - Add JSDoc comments documenting format
  - Files: `src/renderer/lib/stores/*.svelte.ts`
  - Test criteria: Documentation complete

### Phase 10: Documentation

- [x] **Step 10.1: Update docs/PATTERNS.md**
  - Add "Path Handling Patterns" section
  - Document Path class API with examples
  - Document boundary responsibilities:
    - Use `toString()` for: Map keys, comparisons, JSON serialization, IPC
    - Use `toNative()` for: (handled internally by FileSystemLayer, ProcessRunner)
    - Use `isChildOf()` for: containment checks (not `startsWith()`)
  - File: `docs/PATTERNS.md`
  - Test criteria: Documentation complete with code examples

- [x] **Step 10.2: Update docs/ARCHITECTURE.md**
  - Add Path class to Platform Abstractions Overview table
  - Document normalization rules (POSIX, lowercase on Windows)
  - Document that IPC boundaries handle Path↔string conversion
  - File: `docs/ARCHITECTURE.md`
  - Test criteria: Path class documented in architecture

- [x] **Step 10.3: Update AGENTS.md**
  - Add path handling to Critical Rules
  - Document Path class requirement for all internal path handling
  - Document that shared types remain string-based (IPC compatibility)
  - File: `AGENTS.md`
  - Test criteria: AI agents understand convention

## Testing Strategy

### Platform-Specific Testing

Tests for platform-specific behavior use `describe.skipIf()` to run only on the relevant platform. CI runs on both Linux and Windows, ensuring full coverage.

Organize tests by feature, with platform-specific variants:

```typescript
describe("Path", () => {
  describe("normalization (cross-platform)", () => {
    it("removes trailing slashes", () => { ... });
    it("resolves .. segments", () => { ... });
  });

  describe.skipIf(process.platform !== "win32")("normalization (Windows)", () => {
    it("converts backslashes to forward slashes", () => { ... });
    it("lowercases drive letter", () => { ... });
  });

  describe.skipIf(process.platform === "win32")("normalization (Unix)", () => {
    it("preserves case", () => { ... });
  });
});
```

### Integration Tests

| #   | Test Case                      | Entry Point                          | Behavioral Mocks                    | Behavior Verified                     |
| --- | ------------------------------ | ------------------------------------ | ----------------------------------- | ------------------------------------- |
| 1   | Windows path in project open   | `CoreModule.projectOpen()`           | GitClient (in-memory worktree list) | Path normalized, project stored       |
| 2   | Workspace lookup mixed formats | `AppState.findProjectForWorkspace()` | None                                | `C:\foo` finds stored `c:/foo`        |
| 3   | File dialog on Windows         | `UiModule.selectFolder()`            | Dialog (returns predetermined path) | Native path → Path object             |
| 4   | Git worktree discovery         | `GitWorktreeProvider.discover()`     | GitClient (returns POSIX paths)     | Git POSIX output kept as POSIX        |
| 5   | Plugin socket connection       | `PluginServer.handleConnection()`    | Socket.IO (mock connection)         | Connection keyed correctly            |
| 6   | Project save/load              | `ProjectStore`                       | FileSystemLayer (in-memory store)   | Path survives round-trip              |
| 7   | OpenCode server start          | `OpenCodeServerManager`              | ProcessRunner (mock spawn)          | Env vars have correct paths           |
| 8   | Workspace deletion             | `CoreModule.workspaceRemove()`       | GitClient, FileSystemLayer          | GitHub #4 - deletion completes        |
| 9   | Mixed case path equality (Win) | `AppState.findProjectForWorkspace()` | None                                | `C:\Users\Foo` matches `c:/users/foo` |

### Focused Tests (Path Class)

| #   | Test Case                   | Input                         | Expected (Windows) | Expected (Unix) | Platform |
| --- | --------------------------- | ----------------------------- | ------------------ | --------------- | -------- |
| 1   | Windows backslashes         | `C:\foo\bar`                  | `c:/foo/bar`       | N/A             | Windows  |
| 2   | Windows forward slashes     | `C:/foo/bar`                  | `c:/foo/bar`       | N/A             | Windows  |
| 3   | Mixed separators            | `C:\foo/bar`                  | `c:/foo/bar`       | N/A             | Windows  |
| 4   | Trailing slash              | `/foo/bar/`                   | `/foo/bar`         | `/foo/bar`      | Both     |
| 5   | Relative path throws        | `./foo`                       | Error thrown       | Error thrown    | Both     |
| 6   | Parent path throws          | `../foo`                      | Error thrown       | Error thrown    | Both     |
| 7   | Bare relative throws        | `foo/bar`                     | Error thrown       | Error thrown    | Both     |
| 8   | Path.cwd() + relative       | `new Path(Path.cwd(), "foo")` | Absolute path      | Absolute path   | Both     |
| 9   | UNC path                    | `\\server\share`              | `//server/share`   | N/A             | Windows  |
| 10  | Case normalization (Win)    | `C:\FOO\Bar`                  | `c:/foo/bar`       | N/A             | Windows  |
| 11  | Case preserved (Unix)       | `/FOO/Bar`                    | N/A                | `/FOO/Bar`      | Unix     |
| 12  | Empty path throws           | `""`                          | Error thrown       | Error thrown    | Both     |
| 13  | Null/undefined throws       | `null`                        | Error thrown       | Error thrown    | Both     |
| 14  | Invalid parts throw         | `new Path("/foo", "")`        | Error thrown       | Error thrown    | Both     |
| 15  | Constructor join            | `new Path("/foo", "bar")`     | `/foo/bar`         | `/foo/bar`      | Both     |
| 16  | Extend existing             | `new Path(p, "sub")`          | `<p>/sub`          | `<p>/sub`       | Both     |
| 17  | toNative (Win)              | Path with `c:/foo/bar`        | `c:\foo\bar`       | N/A             | Windows  |
| 18  | toNative (Unix)             | Path with `/foo/bar`          | N/A                | `/foo/bar`      | Unix     |
| 19  | equals Path same            | `c:/foo`, `C:\foo`            | `true`             | N/A             | Windows  |
| 20  | equals Path different       | `/foo`, `/bar`                | `false`            | `false`         | Both     |
| 21  | equals string (valid)       | `path.equals("/foo")`         | Works              | Works           | Both     |
| 22  | equals string (invalid)     | `path.equals("relative")`     | `false` (no throw) | `false`         | Both     |
| 23  | JSON serialize              | `JSON.stringify(path)`        | `"/foo/bar"`       | `"/foo/bar"`    | Both     |
| 24  | valueOf                     | `String(path)`                | Normalized string  | Normalized      | Both     |
| 25  | Symbol.toStringTag          | `Object.prototype.toString()` | `[object Path]`    | `[object Path]` | Both     |
| 26  | basename                    | `new Path("/foo/bar.ts")`     | `"bar.ts"`         | `"bar.ts"`      | Both     |
| 27  | dirname                     | `new Path("/foo/bar")`        | `Path("/foo")`     | `Path("/foo")`  | Both     |
| 28  | extension                   | `new Path("/foo/bar.ts")`     | `".ts"`            | `".ts"`         | Both     |
| 29  | startsWith                  | `path.startsWith("/foo")`     | Correct            | Correct         | Both     |
| 30  | isChildOf (true)            | `/foo/bar`.isChildOf(`/foo`)  | `true`             | `true`          | Both     |
| 31  | isChildOf (false - sibling) | `/foo-bar`.isChildOf(`/foo`)  | `false`            | `false`         | Both     |
| 32  | isChildOf (false - same)    | `/foo`.isChildOf(`/foo`)      | `false`            | `false`         | Both     |
| 33  | Resolve .. segments         | `/foo/bar/../baz`             | `/foo/baz`         | `/foo/baz`      | Both     |
| 34  | Root path only              | `C:/`                         | `c:/`              | N/A             | Windows  |
| 35  | Multiple slashes            | `/foo//bar`                   | `/foo/bar`         | `/foo/bar`      | Both     |

### Boundary Tests

| #   | Test Case                    | Interface   | External System | Behavior Verified                       |
| --- | ---------------------------- | ----------- | --------------- | --------------------------------------- |
| 1   | Git returns POSIX on Windows | `GitClient` | simple-git      | `worktree list` outputs forward slashes |

### Manual Testing Checklist

- [ ] Create project on Windows with path `C:\Users\Name\My Project`
- [ ] Create workspace, verify it appears in sidebar
- [ ] Switch between workspaces
- [ ] Delete workspace - verify cleanup completes (GitHub #4 test)
- [ ] Plugin extension connects correctly
- [ ] OpenCode starts and connects
- [ ] Restart app - verify project loads correctly
- [ ] MCP tools resolve workspace
- [ ] On Windows: Create project with `C:\Foo`, workspace with `C:\FOO\workspace`, verify match
- [ ] On Windows: Restart app with project path in different case, verify loads correctly

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | Using only Node.js built-ins | N/A      |

## Documentation Updates

### Files to Update

| File                   | Changes Required                                             |
| ---------------------- | ------------------------------------------------------------ |
| `docs/PATTERNS.md`     | Add "Path Handling Patterns" section with Path class API     |
| `docs/ARCHITECTURE.md` | Add Path class to Platform Abstractions, document boundaries |
| `AGENTS.md`            | Add Path class to Critical Rules; document path handling     |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [ ] Manual testing on Windows passes
- [ ] GitHub issue #4 resolved
- [x] No ad-hoc path normalization in codebase
- [x] All Maps use `path.toString()` for keys
- [ ] Changes committed

---

## Appendix: Path Class Implementation

````typescript
// src/services/platform/path.ts

import * as nodePath from "node:path";
import type { PlatformInfo } from "./platform-info";

// Default platform info (can be overridden for testing)
let platformInfo: PlatformInfo = {
  isWindows: process.platform === "win32",
  isMac: process.platform === "darwin",
  isLinux: process.platform === "linux",
  platform: process.platform,
};

/**
 * Set platform info for testing purposes.
 * @internal
 */
export function setPlatformInfoForTesting(info: PlatformInfo): void {
  platformInfo = info;
}

/**
 * Reset platform info to actual values.
 * @internal
 */
export function resetPlatformInfo(): void {
  platformInfo = {
    isWindows: process.platform === "win32",
    isMac: process.platform === "darwin",
    isLinux: process.platform === "linux",
    platform: process.platform,
  };
}

/**
 * Immutable path object that normalizes paths to a canonical internal format.
 *
 * ## Internal Format
 * - Always POSIX separators (forward slashes)
 * - Always absolute (relative paths throw error)
 * - Lowercase on Windows (case-insensitive filesystem)
 * - No trailing slashes (except root `/`)
 * - No `.` or `..` segments (resolved)
 *
 * ## Usage
 * ```typescript
 * // Single path (must be absolute)
 * const p1 = new Path("C:\\Users\\Name\\Project");
 * p1.toString(); // "c:/users/name/project"
 *
 * // Join paths
 * const p2 = new Path("/foo", "bar", "baz");
 * p2.toString(); // "/foo/bar/baz"
 *
 * // Extend existing path
 * const p3 = new Path(p2, "qux");
 * p3.toString(); // "/foo/bar/baz/qux"
 *
 * // Convert relative path (explicit)
 * const p4 = new Path(Path.cwd(), "./relative/path");
 *
 * // Comparison (never throws)
 * p1.equals(p2); // false
 * p1.equals("invalid"); // false (doesn't throw)
 *
 * // As Map key
 * const map = new Map<string, Data>();
 * map.set(path.toString(), data);
 * ```
 */
export class Path {
  private readonly _value: string;

  /**
   * Create a normalized Path.
   *
   * @param base - Base path (string or existing Path) - must be absolute
   * @param parts - Additional path segments to join (must not be empty/null)
   * @throws Error if path is empty, null, undefined, relative, or parts are invalid
   */
  constructor(base: string | Path, ...parts: string[]) {
    const joined = Path.joinParts(base, parts);
    this._value = Path.normalize(joined, platformInfo.isWindows);
  }

  /**
   * Join base and parts, validating inputs.
   */
  private static joinParts(base: string | Path, parts: string[]): string {
    // Validate base
    if (base === null || base === undefined) {
      throw new Error("Path cannot be null or undefined");
    }

    const baseStr = base instanceof Path ? base._value : base;

    if (baseStr === "") {
      throw new Error("Path cannot be empty");
    }

    // Validate parts
    for (const part of parts) {
      if (part === null || part === undefined) {
        throw new Error("Path parts cannot be null or undefined");
      }
      if (part === "") {
        throw new Error("Path parts cannot be empty strings");
      }
    }

    // Join parts if provided
    if (parts.length > 0) {
      const posixBase = baseStr.replace(/\\/g, "/");
      return nodePath.posix.join(posixBase, ...parts);
    }

    return baseStr;
  }

  /**
   * Normalize a joined path string.
   */
  private static normalize(joined: string, isWindows: boolean): string {
    // Convert to POSIX format
    let normalized = joined.replace(/\\/g, "/");

    // Collapse multiple slashes
    normalized = normalized.replace(/\/+/g, "/");

    // Check if path is absolute
    const isAbsolute = normalized.startsWith("/") || (isWindows && /^[a-zA-Z]:\//.test(normalized));

    if (!isAbsolute) {
      throw new Error(
        `Path must be absolute, got relative path: "${joined}". ` +
          `Use new Path(Path.cwd(), "${joined}") to convert relative paths.`
      );
    }

    // Resolve .. and . segments
    const segments = normalized.split("/");
    const resolvedSegments: string[] = [];

    for (const segment of segments) {
      if (segment === "..") {
        if (resolvedSegments.length > 1) {
          resolvedSegments.pop();
        }
      } else if (segment !== "." && segment !== "") {
        resolvedSegments.push(segment);
      } else if (segment === "" && resolvedSegments.length === 0) {
        resolvedSegments.push("");
      }
    }

    normalized = resolvedSegments.join("/");

    // Ensure Unix paths start with /
    if (!isWindows && !normalized.startsWith("/")) {
      normalized = "/" + normalized;
    }

    // Remove trailing slash (except root)
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    // Lowercase on Windows (case-insensitive filesystem)
    if (isWindows) {
      normalized = normalized.toLowerCase();
    }

    return normalized;
  }

  /**
   * Get the current working directory as a Path.
   */
  static cwd(): Path {
    return new Path(process.cwd());
  }

  /**
   * Get the normalized path string.
   * Use for Map keys, comparisons, and serialization.
   */
  toString(): string {
    return this._value;
  }

  /**
   * Get path in OS-native format.
   * Use when calling node:fs, spawning processes, or other OS APIs.
   */
  toNative(): string {
    if (platformInfo.isWindows) {
      return this._value.replace(/\//g, "\\");
    }
    return this._value;
  }

  /**
   * JSON serialization - returns normalized string.
   */
  toJSON(): string {
    return this._value;
  }

  /**
   * Implicit string conversion.
   */
  valueOf(): string {
    return this._value;
  }

  /**
   * For debugging - shows "Path" in console.
   */
  get [Symbol.toStringTag](): string {
    return "Path";
  }

  /**
   * Check equality with another path.
   * Returns false for invalid paths (never throws).
   */
  equals(other: Path | string): boolean {
    if (other instanceof Path) {
      return this._value === other._value;
    }
    try {
      return this._value === new Path(other)._value;
    } catch {
      return false;
    }
  }

  /**
   * Check if this path starts with a prefix.
   * Returns false for invalid prefix (never throws).
   */
  startsWith(prefix: Path | string): boolean {
    try {
      const prefixStr = prefix instanceof Path ? prefix._value : new Path(prefix)._value;
      return this._value === prefixStr || this._value.startsWith(prefixStr + "/");
    } catch {
      return false;
    }
  }

  /**
   * Check if this path is a child of (contained within) a parent path.
   * Unlike startsWith(), this properly handles edge cases like /foo vs /foo-bar.
   * Returns false if paths are equal (a path is not its own child).
   */
  isChildOf(parent: Path | string): boolean {
    try {
      const parentStr = parent instanceof Path ? parent._value : new Path(parent)._value;
      // Must start with parent + "/" to be a proper child
      return this._value.startsWith(parentStr + "/");
    } catch {
      return false;
    }
  }

  /**
   * Get relative path from a base.
   * Returns POSIX-style relative path string.
   * Note: Returns string, not Path, since relative paths cannot be Path instances.
   */
  relativeTo(base: Path | string): string {
    const baseStr = base instanceof Path ? base._value : new Path(base)._value;
    return nodePath.posix.relative(baseStr, this._value);
  }

  /**
   * Get the filename or final directory name.
   */
  get basename(): string {
    return nodePath.posix.basename(this._value);
  }

  /**
   * Get the parent directory as a Path.
   */
  get dirname(): Path {
    const dir = nodePath.posix.dirname(this._value);
    return new Path(dir);
  }

  /**
   * Get the file extension (including the dot).
   */
  get extension(): string {
    return nodePath.posix.extname(this._value);
  }

  /**
   * Get path segments as array.
   */
  get segments(): string[] {
    return this._value.split("/").filter(Boolean);
  }
}
````
