---
status: COMPLETED
last_updated: 2025-12-23
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# EXTENSION_DEBUG_COMMANDS

## Overview

- **Problem**: No way to manually test the extension API from within VS Code. Developers need to verify API behavior during development but the extension host runs in a separate process, making console-based testing impossible.
- **Solution**: Add debug commands to the codehydra extension that can be invoked via Command Palette. Commands are dynamically registered only in development mode (info sent via WebSocket on connect). Also rename extension from `codehydra.codehydra` to `codehydra.sidekick`.
- **Risks**:
  - Additional WebSocket event increases protocol complexity slightly
- **Alternatives Considered**:
  - Environment variable (`CODEHYDRA_DEV`): Rejected because it requires passing env to code-server and lacks dynamic control
  - Global exposure (`globalThis.codehydra`): Rejected because extension host runs in separate process from Developer Tools console
  - Declaring commands in package.json: Rejected because commands would appear in Command Palette in production but show "command not found" error

## Approvals

- **IPC Protocol Change**: Adding `config` event to `ServerToClientEvents` in `src/shared/plugin-protocol.ts` - **APPROVED** by user

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Main Process                                                                 │
│                                                                              │
│  ┌──────────────┐         ┌─────────────────────────────────────────────┐   │
│  │ BuildInfo    │────────▶│ PluginServer                                │   │
│  │ .isDevelopment│        │  - constructor(portManager, logger, config) │   │
│  └──────────────┘         │  - config.isDevelopment                     │   │
│                           │                                             │   │
│                           │  On socket connect (after validation,       │   │
│                           │  before startup commands):                  │   │
│                           │    socket.emit("config", {                  │   │
│                           │      isDevelopment: true/false              │   │
│                           │    })                                       │   │
│                           └─────────────────┬───────────────────────────┘   │
└─────────────────────────────────────────────┼───────────────────────────────┘
                                              │
                                              │ Socket.IO
                                              │ "config" event
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ code-server (Extension Host)                                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ codehydra-sidekick extension                                        │    │
│  │                                                                     │    │
│  │  // Handler registered synchronously in connectToPluginServer()    │    │
│  │  socket.on("config", (config) => {                                  │    │
│  │    // Runtime validation                                            │    │
│  │    if (typeof config !== 'object' || config === null) return;       │    │
│  │    if (typeof config.isDevelopment !== 'boolean') return;           │    │
│  │    if (config.isDevelopment) {                                      │    │
│  │      registerDebugCommands(context);                                │    │
│  │    }                                                                │    │
│  │  });                                                                │    │
│  │                                                                     │    │
│  │  Debug Commands (dev only, dynamically registered):                 │    │
│  │  ┌─────────────────────────────────────────────────────────────┐   │    │
│  │  │ codehydra.debug.getStatus      → getStatus() → Output       │   │    │
│  │  │ codehydra.debug.getMetadata    → getMetadata() → Output     │   │    │
│  │  │ codehydra.debug.getOpencodePort→ getOpencodePort() → Output │   │    │
│  │  │ codehydra.debug.connectionInfo → show connection state      │   │    │
│  │  └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                     │    │
│  │  Output Channel: "CodeHydra Debug" (created lazily on first use)   │    │
│  │  ┌─────────────────────────────────────────────────────────────┐   │    │
│  │  │ === getStatus [2025-12-23T10:30:00.000Z] ===                │   │    │
│  │  │ {                                                           │   │    │
│  │  │   "isDirty": false,                                         │   │    │
│  │  │   "agent": { "type": "none" }                               │   │    │
│  │  │ }                                                           │   │    │
│  │  └─────────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Steps

- [x] **Step 1: Add PluginConfig type and config event to plugin-protocol.ts**
  - Add `PluginConfig` interface with `isDevelopment: boolean`
  - Add `config` event to `ServerToClientEvents`
  - Files affected: `src/shared/plugin-protocol.ts`
  - Test criteria: Type compiles, no breaking changes to existing events

- [x] **Step 2: Update PluginServer to accept isDevelopment and emit config**
  - Add `isDevelopment` to `PluginServerOptions` interface
  - Store `isDevelopment` in class instance (with `!!` coercion for safety)
  - Emit `config` event immediately after connection validation completes, before any startup commands
  - Location: Add to `setupEventHandlers()` after `this.connections.set()` call, before invoking connect callbacks
  - Files affected: `src/services/plugin-server/plugin-server.ts`
  - Test criteria: Config event emitted on connect with correct payload

- [x] **Step 3: Pass buildInfo.isDevelopment to PluginServer**
  - Update PluginServer instantiation in main process
  - Pass `isDevelopment` from BuildInfo
  - Files affected: `src/main/index.ts`
  - Test criteria: PluginServer receives correct isDevelopment value

- [x] **Step 4: Rename extension folder and update package.json**
  - Rename folder from `codehydra-extension` to `codehydra-sidekick`
  - Update package.json: set `name` to `"sidekick"` (NOT the full ID), keep `publisher` as `"codehydra"`
  - The VS Code extension ID is constructed as `<publisher>.<name>`, resulting in `codehydra.sidekick`
  - **Do NOT add command contributions to package.json** - commands are registered dynamically
  - Files affected:
    - `src/services/vscode-setup/assets/codehydra-extension/` → `codehydra-sidekick/`
    - `src/services/vscode-setup/assets/codehydra-sidekick/package.json`
  - Test criteria: Extension builds with new name

- [x] **Step 5: Update extension.js with config handler and debug commands**
  - **State variables** (add at module level, after imports, before `activate()`):

    ```javascript
    /** @type {boolean} */
    let isDevelopment = false;

    /** @type {vscode.OutputChannel | null} */
    let debugOutputChannel = null;

    /** @type {string} */
    let currentWorkspacePath = "";

    /** @type {number | null} */
    let currentPluginPort = null;

    /** @type {vscode.ExtensionContext | null} */
    let extensionContext = null;
    ```

  - **Modify `activate()`**: Store context in `extensionContext` before calling `connectToPluginServer()`
  - **Modify `connectToPluginServer()`**: Register `socket.on("config", ...)` handler synchronously (before `socket.on("connect", ...)`). Handler must:
    1. Validate payload: `if (typeof config !== 'object' || config === null) return;`
    2. Validate field: `if (typeof config.isDevelopment !== 'boolean') return;`
    3. Store value: `isDevelopment = config.isDevelopment;`
    4. Register commands if dev: `if (isDevelopment && extensionContext) { registerDebugCommands(extensionContext); }`
  - **Add `registerDebugCommands(context)` function**: Register all 4 commands using `vscode.commands.registerCommand()`, add to `context.subscriptions`
  - **Add `getDebugOutputChannel()` helper**: Lazy creation pattern
    ```javascript
    function getDebugOutputChannel() {
      if (!debugOutputChannel) {
        debugOutputChannel = vscode.window.createOutputChannel("CodeHydra Debug");
      }
      return debugOutputChannel;
    }
    ```
  - **Add `formatResult(result)` helper**: Safe JSON stringify with error handling
    ```javascript
    function formatResult(result) {
      try {
        return JSON.stringify(result, null, 2);
      } catch (e) {
        return `[Serialization error: ${e.message}]`;
      }
    }
    ```
  - **Add `logDebugResult(name, data)` and `logDebugError(name, err)` helpers**
  - **Add `runDebugCommand(name, fn)` helper**: Wraps API call with error handling
  - **Modify `deactivate()`**: Add output channel disposal
    ```javascript
    if (debugOutputChannel) {
      debugOutputChannel.dispose();
      debugOutputChannel = null;
    }
    ```
  - Files affected: `src/services/vscode-setup/assets/codehydra-sidekick/extension.js`
  - Test criteria: Commands register in dev mode only, output to channel works, errors handled gracefully

- [x] **Step 6: Update api.d.ts with new extension ID**
  - Update example code showing `getExtension('codehydra.sidekick')`
  - Files affected: `src/services/vscode-setup/assets/codehydra-sidekick/api.d.ts`
  - Test criteria: Examples show correct extension ID

- [x] **Step 7: Update documentation with new extension ID**
  - **AGENTS.md** updates:
    - Update Plugin API section: change `getExtension('codehydra.codehydra')` to `getExtension('codehydra.sidekick')`
    - Update VS Code Assets section: change folder references from `codehydra-extension` to `codehydra-sidekick`
    - Update file path reference for `api.d.ts`
  - **docs/ARCHITECTURE.md** updates:
    - Update Plugin Interface section with new extension ID
  - **docs/PATTERNS.md** updates:
    - Update Plugin Interface section examples to reference `codehydra.sidekick`
  - Files affected: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PATTERNS.md`
  - Test criteria: All documentation references are accurate

- [x] **Step 8: Update build scripts and references**
  - Update `package.json` build:extension script path
  - Update `electron.vite.config.ts` static-copy plugin config for extension folder
  - Verify `*.vsix` glob still matches output filename
  - Files affected: `package.json`, `electron.vite.config.ts`
  - Test criteria: `npm run build:extension` succeeds, produces correct vsix

- [x] **Step 9: Update PluginServer tests**
  - **Unit tests** (`plugin-server.test.ts`):
    - Test isDevelopment option accepted in constructor
    - Test config not emitted when isDevelopment not set (defaults to false)
  - **Boundary tests** (`plugin-server.boundary.test.ts`):
    - Test config event received by client with `isDevelopment: true`
    - Test config event received by client with `isDevelopment: false`
    - Test config event on reconnection doesn't cause issues
    - Test malformed config doesn't crash server
  - **Test utils** (`plugin-server.test-utils.ts`):
    - Add `isDevelopment` option to mock factory
  - **Integration test** (`plugin-server.integration.test.ts` or new file):
    - Test BuildInfo.isDevelopment flows through PluginServer to client
  - Files affected:
    - `src/services/plugin-server/plugin-server.test.ts`
    - `src/services/plugin-server/plugin-server.boundary.test.ts`
    - `src/services/plugin-server/plugin-server.test-utils.ts`
  - Test criteria: All tests pass, new behavior covered

- [x] **Step 10: Run validate:fix**
  - Run `npm run validate:fix` to ensure all tests pass
  - Fix any lint/type errors
  - Test criteria: All checks pass

## Testing Strategy

### Unit Tests (vitest)

| Test Case                                    | Description                                             | File                  |
| -------------------------------------------- | ------------------------------------------------------- | --------------------- |
| PluginServer isDevelopment option            | Verify option is accepted and stored                    | plugin-server.test.ts |
| PluginServer config emission                 | Verify config event emitted with correct payload        | plugin-server.test.ts |
| PluginServer isDevelopment defaults to false | Verify config.isDevelopment is false when not specified | plugin-server.test.ts |

### Boundary Tests (vitest)

| Test Case                    | Description                                           | File                           |
| ---------------------------- | ----------------------------------------------------- | ------------------------------ |
| Config event round-trip      | Client receives config event after connect            | plugin-server.boundary.test.ts |
| Config isDevelopment true    | Verify isDevelopment: true sent when configured       | plugin-server.boundary.test.ts |
| Config isDevelopment false   | Verify isDevelopment: false sent when configured      | plugin-server.boundary.test.ts |
| Config event on reconnection | Verify reconnection sends config again without issues | plugin-server.boundary.test.ts |
| Malformed config handling    | Verify server handles malformed config gracefully     | plugin-server.boundary.test.ts |

### Integration Tests (vitest)

| Test Case                | Description                                                         | File                              |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| BuildInfo to client flow | Verify buildInfo.isDevelopment flows through to client config event | plugin-server.integration.test.ts |

### Manual Testing Checklist

**Note**: Extension.js runs in VS Code's extension host and cannot be unit tested with vitest. The following manual tests cover extension-side behavior.

#### Development Mode Tests

- [ ] Start app in dev mode (`npm run dev`)
- [ ] Open workspace in code-server
- [ ] Open Command Palette (Ctrl+Shift+P)
- [ ] Type "CodeHydra Debug:" - should see 4 commands
- [ ] Run "Debug: Get Workspace Status" - should show result in Output channel
- [ ] Run "Debug: Get Workspace Metadata" - should show result in Output channel
- [ ] Run "Debug: Get OpenCode Port" - should show port or null in Output channel
- [ ] Run "Debug: Show Connection Info" - should show connection state with `isDevelopment: true`
- [ ] Verify Output channel "CodeHydra Debug" shows JSON formatted results with timestamps
- [ ] Verify output channel auto-shows with focus preserved

#### Error Handling Tests

- [ ] Disconnect socket (e.g., stop main process) and run debug command - should show appropriate error
- [ ] Run debug command before socket connects - should show "Not connected" error
- [ ] Verify errors are logged to output channel with timestamp

#### Production Mode Tests

- [ ] Build production app
- [ ] Open workspace in code-server
- [ ] Type "CodeHydra Debug:" in Command Palette - should see NO debug commands
- [ ] Verify extension still works normally (startup commands, API exports)

#### Build Tests

- [ ] Run `npm run build:extension` - should produce `codehydra-sidekick-0.0.1.vsix`
- [ ] Verify vsix contains correct extension ID in package.json

## Dependencies

| Package | Purpose                      | Approved |
| ------- | ---------------------------- | -------- |
| (none)  | No new dependencies required | N/A      |

## Documentation Updates

### Files to Update

| File                                                           | Changes Required                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                    | Update Plugin API section with new extension ID `codehydra.sidekick`, update VS Code Assets section folder references |
| `docs/ARCHITECTURE.md`                                         | Update Plugin Interface section with new extension ID                                                                 |
| `docs/PATTERNS.md`                                             | Update Plugin Interface section examples                                                                              |
| `src/services/vscode-setup/assets/codehydra-sidekick/api.d.ts` | Update example code with new extension ID                                                                             |

### New Documentation Required

| File   | Purpose                                                 |
| ------ | ------------------------------------------------------- |
| (none) | Debug commands are self-documenting via Command Palette |

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [x] User acceptance testing passed
- [x] Changes committed

## Debug Commands Reference

| Command ID                        | Palette Title                           | Output                                                              |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `codehydra.debug.getStatus`       | CodeHydra Debug: Get Workspace Status   | `{ isDirty: boolean, agent: AgentStatus }`                          |
| `codehydra.debug.getMetadata`     | CodeHydra Debug: Get Workspace Metadata | `{ base: string, [key]: string }`                                   |
| `codehydra.debug.getOpencodePort` | CodeHydra Debug: Get OpenCode Port      | `number \| null`                                                    |
| `codehydra.debug.connectionInfo`  | CodeHydra Debug: Show Connection Info   | `{ connected, workspacePath, pluginPort, socketId, isDevelopment }` |

**Note**: Commands ARE declared in `package.json` with `enablement: "codehydra.isDevelopment"` condition. The extension sets this VS Code context when it receives `isDevelopment: true` in the config event. This ensures commands appear in Command Palette but are disabled (grayed out) for production users until the context is set.

## Output Channel Format

```
=== getStatus [2025-12-23T10:30:00.000Z] ===
{
  "isDirty": false,
  "agent": {
    "type": "none"
  }
}

=== connectionInfo [2025-12-23T10:30:05.000Z] ===
{
  "connected": true,
  "workspacePath": "/home/user/projects/my-app/.worktrees/feature-x",
  "pluginPort": 45678,
  "socketId": "abc123",
  "isDevelopment": true
}

=== getStatus [2025-12-23T10:30:10.000Z] ERROR ===
Not connected to CodeHydra
```
