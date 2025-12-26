---
status: COMPLETED
last_updated: 2025-12-17
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

> **Superseded by WINDOWS_TASKKILL_FIX.md**: The ProcessTreeProvider approach was removed because taskkill /t handles tree killing natively without needing to enumerate child PIDs. The simpler solution is to always use forceful termination on Windows.

# WINDOWS_PROCESS_TREE

## Overview

- **Problem**: `pidtree` uses `wmic.exe` which Microsoft has removed from Windows 11 24H2+, Windows Server 2025, and GitHub Actions `windows-2025` runners. This breaks process tree lookups on modern Windows.
- **Solution**: Add `@vscode/windows-process-tree` as a Windows-specific implementation with automatic platform detection. Keep `pidtree` for Linux/macOS where it works reliably.
- **Risks**:
  - Native module requires Visual Studio Build Tools on Windows dev machines (mitigated: one-time setup, CI has tools pre-installed, end users get packaged app)
  - Native module needs Electron rebuild (mitigated: `electron-builder` handles this automatically)
- **Alternatives Considered**:
  - `systeminformation`: ~600ms per query (30x slower than pidtree's 20ms) - rejected for performance
  - Fork with prebuildify: Avoids build tools but adds maintenance burden - rejected for complexity
  - Replace `pidtree` everywhere: `@vscode/windows-process-tree` is Windows-only - not possible

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      DiscoveryService                           │
│                            │                                    │
│                            ▼                                    │
│               ProcessTreeProvider (interface)                   │
│                            │                                    │
│          ┌─────────────────┴─────────────────┐                  │
│          ▼                                   ▼                  │
│   ┌──────────────────┐            ┌────────────────────────┐    │
│   │ PidtreeProvider  │            │ WindowsProcessTree     │    │
│   │ (Linux/macOS)    │            │ Provider (Windows)     │    │
│   │                  │            │                        │    │
│   │  uses: pidtree   │            │ uses: @vscode/windows- │    │
│   │  (~20ms)         │            │       process-tree     │    │
│   │  logger: pidtree │            │       (~20ms)          │    │
│   │                  │            │  logger: pidtree       │    │
│   └──────────────────┘            └────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

Factory function (automatic platform detection):
┌─────────────────────────────────────────────────────────────────┐
│ createProcessTreeProvider(logger: Logger): ProcessTreeProvider  │
│                                                                 │
│   if (process.platform === 'win32')                             │
│     return new WindowsProcessTreeProvider(logger)               │
│   else                                                          │
│     return new PidtreeProvider(logger)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Add @vscode/windows-process-tree dependency**
  - Install as optional dependency: `npm install @vscode/windows-process-tree --save-optional`
  - This prevents npm install from failing on non-Windows platforms
  - Use `import type` for TypeScript types to avoid triggering native module load at compile time
  - Files: `package.json`
  - Test criteria:
    - `npm install` succeeds on Linux/macOS (skips native build)
    - `package.json` has `optionalDependencies` entry for `@vscode/windows-process-tree`

- [x] **Step 2: Create WindowsProcessTreeProvider implementation**
  - Implement `ProcessTreeProvider` interface using `@vscode/windows-process-tree`
  - Use `getProcessTree()` API which returns recursive tree structure (simpler than `getProcessList()`)
  - Use dynamic import in `getDescendantPids()` method to lazy-load the native module
  - Cache the native module after first load to avoid repeated dynamic imports
  - Promisify the callback-based API using manual wrapper
  - Handle errors gracefully with try/catch (return empty Set on any failure)
  - Handle `undefined` tree result (process not found) - return empty Set
  - Keep logger name as `[pidtree]` for consistency with existing logging
  - Files: `src/services/opencode/process-tree.ts`
  - Test criteria: Unit tests pass with mocked native module

  **Implementation pattern:**

  ```typescript
  import type { IProcessTreeNode } from "@vscode/windows-process-tree";

  type WindowsProcessTreeModule = typeof import("@vscode/windows-process-tree");

  export class WindowsProcessTreeProvider implements ProcessTreeProvider {
    private nativeModule: WindowsProcessTreeModule | null | undefined = undefined;

    constructor(private readonly logger: Logger) {}

    async getDescendantPids(pid: number): Promise<Set<number>> {
      try {
        const module = await this.getNativeModule();
        if (!module) {
          return new Set();
        }

        const tree = await this.getProcessTreeAsync(module, pid);
        if (tree === undefined) {
          this.logger.debug("Process not found", { pid });
          return new Set();
        }

        const descendants = this.collectDescendantPids(tree);
        this.logger.debug("GetDescendants", { pid, count: descendants.size });
        return descendants;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn("GetDescendants failed", { pid, error: errMsg });
        return new Set();
      }
    }

    private async getNativeModule(): Promise<WindowsProcessTreeModule | null> {
      if (this.nativeModule === undefined) {
        try {
          this.nativeModule = await import("@vscode/windows-process-tree");
        } catch {
          this.logger.warn("Failed to load windows-process-tree native module");
          this.nativeModule = null;
        }
      }
      return this.nativeModule;
    }

    private getProcessTreeAsync(
      module: WindowsProcessTreeModule,
      pid: number
    ): Promise<IProcessTreeNode | undefined> {
      return new Promise((resolve) => {
        module.getProcessTree(pid, (tree) => resolve(tree));
      });
    }

    private collectDescendantPids(node: IProcessTreeNode): Set<number> {
      const pids = new Set<number>();
      for (const child of node.children) {
        pids.add(child.pid);
        for (const grandchildPid of this.collectDescendantPids(child)) {
          pids.add(grandchildPid);
        }
      }
      return pids;
    }
  }
  ```

- [x] **Step 3: Create factory function for platform-based selection**
  - Add `createProcessTreeProvider(logger): ProcessTreeProvider` factory
  - Returns `WindowsProcessTreeProvider` on win32, `PidtreeProvider` otherwise
  - Wrap factory in try-catch: if native module fails to load on Windows, fall back to `PidtreeProvider`
  - Export factory from module index
  - Files: `src/services/opencode/process-tree.ts`, `src/services/opencode/index.ts`
  - Test criteria: Factory returns correct type based on `process.platform`

- [x] **Step 4: Refactor boundary tests to be implementation-agnostic**
  - Tests verify the `ProcessTreeProvider` interface contract
  - Use factory function to get platform-appropriate provider
  - Same tests run on all platforms, testing whichever implementation is active
  - This ensures both implementations behave identically
  - Avoid platform-specific assumptions (don't test for specific PID values)
  - Add verification test that correct implementation is used on each platform
  - Files: `src/services/opencode/process-tree.boundary.test.ts`
  - Test criteria: Tests pass on Linux CI and Windows CI

- [x] **Step 5: Update main process wiring**
  - Replace direct `new PidtreeProvider(logger)` with `createProcessTreeProvider(logger)`
  - Location: `src/main/index.ts` in `startServices()` function (around line 277-284)
  - Files: `src/main/index.ts`
  - Test criteria: App runs correctly, OpenCode discovery works

- [x] **Step 6: Add unit tests for WindowsProcessTreeProvider**
  - Use dependency injection pattern: inject the native module getter for testability
  - Test descendant PID extraction from tree structure
  - Test multi-level trees (grandchildren)
  - Test error handling (returns empty Set)
  - Test with empty process list
  - Test native module load failure handling
  - Files: `src/services/opencode/process-tree.test.ts`
  - Test criteria: All unit tests pass, good coverage

- [x] **Step 7: Verify Windows CI configuration**
  - Ensure `.github/workflows/ci.yml` runs boundary tests on Windows matrix entry
  - Use `windows-2025` runner to verify fix works where wmic.exe is missing
  - Files: `.github/workflows/ci.yml` (if changes needed)
  - Test criteria: Windows CI runs `npm run test:boundary` successfully

- [x] **Step 8: Clean up benchmark scripts**
  - Remove temporary benchmark scripts from `scripts/` directory
  - Files: `scripts/benchmark-si-processes.ts`, `scripts/benchmark-si-loop.ts`
  - Test criteria: Scripts removed

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                                                 | Description                           | File                   |
| ------------------------------------------------------------------------- | ------------------------------------- | ---------------------- |
| `WindowsProcessTreeProvider extracts descendant PIDs`                     | Verifies PID extraction from tree     | `process-tree.test.ts` |
| `WindowsProcessTreeProvider extracts multi-level descendants`             | Verifies grandchildren are included   | `process-tree.test.ts` |
| `WindowsProcessTreeProvider handles empty result`                         | Returns empty Set when no descendants | `process-tree.test.ts` |
| `WindowsProcessTreeProvider handles undefined tree`                       | Returns empty Set on lookup failure   | `process-tree.test.ts` |
| `WindowsProcessTreeProvider handles native module load failure`           | Returns empty Set, logs warning       | `process-tree.test.ts` |
| `WindowsProcessTreeProvider handles errors`                               | Returns empty Set, logs warning       | `process-tree.test.ts` |
| `WindowsProcessTreeProvider caches native module`                         | Only loads module once                | `process-tree.test.ts` |
| `createProcessTreeProvider returns PidtreeProvider on non-Windows`        | Platform detection                    | `process-tree.test.ts` |
| `createProcessTreeProvider returns WindowsProcessTreeProvider on Windows` | Platform detection (mocked)           | `process-tree.test.ts` |

### Boundary Tests (platform-agnostic)

| Test Case                                           | Description                | File                            |
| --------------------------------------------------- | -------------------------- | ------------------------------- |
| `smoke test - provider works on current platform`   | Basic functionality        | `process-tree.boundary.test.ts` |
| `returns descendant PIDs for process with children` | Core contract verification | `process-tree.boundary.test.ts` |
| `returns empty Set for process without children`    | Edge case                  | `process-tree.boundary.test.ts` |
| `returns empty Set for non-existent PID`            | Error handling             | `process-tree.boundary.test.ts` |
| `returns empty Set after process exits`             | Race condition handling    | `process-tree.boundary.test.ts` |
| `uses correct implementation for platform`          | Verifies factory selection | `process-tree.boundary.test.ts` |
| `completes within 50ms`                             | Performance verification   | `process-tree.boundary.test.ts` |

### Integration Tests

| Test Case                                        | Description         | File                                    |
| ------------------------------------------------ | ------------------- | --------------------------------------- |
| `DiscoveryService uses factory-created provider` | Wiring verification | `discovery-service.integration.test.ts` |

### Manual Testing Checklist

- [ ] Run `npm install` on Windows (verify native module compiles)
- [ ] Run `npm install` on Linux/macOS (verify it doesn't fail)
- [ ] Run `npm run test:boundary` on Windows (use Windows 2025 runner)
- [ ] Run `npm run test:boundary` on Linux/macOS
- [ ] Start app on Windows, verify OpenCode agent discovery works
- [ ] Start app on Linux/macOS, verify OpenCode agent discovery works
- [ ] Verify factory returns correct provider type via debug logging

## Dependencies

| Package                        | Purpose                                                                 | Approved |
| ------------------------------ | ----------------------------------------------------------------------- | -------- |
| `@vscode/windows-process-tree` | Native Windows process tree lookups (~20ms, uses Windows APIs directly) | [x]      |

**Note**: This is a native C++ addon. Windows developers need Visual Studio Build Tools with "Desktop development with C++" workload. GitHub Actions Windows runners have this pre-installed.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Add note about Windows build tools requirement for development                                                       |
| `docs/ARCHITECTURE.md` | Update ProcessTreeProvider section to describe platform-specific implementations; update Platform Abstractions table |

### New Documentation Required

None - this is an internal implementation detail.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes on Linux
- [ ] Boundary tests pass on Windows CI (windows-2025 runner)
- [ ] Boundary tests pass on Linux CI
- [ ] Documentation updated (AGENTS.md, ARCHITECTURE.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
