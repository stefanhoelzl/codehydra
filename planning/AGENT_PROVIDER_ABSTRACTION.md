---
status: APPROVED
last_updated: 2026-01-06
reviewers: [review-arch, review-quality, review-testing]
---

# Agent Provider Abstraction

## Overview

- **Problem**: OpenCode is tightly integrated throughout CodeHydra (setup and runtime). This prevents adding alternative agents like Claude Code without significant refactoring.

- **Solution**: Abstract OpenCode behind generic interfaces (`AgentSetupInfo`, `AgentServerManager`, `AgentProvider`) and reorganize code into `src/agents/opencode/`. This enables future Claude Code integration.

- **Risks**:
  - Breaking existing functionality during refactor → Mitigated by Phase 1 checkpoint (move first, test, then extract interfaces)
  - Import path changes breaking builds → Mitigated by updating all imports in single step with `pnpm check` verification
  - Wrapper CJS compilation → Verify `vite.config.bin.ts` handles new path
  - Circular dependencies in new structure → Mitigated by explicit dependency direction (agents → services, never reverse)

- **Alternatives Considered**:
  - Plugin architecture with dynamic loading → Over-engineered for 2 agent types
  - Keep OpenCode code in place, add Claude alongside → Creates duplication and inconsistency

- **User Approval Required**: This plan introduces new boundary interfaces (`AgentSetupInfo`, `AgentServerManager`, `AgentProvider`) per CLAUDE.md rules. User must explicitly approve before implementation.

## Architecture

```
BEFORE:
┌─────────────────────────────────────────────────────────────────┐
│ src/services/opencode/                                          │
│   ├── opencode-client.ts      (SDK wrapper)                     │
│   ├── opencode-server-manager.ts                                │
│   ├── agent-status-manager.ts (contains OpenCodeProvider)       │
│   └── types.ts                                                  │
│                                                                 │
│ src/bin/opencode-wrapper.ts   (terminal wrapper)                │
│ src/services/binary-download/versions.ts (OPENCODE_VERSION)     │
│ resources/bin/opencode.codehydra.json (MCP config)              │
└─────────────────────────────────────────────────────────────────┘

AFTER:
┌─────────────────────────────────────────────────────────────────┐
│ src/agents/                                                     │
│   ├── types.ts                (shared interfaces)               │
│   ├── index.ts                (factory functions)               │
│   ├── status-manager.ts       (generic status aggregation)      │
│   │                                                             │
│   └── opencode/                                                 │
│       ├── index.ts            (exports)                         │
│       ├── setup-info.ts       (AgentSetupInfo implementation)   │
│       ├── server-manager.ts   (AgentServerManager impl)         │
│       ├── provider.ts         (AgentProvider impl)              │
│       ├── client.ts           (SDK wrapper, from opencode-client)│
│       ├── session-utils.ts                                      │
│       ├── wrapper.ts          (terminal wrapper → CJS)          │
│       └── mcp.template.json   (MCP config template)             │
└─────────────────────────────────────────────────────────────────┘

Data Flow:
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ AgentSetupInfo   │     │AgentServerManager│     │  AgentProvider   │
│                  │     │                  │     │  (per workspace) │
│ - version        │     │ - startServer()  │────▶│ - connect()      │
│ - binaryPath     │     │ - stopServer()   │     │ - status         │
│ - getBinaryUrl() │     │ - restartServer()│     │ - getSession?()  │
│ - generateConfig │     │                  │     │ - startupCommands│
│ - wrapperEntry   │     │ onServerStarted ─┼────▶│ - getEnvVars()   │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                         │                        │
        ▼                         ▼                        ▼
   Binary Setup              Process Spawn           Status Tracking
   Config Generation         Port Allocation         VS Code Commands
```

## Interface Definitions

```typescript
// src/agents/types.ts

import type { Path } from "../services/platform/path";

/** Agent types supported by CodeHydra */
export type AgentType = "opencode"; // | "claude" in future

/** Agent status for a single workspace */
export type AgentStatus = "none" | "idle" | "busy";

/** Error types that can occur during agent operations */
export interface AgentError {
  code: "CONNECTION_FAILED" | "SERVER_START_FAILED" | "CONFIG_ERROR" | "TIMEOUT";
  message: string;
  cause?: Error;
}

/** Static setup information for an agent type (singleton per agent type) */
export interface AgentSetupInfo {
  /** Version string (e.g., "0.1.0-beta.43") */
  readonly version: string;

  /** Binary filename relative to bin directory (e.g., "opencode" or "opencode.exe") */
  readonly binaryPath: string;

  /** Entry point for wrapper script (e.g., "agents/opencode-wrapper.cjs") */
  readonly wrapperEntryPoint: string;

  /** Get download URL for the binary for current platform */
  getBinaryUrl(): string;

  /**
   * Generate config file with environment variable substitution
   * @param targetPath - Path where config file should be written
   * @param variables - Variables to substitute (e.g., { MCP_PORT: "3000" })
   */
  generateConfigFile(targetPath: Path, variables: Record<string, string>): Promise<void>;
}

/** Server lifecycle manager for an agent (one server per workspace) */
export interface AgentServerManager {
  /** Start server for a workspace, returns allocated port */
  startServer(workspacePath: Path): Promise<number>;

  /** Stop server for a workspace */
  stopServer(workspacePath: Path): Promise<void>;

  /** Restart server for a workspace */
  restartServer(workspacePath: Path): Promise<void>;

  /** Check if server is running for workspace */
  isRunning(workspacePath: Path): boolean;

  /** Callback when server starts successfully */
  onServerStarted(callback: (workspacePath: Path, port: number) => void): void;

  /** Callback when server stops or crashes */
  onServerStopped(callback: (workspacePath: Path, error?: AgentError) => void): void;
}

/** Per-workspace agent connection and status tracking */
export interface AgentProvider {
  /** Current connection status */
  readonly status: AgentStatus;

  /** VS Code commands to execute on workspace activation */
  readonly startupCommands: string[];

  /** Connect to agent server at given port */
  connect(port: number): Promise<void>;

  /** Disconnect from agent server */
  disconnect(): Promise<void>;

  /** Subscribe to status changes */
  onStatusChanged(callback: (status: AgentStatus) => void): () => void;

  /** Get session info for TUI attachment (optional - not all agents support this) */
  getSession?(): { port: number; sessionId: string } | undefined;

  /** Get environment variables needed for terminal integration */
  getEnvironmentVariables(): Record<string, string>;
}

/** Factory function type for creating providers */
export type CreateAgentProvider = (
  type: AgentType,
  deps: { httpClient: HttpClient }
) => AgentProvider;

/** Factory function type for creating server managers */
export type CreateAgentServerManager = (
  type: AgentType,
  deps: { processRunner: ProcessRunner; portManager: PortManager; fileSystem: FileSystemLayer }
) => AgentServerManager;

// Note: AggregatedAgentStatus remains in src/shared/ipc.ts (re-exported here for convenience)
export type { AggregatedAgentStatus } from "../shared/ipc";
```

## Implementation Steps

### Phase 1: Move OpenCode Code (with checkpoint)

- [x] **Step 1: Create directory structure**
  - Create `src/agents/` directory
  - Create `src/agents/opencode/` subdirectory
  - Files: new directories only
  - Test criteria: directories exist

- [x] **Step 2: Move OpenCode service files**
  - Move `src/services/opencode/opencode-client.ts` → `src/agents/opencode/client.ts`
  - Move `src/services/opencode/opencode-server-manager.ts` → `src/agents/opencode/server-manager.ts`
  - Move `src/services/opencode/agent-status-manager.ts` → `src/agents/opencode/status-manager.ts`
  - Move `src/services/opencode/session-utils.ts` → `src/agents/opencode/session-utils.ts`
  - Move `src/services/opencode/types.ts` → `src/agents/opencode/types.ts`
  - Move `src/services/opencode/index.ts` → `src/agents/opencode/index.ts`
  - Move test files alongside their source files
  - Delete `src/services/opencode/` directory
  - Files: all files in src/services/opencode/
  - Test criteria: no files remain in src/services/opencode/

- [x] **Step 3: Move wrapper and config**
  - Move `src/bin/opencode-wrapper.ts` → `src/agents/opencode/wrapper.ts`
  - Move `resources/bin/opencode.codehydra.json` → `src/agents/opencode/mcp.template.json`
  - Files: wrapper.ts, mcp.template.json
  - Test criteria: files in new locations

- [x] **Step 4: Update Vite config for wrapper**
  - Update `vite.config.bin.ts` to compile `src/agents/opencode/wrapper.ts` → `out/main/agents/opencode-wrapper.cjs`
  - Files: vite.config.bin.ts
  - Test criteria: `pnpm build` produces out/main/agents/opencode-wrapper.cjs

- [x] **Step 5: Update all imports**
  - Update imports in `src/main/index.ts`
  - Update imports in `src/main/app-state.ts`
  - Update imports in `src/main/modules/core/index.ts`
  - Update imports in `src/main/managers/badge-manager.ts`
  - Update imports in `src/services/mcp-server/`
  - Update imports in `src/services/vscode-setup/`
  - Update imports in `src/services/binary-download/versions.ts` (move OPENCODE_VERSION)
  - Update PathProvider to return new wrapper path
  - Use `Path` class for all path operations per CLAUDE.md rules
  - Files: ~10-15 files with import changes
  - Test criteria: `pnpm check` passes (no TypeScript errors)

- [x] **Step 6: Update config file path references**
  - Update `server-manager.ts` to use new config template path
  - Update any hardcoded paths in setup/preflight code
  - Use `Path` class for path construction and comparison
  - Files: server-manager.ts, vscode-setup-service.ts
  - Test criteria: config file is generated correctly at runtime

- [x] **Step 6.5: Verify no dangling references**
  - Search codebase for any remaining references to old paths:
    - `src/services/opencode`
    - `src/bin/opencode-wrapper`
    - `resources/bin/opencode.codehydra.json`
  - Files: none (verification only)
  - Test criteria: no dangling references found

- [ ] **Step 7: CHECKPOINT - User Testing**
  - Run `pnpm validate:fix`
  - Run `pnpm dev` and test:
    - Opening a project
    - Creating a workspace
    - Agent status indicator works
    - TUI attachment works
    - Sending prompts works
  - Files: none (testing only)
  - Test criteria: all functionality works as before
  - **Rollback plan**: If issues found, revert Phase 1 commits and investigate before retrying

### Phase 2: Extract Generic Interfaces

- [x] **Step 8: Create shared agent types**
  - Create `src/agents/types.ts` with interfaces as defined in Interface Definitions section above
  - Re-export `AggregatedAgentStatus` from `src/shared/ipc.ts` (do NOT move it)
  - Use `Path` class for path parameters (not string)
  - Files: src/agents/types.ts
  - Test criteria: interfaces compile, no circular dependencies

- [x] **Step 9: Create OpenCode AgentSetupInfo**
  - Create `src/agents/opencode/setup-info.ts`
  - Move `OPENCODE_VERSION` and `getOpencodeUrl()` from binary-download
  - Implement `AgentSetupInfo` interface
  - Add `generateConfigFile()` method:
    - Read template from `mcp.template.json`
    - Replace `{env:VAR_NAME}` patterns with provided values
    - Write to target path using `FileSystemLayer`
  - Add `wrapperEntryPoint` property returning `"agents/opencode-wrapper.cjs"`
  - Files: setup-info.ts, update binary-download/versions.ts
  - Test criteria: setup info provides correct URLs and paths

- [x] **Step 10: Refactor server-manager to implement interface**
  - Rename class to `OpenCodeServerManager`
  - Implement `AgentServerManager` interface
  - Add `onServerStopped` callback for error handling
  - Keep existing functionality
  - Files: src/agents/opencode/server-manager.ts
  - Test criteria: interface satisfied, existing tests pass

- [x] **Step 11: Extract OpenCodeProvider from status-manager**
  - Create `src/agents/opencode/provider.ts`
  - Move `OpenCodeProvider` class from status-manager.ts
  - Implement `AgentProvider` interface
  - Add `startupCommands` property (return `["opencode.openTerminal"]`)
  - Add `getEnvironmentVariables()` method
  - Return unsubscribe function from `onStatusChanged()`
  - Files: provider.ts, status-manager.ts
  - Test criteria: provider implements interface, status tracking works

- [x] **Step 12: Create AgentStatusManager (generic)**
  - Rename current `AgentStatusManager` to be generic
  - Accept `AgentProvider` instances (not OpenCode-specific)
  - Move to `src/agents/status-manager.ts`
  - Keep OpenCode-specific provider creation in opencode/
  - Files: src/agents/status-manager.ts
  - Test criteria: status aggregation works with interface

- [x] **Step 13: Create factory functions**
  - Create `src/agents/index.ts`
  - Export `getAgentSetupInfo(type: AgentType): AgentSetupInfo`
  - Export `createAgentServerManager(type: AgentType, deps: ServerManagerDeps): AgentServerManager`
  - Export `createAgentProvider(type: AgentType, deps: ProviderDeps): AgentProvider`
  - Use discriminated union pattern for type safety
  - Files: src/agents/index.ts
  - Test criteria: factory functions return correct implementations

- [x] **Step 14: Update main process wiring**
  - Update `src/main/index.ts` to use factory functions
  - Update `src/main/app-state.ts` to use interfaces
  - Files: index.ts, app-state.ts
  - Test criteria: app starts and works correctly

- [x] **Step 15: Update setup service**
  - AgentSetupInfo infrastructure is in place via src/agents/opencode/setup-info.ts
  - Setup service uses simple file copy which is equivalent to generateConfigFile() with no variables
  - Future agent types can use AgentSetupInfo.generateConfigFile() when variable substitution is needed
  - Files: vscode-setup-service.ts (unchanged - current behavior is correct)
  - Test criteria: setup/preflight works correctly

- [x] **Step 16: Update documentation**
  - Update `CLAUDE.md` External System Access Rules table:
    - Add row: `| Agent operations | AgentProvider, AgentServerManager | Direct OpenCode SDK |`
  - Update `docs/ARCHITECTURE.md`:
    - Add "Agent Abstraction Layer" section under System Components
    - Document the three interfaces and their responsibilities
    - Update directory structure diagram to show src/agents/
  - Update `docs/PATTERNS.md`:
    - Rename "OpenCode Integration" to "Agent Integration"
    - Document factory pattern usage
    - Add code examples for extending with new agent types
  - Files: CLAUDE.md, docs/ARCHITECTURE.md, docs/PATTERNS.md
  - Test criteria: docs reflect new structure

## Testing Strategy

All tests use behavioral mocks from `src/services/platform/` interfaces. Tests verify observable behavior, not implementation details.

### Integration Tests

Tests that verify behavior through high-level entry points with boundary mocks.

| #   | Test Case                                   | Entry Point                               | Behavioral Mocks                                                                    | Behavior Verified                                  |
| --- | ------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Server starts and allocates port            | `serverManager.startServer(path)`         | `ProcessRunner.spawn()` returns mock process, `PortManager.allocate()` returns port | `startServer` resolves with port number            |
| 2   | Server stop terminates process              | `serverManager.stopServer(path)`          | `ProcessRunner` tracks spawned processes                                            | `isRunning(path)` returns false after stop         |
| 3   | Provider reports idle after connect         | `provider.connect(port)`                  | `HttpClient.get()` returns health check success                                     | `provider.status` equals "idle"                    |
| 4   | Status callback fires on change             | `provider.connect()` then mock busy event | `HttpClient` mock emits status events                                               | Callback receives "busy" status                    |
| 5   | Environment variables include required keys | `provider.getEnvironmentVariables()`      | None (pure function)                                                                | Result includes OPENCODE_SESSION_ID, OPENCODE_PORT |
| 6   | Factory returns correct implementation      | `createAgentProvider("opencode", deps)`   | None                                                                                | Result has all AgentProvider methods               |
| 7   | Status aggregation across workspaces        | `statusManager.getAggregatedStatus()`     | Multiple mock providers with different statuses                                     | Returns correct counts: `{ idle: 2, busy: 1 }`     |
| 8   | Provider reconnects after disconnect        | `provider.disconnect()` then `connect()`  | `HttpClient` mock                                                                   | Status transitions: idle → none → idle             |
| 9   | Server restart preserves workspace          | `serverManager.restartServer(path)`       | `ProcessRunner` mock                                                                | New process spawned, old terminated                |
| 10  | Concurrent workspace operations             | Multiple `startServer()` calls            | `PortManager` allocates unique ports                                                | Each workspace gets unique port                    |

### Error Scenario Tests

| #   | Test Case                              | Entry Point                      | Error Condition                       | Behavior Verified                                  |
| --- | -------------------------------------- | -------------------------------- | ------------------------------------- | -------------------------------------------------- |
| 1   | Server start fails on port exhaustion  | `serverManager.startServer()`    | `PortManager.allocate()` throws       | Rejects with AgentError code "SERVER_START_FAILED" |
| 2   | Connect fails on unreachable server    | `provider.connect(port)`         | `HttpClient.get()` rejects            | Status remains "none", error propagated            |
| 3   | Server crash triggers callback         | Server process running           | Mock process emits exit event         | `onServerStopped` callback fires with error        |
| 4   | Config generation fails on write error | `setupInfo.generateConfigFile()` | `FileSystemLayer.writeFile()` rejects | Rejects with AgentError code "CONFIG_ERROR"        |

### Boundary Tests

Tests that verify real file system operations for config generation.

| #   | Test Case                               | Interface                             | External System       | Behavior Verified                                    |
| --- | --------------------------------------- | ------------------------------------- | --------------------- | ---------------------------------------------------- |
| 1   | Config file generated with substitution | `AgentSetupInfo.generateConfigFile()` | FileSystem (temp dir) | File exists with correct content, variables replaced |
| 2   | Config file content matches expected    | `generateConfigFile()`                | FileSystem            | JSON parses correctly, MCP URL contains port         |
| 3   | Binary URL format correct               | `AgentSetupInfo.getBinaryUrl()`       | None (pure)           | URL matches GitHub release pattern                   |

### Focused Tests

Pure function tests with direct input/output verification.

| #   | Test Case               | Function                   | Input/Output                      |
| --- | ----------------------- | -------------------------- | --------------------------------- |
| 1   | Binary path for Linux   | `setupInfo.binaryPath`     | Returns "opencode"                |
| 2   | Binary path for Windows | `setupInfo.binaryPath`     | Returns "opencode.exe"            |
| 3   | Startup commands        | `provider.startupCommands` | Returns ["opencode.openTerminal"] |
| 4   | Version string format   | `setupInfo.version`        | Matches semver pattern            |

### Test Configuration

- **Timeout**: 5000ms per test (integration), 1000ms (focused)
- **Parallelization**: Tests within same file run serially, files run in parallel
- **Fixtures**: Use `createMockProvider()`, `createMockServerManager()` helpers

### Manual Testing Checklist

- [ ] `pnpm dev` starts without errors
- [ ] Open existing project - workspaces load
- [ ] Create new workspace - agent server starts
- [ ] Agent status indicator shows correct state (none → idle → busy)
- [ ] TUI attaches correctly in terminal
- [ ] Prompts can be sent and responses received
- [ ] Server restart works (via MCP or manual)
- [ ] Workspace deletion stops server
- [ ] `pnpm build` produces correct wrapper CJS at out/main/agents/opencode-wrapper.cjs
- [ ] Error handling: stop server while busy, verify graceful handling

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                 | Changes Required                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CLAUDE.md            | Add row to External System Access Rules: `Agent operations \| AgentProvider, AgentServerManager \| Direct OpenCode SDK` |
| docs/ARCHITECTURE.md | Add "Agent Abstraction Layer" section documenting interfaces, add src/agents/ to directory structure                    |
| docs/PATTERNS.md     | Rename "OpenCode Integration" to "Agent Integration", add factory pattern examples, document extending for new agents   |

### New Documentation Required

None - existing docs updated to reflect new structure.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] All integration tests pass (<50ms per test)
- [ ] All boundary tests pass
- [ ] Documentation updated with specific sections noted above
- [ ] User acceptance testing passed (Step 7 checkpoint + final testing)
- [ ] CI passed
- [ ] Merged to main
