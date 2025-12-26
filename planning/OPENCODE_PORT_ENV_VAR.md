---
status: DONE
last_updated: 2025-12-26
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# OPENCODE_PORT_ENV_VAR

## Overview

- **Problem**: The opencode CLI wrapper uses `ports.json` to find the OpenCode server port. This requires git root detection, file I/O, and JSON parsing - unnecessary complexity since the sidekick extension already has access to the port via `api.workspace.getOpencodePort()`.
- **Solution**: Have the sidekick extension set `CODEHYDRA_OPENCODE_PORT` environment variable for all terminals. The wrapper script simply reads this env var.
- **Risks**:
  - Terminals opened before extension activation won't have the env var (mitigated: extension is activated via command before terminals are used)
  - If `getOpencodePort()` returns null, env var won't be set (acceptable: wrapper will error with clear message)
  - Env var only affects NEW terminals - existing terminals keep old value (acceptable: users open new terminal if server restarts)
  - Race condition: terminal opened immediately after activation but before `getOpencodePort()` completes won't have env var (rare edge case, acceptable)
- **Alternatives Considered**:
  - Keep ports.json (rejected: unnecessary file I/O and complexity)
  - Pass port via command argument (rejected: requires modifying how terminals are spawned)

## Architecture

```
BEFORE:
┌─────────────────────────────────────────────────────────────────────┐
│ OpenCodeServerManager                                               │
│   startServer() ──► health check ──► writePortsFile()               │
│   stopServer()  ──► kill process ──► writePortsFile()               │
│                                                                     │
│   ports.json: { workspaces: { "/path": { port: 12345 } } }          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ opencode.cjs wrapper                                                │
│   1. git rev-parse --show-toplevel                                  │
│   2. readFileSync(ports.json)                                       │
│   3. JSON.parse + lookup workspace                                  │
│   4. spawnSync(opencode, ["attach", url])                           │
└─────────────────────────────────────────────────────────────────────┘

AFTER:
┌─────────────────────────────────────────────────────────────────────┐
│ OpenCodeServerManager                                               │
│   startServer() ──► health check ──► (no file write)                │
│   stopServer()  ──► kill process ──► (no file write)                │
│   Port stored in memory only (this.servers Map)                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ getOpencodePort() via PluginServer
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ sidekick extension (in socket "connect" handler)                    │
│   1. codehydraApi.workspace.getOpencodePort()                       │
│   2. .then((port) => {                                              │
│        if (port !== null) {                                         │
│          ctx.environmentVariableCollection.replace(                 │
│            'CODEHYDRA_OPENCODE_PORT', String(port));                │
│          log("Set CODEHYDRA_OPENCODE_PORT=" + port);                │
│        }                                                            │
│      })                                                             │
│   3. .catch((err) => logError("Failed to get port: " + err))        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ env var injected into NEW terminals
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ opencode.cjs wrapper (simplified)                                   │
│   1. portStr = process.env.CODEHYDRA_OPENCODE_PORT                  │
│   2. if (!portStr) error + exit(1)                                  │
│   3. port = parseInt(portStr, 10)                                   │
│   4. if (isNaN(port) || port <= 0 || port > 65535) error + exit(1)  │
│   5. spawnSync(opencode, ["attach", url])                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Update sidekick extension to set env var**
  - Modify `src/services/vscode-setup/assets/codehydra-sidekick/extension.js`
  - In the `socket.on('connect')` callback, after setting `isConnected = true`:
    ```javascript
    // Set opencode port env var for terminals
    codehydraApi.workspace
      .getOpencodePort()
      .then((port) => {
        if (port !== null) {
          context.environmentVariableCollection.replace("CODEHYDRA_OPENCODE_PORT", String(port));
          log("Set CODEHYDRA_OPENCODE_PORT=" + port);
        }
      })
      .catch((err) => {
        logError("Failed to get opencode port: " + err.message);
      });
    ```
  - In `deactivate()` function, clear the env var:
    ```javascript
    if (extensionContext) {
      extensionContext.environmentVariableCollection.clear();
    }
    ```
  - Files affected:
    - `src/services/vscode-setup/assets/codehydra-sidekick/extension.js`
  - Test criteria (note: VS Code `environmentVariableCollection` API requires manual verification):
    - Extension sets env var when port is available
    - Extension handles null port gracefully (no env var set)
    - Extension logs env var changes for debugging
    - Extension clears env var on deactivation

- [x] **Step 2: Simplify opencode wrapper script**
  - Modify `src/services/vscode-setup/bin-scripts.ts`
  - Replace `generateOpencodeNodeScript()` body with:

    ```javascript
    // 1. Read env var
    const portStr = process.env.CODEHYDRA_OPENCODE_PORT;
    if (!portStr) {
      console.error("Error: CODEHYDRA_OPENCODE_PORT not set.");
      console.error("Make sure you're in a CodeHydra workspace terminal.");
      process.exit(1);
    }

    // 2. Validate port number
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      console.error("Error: Invalid CODEHYDRA_OPENCODE_PORT: " + portStr);
      process.exit(1);
    }

    // 3. Spawn opencode attach
    const url = "http://127.0.0.1:" + port;
    const result = spawnSync(OPENCODE_BIN, ["attach", url], { stdio: "inherit" });
    process.exit(result.status ?? 1);
    ```

  - Remove: git detection logic, PORTS_FILE constant, `fs` imports (`existsSync`, `readFileSync`), `execSync` import, JSON parsing
  - Keep: OPENCODE_BIN path construction, `spawnSync` import, `path.join` for binary path
  - Shell wrapper scripts (`opencode`, `opencode.cmd`) remain unchanged - they still invoke `opencode.cjs` with Node.js
  - Files affected:
    - `src/services/vscode-setup/bin-scripts.ts`
    - `src/services/vscode-setup/bin-scripts.test.ts`
    - `src/services/vscode-setup/bin-scripts.boundary.test.ts`
  - Test criteria:
    - (unit test) Generated script reads `CODEHYDRA_OPENCODE_PORT` env var
    - (unit test) Generated script validates port is numeric and in valid range
    - (unit test) Generated script errors with clear message when env var not set
    - (unit test) Generated script errors with clear message when port is invalid
    - (boundary test) Wrapper spawns opencode attach with correct URL when env var set
    - (boundary test) Wrapper fails gracefully without env var

- [x] **Step 3: Remove ports.json management from OpenCodeServerManager**
  - Modify `src/services/opencode/opencode-server-manager.ts`
  - Remove:
    - `PortsFile` interface
    - `getPortsFilePath()` method
    - `readPortsFile()` method
    - `writePortsFile()` method
    - `writePortsFileContent()` method
    - `cleanupStaleEntries()` method (no longer needed - stale processes cleaned via process tree)
    - All calls to these methods in `startServer()` and `stopServer()`
  - Remove unused imports after refactor (e.g., `path.dirname` if no longer used)
  - Files affected:
    - `src/services/opencode/opencode-server-manager.ts`
    - `src/services/opencode/opencode-server-manager.test.ts`
    - `src/services/opencode/opencode-server-manager.integration.test.ts`
    - `src/services/opencode/opencode-server-manager.boundary.test.ts`
  - Test criteria:
    - (unit test) startServer stores port in memory (this.servers Map)
    - (unit test) stopServer removes port from memory
    - (unit test) getPort() returns correct port after startServer
    - (integration test) Server start/stop lifecycle works without file I/O
    - (boundary test) No ports.json file created during server operations

- [x] **Step 4: Update documentation**
  - Update `AGENTS.md`:
    - Remove "opencode wrapper architecture" diagram showing ports.json
    - Update CLI Wrapper Scripts section to show env var approach
    - Update diagram to: `opencode wrapper → reads $CODEHYDRA_OPENCODE_PORT → opencode attach`
  - Update `docs/ARCHITECTURE.md`:
    - Remove obsolete "Ports File Format" section if present
    - Update any OpenCode server flow diagrams to remove ports.json references
  - Files affected:
    - `AGENTS.md`
    - `docs/ARCHITECTURE.md`
  - Test criteria:
    - Documentation accurately reflects new architecture
    - No references to ports.json remain

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                        | Description                        | File                              |
| ------------------------------------------------ | ---------------------------------- | --------------------------------- |
| `generated script reads CODEHYDRA_OPENCODE_PORT` | Verify script content uses env var | `bin-scripts.test.ts`             |
| `generated script validates port format`         | Verify numeric validation logic    | `bin-scripts.test.ts`             |
| `generated script errors when env var not set`   | Verify clear error message         | `bin-scripts.test.ts`             |
| `generated script errors when port invalid`      | Verify validation error message    | `bin-scripts.test.ts`             |
| `startServer stores port in memory`              | Verify this.servers Map updated    | `opencode-server-manager.test.ts` |
| `stopServer removes port from memory`            | Verify this.servers Map cleared    | `opencode-server-manager.test.ts` |
| `getPort returns correct port`                   | Verify port retrieval works        | `opencode-server-manager.test.ts` |

### Integration Tests

| Test Case                                     | Description                          | File                                          |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `server lifecycle without file I/O`           | Full start/stop cycle, no ports.json | `opencode-server-manager.integration.test.ts` |
| `getOpencodePort via PluginServer`            | Client receives port through API     | `plugin-server.integration.test.ts`           |
| `getOpencodePort returns null when no server` | Client receives null correctly       | `plugin-server.integration.test.ts`           |

### Boundary Tests

| Test Case                                    | Description                 | File                                       |
| -------------------------------------------- | --------------------------- | ------------------------------------------ |
| `wrapper spawns opencode with port from env` | Real spawn with env var set | `bin-scripts.boundary.test.ts`             |
| `wrapper fails gracefully without env var`   | Real execution, clear error | `bin-scripts.boundary.test.ts`             |
| `wrapper works on Unix`                      | Platform-specific execution | `bin-scripts.boundary.test.ts`             |
| `wrapper works on Windows`                   | Platform-specific execution | `bin-scripts.boundary.test.ts`             |
| `no ports.json created during server ops`    | Verify file not written     | `opencode-server-manager.boundary.test.ts` |

### Extension Testing Notes

The sidekick extension uses VS Code's `environmentVariableCollection` API which is difficult to test automatically:

- Extension code changes are verified via code review
- Actual env var injection verified via manual testing
- Consider adding extension integration tests if VS Code test framework is set up in future

### Manual Testing Checklist

- [ ] Start CodeHydra with a workspace
- [ ] Open terminal in code-server
- [ ] Run `echo $CODEHYDRA_OPENCODE_PORT` (Unix) or `echo %CODEHYDRA_OPENCODE_PORT%` (Windows) - should show port number
- [ ] Run `opencode` - should attach to server
- [ ] Close terminal, open new terminal - env var should still be set
- [ ] Stop workspace, start new one
- [ ] New terminal should have updated port (if different)
- [ ] Verify no `ports.json` file in `<app-data>/opencode/`
- [ ] Restart code-server - new terminals should have env var after extension activates

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Update CLI Wrapper Scripts section: replace ports.json diagram with env var flow, update opencode wrapper description |
| `docs/ARCHITECTURE.md` | Remove Ports File Format section if present, update OpenCode server flow diagrams                                     |

### New Documentation Required

None.

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
