---
status: COMPLETED
last_updated: 2024-12-23
reviewers: [review-arch, review-docs]
---

# API_DOCUMENTATION

## Overview

- **Problem**: CodeHydra's API lacks comprehensive documentation. External systems have no reference for implementing the public API.
- **Solution**: Create `docs/API.md` documenting both private (internal) and public (external) APIs, and update the docs review agent to keep it current.
- **Risks**: None - documentation-only change
- **Alternatives Considered**: None - straightforward documentation task

## Architecture

No architecture changes - documentation only.

## Implementation Steps

- [x] **Step 1: Create docs/API.md**
  - Create comprehensive API documentation with two levels:
    - **Private API**: Used by CodeHydra's renderer UI only (full API via `window.api`)
    - **Public API**: Workspace-scoped API for external consumers with two access methods:
      - VS Code Extension Access (via `ext.exports.codehydra`)
      - WebSocket Access (direct Socket.IO connection)
  - **Source files to reference** (implementation agent MUST read these for accuracy):
    - `src/shared/api/interfaces.ts` - Core API interface definitions (ICodeHydraApi, IProjectApi, IWorkspaceApi, etc.)
    - `src/shared/api/types.ts` - Type definitions (ProjectId, WorkspaceName, Project, Workspace, WorkspaceStatus, etc.)
    - `src/shared/ipc.ts` - IPC channel names (ApiIpcChannels)
    - `src/shared/plugin-protocol.ts` - WebSocket protocol types (ClientToServerEvents, PluginResult, SetMetadataRequest)
    - `src/services/vscode-setup/assets/codehydra-extension/api.d.ts` - External API type declarations for third parties
  - Include:
    - Quick links and overview table (Private vs Public)
    - **Public API section first** (primary audience is external consumers):
      - API reference table (methods, signatures, descriptions)
      - Usage examples as **runnable code snippets with error handling** demonstrating the `PluginResult` pattern:
        - Check workspace status (dirty flag)
        - Get agent status (all cases: none, idle, busy, mixed)
        - Get OpenCode port and connect
        - Store/read/delete metadata
      - Metadata key format rules (from `METADATA_KEY_REGEX` in types.ts)
      - Error handling (rejected Promises with string error)
      - Timeout info (10 seconds)
      - **VS Code Extension Access subsection**:
        - How to get the API (`vscode.extensions.getExtension`)
        - Complete working example with `whenReady()` and error handling
        - Type declarations (inline or reference to api.d.ts)
      - **WebSocket Access subsection**:
        - ASCII architecture diagram (match style in `docs/ARCHITECTURE.md` Plugin Interface section)
        - Connection flow (port from env, Socket.IO connect, auth with workspacePath)
        - Event channels table (api:workspace:getStatus, getOpencodePort, getMetadata, setMetadata)
        - Response format (PluginResult<T>)
        - Complete example client implementation
        - Server-to-client commands (command event)
    - **Private API section** (for internal reference):
      - Note: "Not intended for external consumers"
      - All namespaces from `src/shared/api/interfaces.ts`: projects, workspaces, ui, lifecycle
      - Events table (from ApiEvents in interfaces.ts)
    - **Type definitions section**:
      - Include all types exported from `src/shared/api/types.ts` that are part of the API contract
      - Core types: ProjectId, WorkspaceName, Project, Workspace, WorkspaceRef, WorkspaceStatus, AgentStatus, AgentStatusCounts, BaseInfo, UIMode, AppState, SetupProgress, SetupResult
    - API comparison table (Private vs Public - scope, identifiers, events, cross-workspace, etc.)
    - Cross-reference: "For architectural details, see [docs/ARCHITECTURE.md](ARCHITECTURE.md)"
    - Source files reference table
  - Files affected: `docs/API.md` (new file)
  - Test criteria: File exists with complete documentation matching this specification

- [x] **Step 2: Update docs review agent context table**
  - Add `docs/API.md` to the Context table in `.opencode/agent/review-docs.md`
  - Add this exact row to the table:
    ```
    | `docs/API.md`            | Private/Public API reference                 | API methods, events, types, or access patterns change   |
    ```
  - Files affected: `.opencode/agent/review-docs.md`
  - Test criteria: Table includes API.md entry

- [x] **Step 3: Add API doc sync verification to review agent**
  - In `.opencode/agent/review-docs.md`, add to the "Review checklist" section (after the existing checkboxes):
    ```
    - [ ] Does the plan change any API methods, events, types, or access patterns documented in `docs/API.md`?
    ```
  - In the "Examples of changes requiring doc updates" section, add these lines:
    ```
    - New public API method → `docs/API.md` Public API section
    - New IPC channel/event → `docs/API.md` Private API Events table
    - New shared type → `docs/API.md` Type Definitions section
    - New external system accessing API → `docs/API.md` WebSocket Access section
    ```
  - Files affected: `.opencode/agent/review-docs.md`
  - Test criteria: Checklist includes API.md checkbox, examples section includes API examples

- [x] **Step 4: Add API.md to AGENTS.md Key Documents table**
  - In `AGENTS.md`, add `docs/API.md` to the "Key Documents" table (around line 109-118)
  - Add this exact row:
    ```
    | API Reference    | docs/API.md                    | Private/Public API for internal and external use       |
    ```
  - Files affected: `AGENTS.md`
  - Test criteria: Key Documents table includes API.md entry

## Testing Strategy

### Manual Testing Checklist

- [ ] docs/API.md exists and is readable
- [ ] Public API section is first and comprehensive
- [ ] All API methods listed in source code (`src/shared/api/interfaces.ts`) are documented
- [ ] VS Code Extension access is documented with complete working example
- [ ] WebSocket access is documented with ASCII diagram and example client
- [ ] Usage examples are runnable code with error handling
- [ ] Private API section covers all namespaces (projects, workspaces, ui, lifecycle)
- [ ] Type definitions match `src/shared/api/types.ts`
- [ ] Cross-reference to ARCHITECTURE.md is present
- [ ] review-docs.md includes API.md in context table
- [ ] review-docs.md has API.md checkbox in verification checklist
- [ ] review-docs.md has API-related examples in examples section
- [ ] AGENTS.md Key Documents table includes API.md

## Dependencies

None - documentation only.

## Documentation Updates

This plan IS the documentation update.

### Files to Update

| File                             | Changes Required                                                   |
| -------------------------------- | ------------------------------------------------------------------ |
| `docs/API.md`                    | Create new file (Step 1)                                           |
| `.opencode/agent/review-docs.md` | Add API.md to context table and verification checklist (Steps 2-3) |
| `AGENTS.md`                      | Add API.md to Key Documents table (Step 4)                         |

### New Documentation Required

| File          | Purpose                                                 |
| ------------- | ------------------------------------------------------- |
| `docs/API.md` | Comprehensive API reference for private and public APIs |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] Changes committed
