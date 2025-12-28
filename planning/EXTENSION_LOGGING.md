---
status: COMPLETED
last_updated: 2025-12-28
reviewers: [review-typescript, review-arch, review-testing, review-docs]
---

# EXTENSION_LOGGING

## Overview

- **Problem**: VS Code extensions and AI agents running in CodeHydra workspaces cannot send structured logs to CodeHydra's logging system. This makes debugging and monitoring difficult.
- **Solution**: Add a `log` namespace to the CodeHydra API that extensions and MCP agents can use to send structured logs to the main process logging service.
- **Risks**:
  - Log spam from extensions could overwhelm log files → Mitigated by using fire-and-forget pattern (no backpressure) and relying on existing log level filtering
  - Invalid log context data → Mitigated by validation at the boundary (primitives only)
- **Alternatives Considered**:
  - Extension-side file logging: Rejected because logs would be scattered across workspace directories instead of centralized
  - VS Code Output Channel only: Rejected because logs wouldn't be captured in CodeHydra's log files for debugging

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MAIN PROCESS                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  LoggingService (ElectronLogService)                                    │ │
│  │    └─ createLogger("extension") → Logger with [extension] scope         │ │
│  │    └─ createLogger("mcp") → Logger with [mcp] scope (already exists)    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                    ▲                              ▲                          │
│                    │                              │                          │
│  ┌─────────────────┴───────────┐  ┌──────────────┴─────────────────────┐   │
│  │  PluginServer               │  │  McpServer                          │   │
│  │    └─ on("api:log")         │  │    └─ registerTool("log")           │   │
│  │    └─ Fire-and-forget       │  │    └─ Returns successResult(null)   │   │
│  │    └─ Appends workspace ctx │  │                                     │   │
│  └─────────────────────────────┘  └────────────────────────────────────┘   │
│            ▲                                      ▲                          │
│            │ Socket.IO                            │ HTTP POST /mcp           │
└────────────┼──────────────────────────────────────┼─────────────────────────┘
             │                                      │
┌────────────┼──────────────────────────────────────┼─────────────────────────┐
│            │                                      │                          │
│  ┌─────────┴───────────────┐         ┌───────────┴────────────────────┐     │
│  │  codehydra-sidekick     │         │  OpenCode AI Agent             │     │
│  │  (VS Code Extension)    │         │  (via MCP)                     │     │
│  │                         │         │                                 │     │
│  │  api.log.info(msg, ctx) │         │  tool: log                     │     │
│  │  api.log.debug(msg)     │         │  params: level, message, ctx    │     │
│  │  api.log.warn(...)      │         │                                 │     │
│  │  api.log.error(...)     │         │                                 │     │
│  │  api.log.silly(...)     │         │                                 │     │
│  │                         │         │                                 │     │
│  │  (graceful degradation: │         │                                 │     │
│  │   no-op if disconnected)│         │                                 │     │
│  └─────────────────────────┘         └─────────────────────────────────┘     │
│                                                                              │
│                              WORKSPACE                                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Design Notes

**Event naming**: The `api:log` event intentionally breaks the `api:workspace:*` pattern because:

- Log events are connection-scoped, not workspace-scoped
- The workspace context is automatically appended by PluginServer
- Fire-and-forget events don't need the same structure as request/response events

**Logger scopes**:

- `[extension]` - New scope for logs from VS Code extensions
- `[mcp]` - Already exists in `LoggerName` type, used for MCP tool logs

## Implementation Steps

- [x] **Step 1: Add log event types to plugin protocol**
  - Add `LogRequest` interface with `level`, `message`, and optional `context`
  - Add `validateLogRequest()` function with return type `{ valid: true } | { valid: false; error: string }`
  - Import and use `LogLevel` constant from `src/services/logging/types.ts` for level validation
  - Validate context values are primitives only (`string | number | boolean | null`) - reject nested objects, arrays, functions, symbols
  - Add `api:log` fire-and-forget event to `ClientToServerEvents` with signature `(request: LogRequest) => void` (no ack callback)
  - Files affected: `src/shared/plugin-protocol.ts`
  - Test file: `src/shared/plugin-protocol.test.ts` (add focused tests for validateLogRequest)
  - Test criteria: Validation function correctly validates/rejects payloads including edge cases

- [x] **Step 2: Add "extension" logger name to LoggerName type**
  - Add `"extension"` to the `LoggerName` union type with comment `// PluginServer - extension-side logs`
  - Note: `"mcp"` already exists in the type
  - Files affected: `src/services/logging/types.ts`
  - Test criteria: TypeScript compiles without errors

- [x] **Step 3: Handle log events in PluginServer**
  - Add `extensionLogger: Logger` parameter to PluginServer constructor (optional, defaults to SILENT_LOGGER)
  - In `startServices()` (main/index.ts): create logger with `loggingService.createLogger("extension")` and pass to PluginServer
  - Register handler for `api:log` event in `setupApiHandlers()` method
  - Handler validates request with `validateLogRequest()`, silently ignores invalid requests
  - Handler auto-appends `{ workspace: workspacePath }` to context for traceability
  - Handler calls appropriate logger method based on level (no ack callback - fire-and-forget)
  - Files affected: `src/services/plugin-server/plugin-server.ts`, `src/main/index.ts`
  - Test file: `src/services/plugin-server/plugin-server.integration.test.ts`
  - Test criteria: Log events are received and delegated to behavioral Logger mock; tests verify logged output not mock calls

- [x] **Step 4: Add log namespace to extension API**
  - Add `log` namespace to `codehydraApi` object with `silly`, `debug`, `info`, `warn`, `error` methods
  - Each method checks `if (!socket?.connected) return;` for graceful degradation
  - Each method emits `api:log` event with level, message, and optional context
  - Fire-and-forget: use `socket.emit("api:log", request)` without callback
  - Files affected: `extensions/codehydra-sidekick/extension.js`
  - Test criteria: API methods are callable and emit correct events; gracefully handle disconnected state

- [x] **Step 5: Add type declarations for log API**
  - Add `LogContext` type: `Record<string, string | number | boolean | null>` (duplicated for extension compatibility - cannot import from src/shared/)
  - Add `LogApi` interface with methods: `silly(message, context?)`, `debug(message, context?)`, `info(message, context?)`, `warn(message, context?)`, `error(message, context?)`
  - Add `log: LogApi` property to `CodehydraApi` interface
  - Files affected: `extensions/codehydra-sidekick/api.d.ts`
  - Test criteria: TypeScript types are complete and accurate

- [x] **Step 6: Migrate extension internal logging to new API**
  - Remove the `log()` and `logError()` helper functions that use console.log/console.error
  - Remove all pre-connection log calls (these provided no value since logs weren't centralized):
    - `activate()`: Remove logs for port validation, workspace path, missing env var
    - `connectToPluginServer()`: Remove "Connecting to PluginServer" log
  - Replace post-connection logs with `codehydraApi.log.*` calls:
    - `socket.on("connect")`: `codehydraApi.log.info("Connected to PluginServer")`
    - `socket.on("config")`: `codehydraApi.log.debug("Config received", { isDevelopment })`
    - `socket.on("disconnect")`: `codehydraApi.log.info("Disconnected", { reason })`
    - `socket.on("connect_error")`: `codehydraApi.log.error("Connection error", { error: err.message })`
    - `socket.on("command")`: `codehydraApi.log.debug("Command received/executed", { command })`
    - `socket.on("shutdown")`: `codehydraApi.log.info("Shutdown received")`
    - `getOpencodePort` success: `codehydraApi.log.debug("Set CODEHYDRA_OPENCODE_PORT", { port })`
    - `getOpencodePort` error: `codehydraApi.log.warn("Failed to get opencode port", { error })`
    - `registerDebugCommands()`: `codehydraApi.log.debug("Debug commands registered")`
    - `deactivate()`: `codehydraApi.log.info("Deactivating")` (if still connected)
  - Add logging for events not currently logged:
    - API call timeout in `emitApiCall()`: `codehydraApi.log.warn("API call timeout", { event })`
  - Files affected: `extensions/codehydra-sidekick/extension.js`
  - Test criteria: No console.log/console.error calls remain; all logs use new API

- [x] **Step 7: Add log tool to MCP server**
  - Add `log` tool with `level`, `message`, and optional `context` parameters
  - Use Zod enum for level validation: `z.enum(["silly", "debug", "info", "warn", "error"])`
  - Use existing `this.logger` (already has `"mcp"` scope) to log the message
  - Tool returns `this.successResult(null)` immediately (fire-and-forget semantics with valid MCP response)
  - Files affected: `src/services/mcp-server/mcp-server.ts`
  - Test file: `src/services/mcp-server/mcp-server.integration.test.ts`
  - Test criteria: MCP tool logs to behavioral Logger mock; tests verify logged output

- [x] **Step 8: Update documentation**
  - **AGENTS.md**: Add "Extension Logging" section under "Plugin API (for Third-Party Extensions)" with usage examples
  - **docs/API.md**: Add `log` namespace to Public API Reference with methods and LogContext type constraints
  - **docs/ARCHITECTURE.md**:
    - Add `[extension]` to Logger Names table: `| [extension] | PluginServer | Extension-side logs forwarded to main |`
    - Add `api:log` to Plugin Protocol section: `| api:log | LogRequest | (none - fire-and-forget) | Send structured log to main process |`
  - Files affected: `AGENTS.md`, `docs/API.md`, `docs/ARCHITECTURE.md`
  - Test criteria: Documentation is accurate, complete, and includes usage examples

## Testing Strategy

### Behavioral Logger Mock

All integration tests use a behavioral Logger mock with in-memory message storage:

```typescript
interface LoggedMessage {
  level: LogLevel;
  message: string;
  context?: LogContext;
}

function createBehavioralLoggerMock(): Logger & {
  getMessages(): LoggedMessage[];
  getMessagesByLevel(level: LogLevel): LoggedMessage[];
  clear(): void;
} {
  const messages: LoggedMessage[] = [];
  return {
    silly: (msg, ctx) => messages.push({ level: "silly", message: msg, context: ctx }),
    debug: (msg, ctx) => messages.push({ level: "debug", message: msg, context: ctx }),
    info: (msg, ctx) => messages.push({ level: "info", message: msg, context: ctx }),
    warn: (msg, ctx) => messages.push({ level: "warn", message: msg, context: ctx }),
    error: (msg, ctx) => messages.push({ level: "error", message: msg, context: ctx }),
    getMessages: () => [...messages],
    getMessagesByLevel: (level) => messages.filter((m) => m.level === level),
    clear: () => (messages.length = 0),
  };
}
```

### Integration Tests

Test behavior through the PluginServer and McpServer entry points.

| #   | Test Case                                                  | Entry Point                  | Boundary Mocks         | Behavior Verified                                                            |
| --- | ---------------------------------------------------------- | ---------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| 1   | Log event with valid payload is logged                     | `PluginServer` + socket emit | Behavioral Logger mock | `logger.getMessages()` contains message with correct level, message, context |
| 2   | Log event for each level (silly, debug, info, warn, error) | `PluginServer` + socket emit | Behavioral Logger mock | `logger.getMessagesByLevel(level)` contains expected message                 |
| 3   | Log event with invalid level is silently ignored           | `PluginServer` + socket emit | Behavioral Logger mock | `logger.getMessages()` is empty, no error thrown                             |
| 4   | Log event with invalid context is silently ignored         | `PluginServer` + socket emit | Behavioral Logger mock | `logger.getMessages()` is empty, no error thrown                             |
| 5   | Log event auto-appends workspace context                   | `PluginServer` + socket emit | Behavioral Logger mock | `logger.getMessages()[0].context.workspace` equals normalized workspace path |
| 6   | MCP log tool with valid params logs message                | `McpServer` + HTTP POST      | Behavioral Logger mock | `logger.getMessages()` contains message                                      |
| 7   | MCP log tool for each level logs correctly                 | `McpServer` + HTTP POST      | Behavioral Logger mock | `logger.getMessagesByLevel(level)` contains expected message                 |
| 8   | MCP log tool with invalid level returns error result       | `McpServer` + HTTP POST      | Behavioral Logger mock | Response has `isError: true`, logger not called                              |

### Focused Tests (validation functions)

| #   | Test Case                             | Function             | Input/Output                                                                                                 |
| --- | ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Valid log request                     | `validateLogRequest` | `{ level: 'info', message: 'test' }` → `{ valid: true }`                                                     |
| 2   | Log request with context              | `validateLogRequest` | `{ level: 'debug', message: 'test', context: { key: 'value' } }` → `{ valid: true }`                         |
| 3   | Log request with multi-key context    | `validateLogRequest` | `{ level: 'info', message: 'test', context: { k1: 'v1', k2: 123, k3: true, k4: null } }` → `{ valid: true }` |
| 4   | Log request with empty context        | `validateLogRequest` | `{ level: 'info', message: 'test', context: {} }` → `{ valid: true }`                                        |
| 5   | Invalid level                         | `validateLogRequest` | `{ level: 'invalid', message: 'test' }` → `{ valid: false, error: '...' }`                                   |
| 6   | Missing message                       | `validateLogRequest` | `{ level: 'info' }` → `{ valid: false, error: '...' }`                                                       |
| 7   | Empty message string                  | `validateLogRequest` | `{ level: 'info', message: '' }` → `{ valid: false, error: '...' }`                                          |
| 8   | Invalid context type (string)         | `validateLogRequest` | `{ level: 'info', message: 'test', context: 'not-object' }` → `{ valid: false, error: '...' }`               |
| 9   | Invalid context value (function)      | `validateLogRequest` | `{ level: 'info', message: 'test', context: { fn: () => {} } }` → `{ valid: false, error: '...' }`           |
| 10  | Invalid context value (nested object) | `validateLogRequest` | `{ level: 'info', message: 'test', context: { nested: { deep: 1 } } }` → `{ valid: false, error: '...' }`    |
| 11  | Invalid context value (array)         | `validateLogRequest` | `{ level: 'info', message: 'test', context: { arr: [1, 2] } }` → `{ valid: false, error: '...' }`            |
| 12  | Context with null value (valid)       | `validateLogRequest` | `{ level: 'info', message: 'test', context: { key: null } }` → `{ valid: true }`                             |
| 13  | All valid log levels                  | `validateLogRequest` | Test each of 'silly', 'debug', 'info', 'warn', 'error' → all `{ valid: true }`                               |

### Manual Testing Checklist

- [ ] Extension can log at all levels (silly, debug, info, warn, error)
- [ ] Logs appear in CodeHydra log files with `[extension]` scope
- [ ] Logs include workspace path in context
- [ ] Invalid log calls are silently ignored (no extension crashes)
- [ ] Extension gracefully handles disconnected state (no errors)
- [ ] MCP log tool works from AI agent
- [ ] Logs appear in CodeHydra log files with `[mcp]` scope
- [ ] Verify logs appear in correct log file (`<app-data>/logs/*.log`)
- [ ] Verify log format includes timestamp, level, logger name, message, and context
- [ ] Extension lifecycle events appear in logs (connected, config, disconnect, shutdown)
- [ ] No console.log/console.error calls in extension (check VS Code Developer Tools)

## Dependencies

No new dependencies required. Uses existing:

- `socket.io` (for extension communication)
- `zod` (for MCP tool schema validation)
- `electron-log` (for logging implementation)

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`            | Add "Extension Logging" section under "Plugin API (for Third-Party Extensions)" with usage example showing `api.log.info(message, context)` |
| `docs/API.md`          | Add `log` namespace to Public API Reference with all 5 methods and LogContext type constraints                                              |
| `docs/ARCHITECTURE.md` | Add `[extension]` to Logger Names table; add `api:log` to Plugin Protocol Messages section                                                  |

### New Documentation Required

None - documentation is added to existing files.

## Definition of Done

- [x] All implementation steps complete
- [x] `npm run validate:fix` passes
- [x] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
