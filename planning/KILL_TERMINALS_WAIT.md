---
status: COMPLETED
last_updated: 2025-12-28
reviewers:
  - review-typescript
  - review-arch
  - review-testing
  - review-docs
---

# KILL_TERMINALS_WAIT

## Overview

- **Problem**: The current terminal killing implementation is fire-and-forget. It sends `workbench.action.terminal.killAll` command but doesn't wait for terminals to actually close. This can lead to race conditions where the extension host exits before terminals have fully terminated.
- **Solution**: Modify the extension's `shutdown` handler to explicitly get all terminals, dispose them, and wait for `onDidCloseTerminal` events before continuing with shutdown.
- **Risks**:
  - Terminal doesn't close within timeout → Mitigated by 5-second timeout, proceed anyway
  - No terminals exist → Handle gracefully, proceed immediately
- **Alternatives Considered**:
  - Keep separate `sendShutdownCommand` and `shutdown` events → Rejected: More complex, still fire-and-forget for terminal killing
  - Use `workbench.action.terminal.killAll` with polling → Rejected: No reliable way to detect completion

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Current Flow (fire-and-forget)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  killTerminalsCallback()                                            │
│         │                                                           │
│         ├──► sendShutdownCommand() ──► "command" event             │
│         │         │                        │                        │
│         │         │              Extension executes killAll         │
│         │         │              (fire-and-forget, may not complete)│
│         │         ▼                                                 │
│         │    Returns immediately                                    │
│         │                                                           │
│         └──► sendExtensionHostShutdown() ──► "shutdown" event      │
│                        │                          │                 │
│                        │               Extension removes folders    │
│                        │               Sends ack, exits             │
│                        ▼                                            │
│                   Waits for socket disconnect                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     New Flow (wait for completion)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  killTerminalsCallback()                                            │
│         │                                                           │
│         └──► sendExtensionHostShutdown() ──► "shutdown" event      │
│                        │                          │                 │
│                        │               Extension:                   │
│                        │               1. Get all terminals         │
│                        │               2. Set up onDidCloseTerminal │
│                        │               3. Dispose each terminal     │
│                        │               4. Wait for all closed OR    │
│                        │                  5-second timeout          │
│                        │               5. Remove workspace folders  │
│                        │               6. Send ack, exit            │
│                        ▼                                            │
│                   Waits for socket disconnect                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## UI Design

No UI changes. The deletion progress view already shows "Terminating processes" step.

## Implementation Steps

- [x] **Step 1: Bump extension version and modify extension.js shutdown handler**
  - Bump version in `package.json` from `0.0.2` to `0.0.3`
  - Add constant at file top: `const TERMINAL_KILL_TIMEOUT_MS = 5000;`
  - Extract terminal killing to a separate async function `killAllTerminalsAndWait()`:

    ```javascript
    /**
     * Kill all terminals and wait for them to close.
     * Returns after all terminals are closed OR after timeout.
     * @returns {Promise<void>}
     */
    async function killAllTerminalsAndWait() {
      const terminals = [...vscode.window.terminals];

      if (terminals.length === 0) {
        log("No terminals to kill");
        return;
      }

      log("Killing " + terminals.length + " terminal(s)");
      const pendingTerminals = new Set(terminals);

      await new Promise((resolve) => {
        let resolved = false;

        const done = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          disposable.dispose(); // Clean up listener
          resolve();
        };

        // Set up timeout - proceed anyway after 5 seconds
        const timeout = setTimeout(() => {
          log("Terminal kill timeout - " + pendingTerminals.size + " remaining, proceeding anyway");
          done();
        }, TERMINAL_KILL_TIMEOUT_MS);

        // IMPORTANT: Set up listener BEFORE disposing terminals to avoid race condition
        const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
          pendingTerminals.delete(closedTerminal);
          log("Terminal closed, " + pendingTerminals.size + " remaining");
          if (pendingTerminals.size === 0) {
            log("All terminals closed");
            done();
          }
        });

        // Dispose all terminals AFTER listener is set up
        for (const terminal of terminals) {
          terminal.dispose();
        }

        // Check in case all terminals closed synchronously (unlikely but safe)
        if (pendingTerminals.size === 0) {
          log("All terminals closed (sync)");
          done();
        }
      });
    }
    ```

  - Update the `shutdown` event handler to call this function:

    ```javascript
    socket.on("shutdown", async (ack) => {
      log("Shutdown command received, workspace: " + currentWorkspacePath);

      // Step 1: Kill all terminals and wait
      await killAllTerminalsAndWait();

      // Step 2: Graceful cleanup - remove workspace folders
      // ... existing code ...
    });
    ```

  - Files:
    - `src/services/vscode-setup/assets/codehydra-sidekick/package.json` (version bump)
    - `src/services/vscode-setup/assets/codehydra-sidekick/extension.js` (shutdown handler)
  - Test: Manual testing (extension runs in VS Code, not vitest)

- [x] **Step 2: Remove sendShutdownCommand call from killTerminalsCallback**
  - In `startServices()`, simplify the `killTerminalsCallback` to only call `sendExtensionHostShutdown`:
    ```typescript
    killTerminalsCallback: async (workspacePath: string) => {
      // Shutdown extension host (kills terminals, releases file watchers, terminates process)
      await pluginServer!.sendExtensionHostShutdown(workspacePath);
    },
    ```
  - Terminal killing is now handled inside the shutdown event handler
  - File: `src/main/index.ts`
  - Test: Existing integration tests + new integration test (Step 5)

- [x] **Step 3: Check test usage and remove shutdown-commands.ts exports**
  - First, check if any tests import `sendShutdownCommand` or `SHUTDOWN_COMMAND`
  - If tests use these, update them to use PluginServer directly or remove the tests
  - Remove the exports from `src/services/plugin-server/index.ts`
  - Keep `shutdown-commands.ts` file but mark as internal/deprecated with JSDoc
  - Files:
    - `src/services/plugin-server/shutdown-commands.ts`
    - `src/services/plugin-server/index.ts`
    - Any test files that import the deprecated functions
  - Test: No new tests needed

- [x] **Step 4: Rebuild extension**
  - Run `npm run build:extension` to rebuild the sidekick extension
  - Verify the dist/extension.js contains the new shutdown logic
  - File: `src/services/vscode-setup/assets/codehydra-sidekick/dist/extension.js`
  - Test: Build succeeds

- [x] **Step 5: Add integration tests for killTerminalsCallback**
  - Add tests in `src/main/modules/core/index.integration.test.ts` (or similar) that verify:
    - Workspace deletion invokes `killTerminalsCallback` when PluginServer is available
    - The callback calls `pluginServer.sendExtensionHostShutdown(workspacePath)`
    - Deletion proceeds even if callback throws (per existing error handling)
  - Use behavioral mock for PluginServer that tracks `sendExtensionHostShutdown` calls
  - **Important**: Mocks must return immediately (no 5s wait) to keep tests fast (<50ms)
  - File: `src/main/modules/core/index.integration.test.ts`
  - Test: New tests pass

- [x] **Step 6: Update documentation**
  - Update documentation files per Documentation Updates section below
  - Files:
    - `AGENTS.md`
    - `docs/ARCHITECTURE.md`
    - `docs/PATTERNS.md`

## Testing Strategy

### Integration Tests

| #   | Test Case                              | Entry Point           | Boundary Mocks              | Behavior Verified                                      |
| --- | -------------------------------------- | --------------------- | --------------------------- | ------------------------------------------------------ |
| 1   | Deletion invokes killTerminalsCallback | `CoreModule.remove()` | PluginServer (track calls)  | `sendExtensionHostShutdown` called with workspace path |
| 2   | Deletion proceeds if callback throws   | `CoreModule.remove()` | PluginServer (throws error) | Deletion completes, error logged                       |
| 3   | Deletion proceeds if no PluginServer   | `CoreModule.remove()` | None (no PluginServer)      | Deletion completes without callback                    |

**Behavioral Mock Requirements**:

- PluginServer mock must return immediately from `sendExtensionHostShutdown()` (no artificial delays)
- The 5-second timeout is for production runtime protection only, not simulated in tests
- Terminal closure logic is tested manually (runs in VS Code, not vitest)

### Boundary Tests

Existing boundary tests for `sendExtensionHostShutdown` in `plugin-server.boundary.test.ts` remain valid.

### Manual Testing Checklist

These scenarios MUST be tested manually because they require a real VS Code environment:

- [ ] Delete workspace with 1 active terminal - verify terminal closes before extension exits
- [ ] Delete workspace with 3+ terminals - verify all close (check logs for "Terminal closed, N remaining")
- [ ] Delete workspace with no terminals - verify immediate proceed (check logs: "No terminals to kill")
- [ ] Delete workspace with hung terminal - verify 5-second timeout triggers, deletion completes
- [ ] Verify logs show terminal count and completion/timeout status
- [ ] Test on Linux (primary platform)

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Update Plugin Interface shutdown event description (Server → Client Events table) to note that the shutdown event now handles terminal disposal internally: gets all terminals, disposes each, waits for `onDidCloseTerminal` or 5s timeout, then removes workspace folders |
| `docs/ARCHITECTURE.md` | Update "Workspace Deletion Sequence" section to reflect that terminal killing happens inside the shutdown event handler, not as a separate `sendShutdownCommand` call                                                                                                       |
| `docs/PATTERNS.md`     | Update "Extension Host Shutdown" section (if exists) to describe terminal disposal happening inside the shutdown handler                                                                                                                                                    |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
