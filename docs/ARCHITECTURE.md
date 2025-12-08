# CodeHydra Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CodeHydra Application                             │
├──────────────────────────────────────────────────────────────────────────┤
│  Main Process (Electron)                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────────────┐│
│  │Window Manager │  │ View Manager  │  │ App Services                  ││
│  │ BaseWindow    │  │WebContentsView│  │ ├─ Git Worktree Provider      ││
│  │ resize/bounds │  │ create/destroy│  │ ├─ Code-Server Manager        ││
│  │               │  │ bounds/z-order│  │ ├─ Project Store              ││
│  └───────────────┘  └───────────────┘  │ └─ OpenCode Discovery         ││
│                                        └───────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────┤
│  UI Layer (WebContentsView with transparent background)                  │
│  Bounds change based on state: sidebar-only OR full-window              │
├──────────────────────────────────────────────────────────────────────────┤
│  Workspace Views (code-server WebContentsViews)                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                        │
│  │ Workspace 1 │ │ Workspace 2 │ │ Workspace 3 │                        │
│  │ (visible)   │ │ (hidden)    │ │ (hidden)    │                        │
│  └─────────────┘ └─────────────┘ └─────────────┘                        │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Project vs Workspace

| Concept   | What it is                        | Viewable          | Actions              |
| --------- | --------------------------------- | ----------------- | -------------------- |
| Project   | Git repository (main directory)   | No                | Close, Add workspace |
| Workspace | Git worktree (NOT main directory) | Yes (code-server) | Select, Remove       |

**Key behavior:**

- Main git directory is the PROJECT (container, not a workspace)
- Only git worktrees are WORKSPACES (viewable in code-server)
- Fresh clone with no worktrees = 0 workspaces → create dialog auto-opens

### Worktree Discovery Logic

| Location                   | Type                                | Discovered as Workspace?    |
| -------------------------- | ----------------------------------- | --------------------------- |
| Main git directory         | Original clone                      | ❌ NO - this is the PROJECT |
| Manually created worktrees | User-created via `git worktree add` | ✅ YES                      |
| App-managed worktrees      | App-created in managed location     | ✅ YES                      |

Example - user opens `~/projects/myrepo`:

```
~/projects/myrepo/                              → PROJECT (not a workspace)
~/projects/myrepo-feature/                      → WORKSPACE (manual worktree)
~/.local/share/codehydra/.../workspaces/feat/   → WORKSPACE (app worktree)
```

### Worktree Storage (Platform-Specific)

New worktrees are created only in the managed location:

| Platform    | Path                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| Linux       | `~/.local/share/codehydra/projects/<name>-<hash>/workspaces/`                |
| macOS       | `~/Library/Application Support/codehydra/projects/<name>-<hash>/workspaces/` |
| Windows     | `%APPDATA%\codehydra\projects\<name>-<hash>\workspaces\`                     |
| Development | `./app-data/projects/<name>-<hash>/workspaces/`                              |

Discovery finds worktrees in ANY location; creation only in managed location.

## WebContentsView Architecture

### View Management

- **Create**: When workspace added, create WebContentsView
- **Destroy**: When workspace removed, destroy WebContentsView
- **Show**: Set bounds to visible area, reorder for z-index
- **Hide**: Set bounds to zero (width: 0, height: 0) - preserves VS Code state
- **Z-order**: Controlled by `contentView.removeChildView(view)` then `contentView.addChildView(view)` (last added = front)

### View Lifecycle

```
[not created] ──createWorkspaceView()──► [created/hidden]
                                              │
                                              │ bounds: (0, 0, 0, 0)
                                              │
                                      setActiveWorkspace()
                                              │
                                              ▼
                                        [active/visible]
                                              │
                                              │ bounds: (SIDEBAR_WIDTH, 0, w, h)
                                              │
                                      setActiveWorkspace(other)
                                              │
                                              ▼
                                           [hidden]
                                              │
                                      destroyWorkspaceView()
                                              │
                                              ▼
                                         [destroyed]
```

- **Hidden views** retain their VS Code state (no reload when shown again)
- **Bounds-based hiding** (0x0) is more efficient than destroying/recreating views

### UI Layer State Machine

The application uses a **hybrid visibility approach**:

- **UI layer**: Always has full-window bounds. Visibility controlled by z-order.
- **Workspace views**: Visibility controlled by bounds (active = content area, inactive = 0x0).

| State   | UI Z-Order                  | Focus    | Description                  |
| ------- | --------------------------- | -------- | ---------------------------- |
| Normal  | Behind workspace views      | VS Code  | User working in editor       |
| Overlay | In front of workspace views | UI layer | Shortcut mode or dialog open |

**State transitions:**

- Normal → Overlay: User activates shortcut mode (Alt+X) or opens dialog
- Overlay → Normal: User releases Alt, presses Escape, closes dialog, or window loses focus

**Implementation:**

- UI transparency: `setBackgroundColor('#00000000')`
- Z-order front: `contentView.addChildView(view)` (no index = add to end = top)
- Z-order back: `contentView.addChildView(view, 0)` (index 0 = bottom)

## Component Architecture

### Main Process Components

| Component       | Responsibility                                              |
| --------------- | ----------------------------------------------------------- |
| Window Manager  | BaseWindow lifecycle, resize handling, minimum size         |
| View Manager    | WebContentsView create/destroy, bounds calculation, z-order |
| IPC Handlers    | Bridge between renderer and services                        |
| Preload Scripts | Secure IPC exposure, keyboard capture                       |

### Preload Scripts

| Script           | Used By  | Purpose                                            |
| ---------------- | -------- | -------------------------------------------------- |
| preload/index.ts | UI layer | Expose IPC API for sidebar, dialogs, shortcut mode |

**Note**: Workspace views intentionally have NO preload script. Keyboard capture is handled via main-process `before-input-event` for simplicity and security.

### App Services (pure Node.js, no Electron deps)

Services are pure Node.js for testability without Electron:

| Service                  | Responsibility                                    | Status      |
| ------------------------ | ------------------------------------------------- | ----------- |
| Git Worktree Provider    | Discover worktrees (not main dir), create, remove | Implemented |
| Code-Server Manager      | Start/stop code-server, port management           | Implemented |
| Project Store            | Persist open projects across sessions             | Implemented |
| OpenCode Discovery       | Find running OpenCode instances                   | Implemented |
| OpenCode Status Provider | SSE connections, status aggregation               | Implemented |

```
Electron Main Process
      ↓ imports
App Services (pure Node.js)
      ↓ no Electron deps

Services are unit-testable without Electron runtime.
```

### Frontend Components (Svelte 5)

| Component             | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| App                   | Main application component, IPC event handling       |
| Sidebar               | Project list, workspace list, action buttons         |
| EmptyState            | Displayed when no projects are open                  |
| Dialog                | Base dialog component with focus trap, accessibility |
| CreateWorkspaceDialog | New workspace form with validation, branch selection |
| RemoveWorkspaceDialog | Confirmation with uncommitted changes warning        |
| BranchDropdown        | Searchable combobox for branch selection             |
| ShortcutOverlay       | Keyboard shortcut hints (shown during shortcut mode) |
| Stores                | projects, dialogs, shortcuts (Svelte 5 runes)        |

### Dialog Overlay Mode

When a modal dialog or shortcut mode is active, the UI layer's z-order is changed to overlay workspace views:

```
NORMAL STATE (no dialog, no shortcut mode):
┌─────────────────────────────────────────────────────────────────────┐
│ children[0]: UI Layer        │ children[N]: Workspace Views        │
│ z-order: BEHIND              │ z-order: ON TOP                     │
│                              │                                     │
│ Sidebar receives events      │ Workspace receives events           │
└──────────────────────────────┴─────────────────────────────────────┘

DIALOG/SHORTCUT STATE:
┌─────────────────────────────────────────────────────────────────────┐
│ children[0..N-1]: Workspace Views (z-order: BEHIND)                 │
├─────────────────────────────────────────────────────────────────────┤
│ children[N]: UI Layer (z-order: ON TOP)                             │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │                  Dialog or Shortcut Overlay                     │ │
│ │              (receives all keyboard/mouse events)               │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

This is triggered by:

- **Dialogs**: A reactive `$effect` in App.svelte watches `dialogState` and calls `api.setDialogMode(isOpen)`
- **Shortcut mode**: `ShortcutController` calls `setDialogMode(true)` when Alt+X detected

The main process ViewManager handles the z-order swap using `contentView.addChildView()` reordering.

## OpenCode Integration

The OpenCode integration provides real-time agent status monitoring for AI agents running in each workspace.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  DiscoveryService ──► PortScanner + ProcessTree + InstanceProbe │
│         │                                                        │
│         │ discovers ports for workspaces                         │
│         ▼                                                        │
│  AgentStatusManager ◄── OpenCodeClient (SSE events)             │
│         │                                                        │
│         │ callback on status change                              │
│         ▼                                                        │
│  IPC Handlers ──► agent:status-changed event                    │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
═══════════════════════════╪══════════════════════════════════════
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    RENDERER PROCESS                              │
│                          │                                       │
│  api.onAgentStatusChanged() ──► agentStatusStore                │
│                                       │                          │
│                                       │ reactive binding         │
│                                       ▼                          │
│  Sidebar.svelte ◄── AgentStatusIndicator (visual indicator)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Services (src/services/opencode/)

| Service              | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `DiscoveryService`   | Discovers OpenCode instances via port scanning            |
| `OpenCodeClient`     | Connects to OpenCode HTTP/SSE API, handles reconnection   |
| `AgentStatusManager` | Aggregates status across workspaces, emits status changes |

Supporting modules:

| Module          | Responsibility                                          |
| --------------- | ------------------------------------------------------- |
| `PortScanner`   | Scans for listening ports with PID info (node-netstat)  |
| `ProcessTree`   | Gets descendant PIDs of code-server process (pidtree)   |
| `InstanceProbe` | Probes ports to identify OpenCode instances (localhost) |

### Discovery Flow

1. **PID Change Event**: `CodeServerManager.onPidChanged()` notifies `DiscoveryService`
2. **Port Scan**: Main process polls `DiscoveryService.scan()` every 1s
3. **Process Filtering**: Only scans ports owned by code-server descendants
4. **Instance Probe**: HTTP request to `/path` endpoint identifies OpenCode instances
5. **Caching**: Non-OpenCode ports cached (5 min TTL) to avoid re-probing

### Status Update Flow

1. **SSE Connection**: `OpenCodeClient` connects to `/event` endpoint
2. **Event Parsing**: Receives `session.status`, `session.deleted`, `session.idle` events
3. **Aggregation**: `AgentStatusManager` counts idle/busy sessions per workspace
4. **Callback**: Status change triggers callback (NOT direct IPC)
5. **IPC Emit**: Handler subscribes to callback, emits `agent:status-changed`
6. **Store Update**: Renderer receives event, updates `agentStatusStore`
7. **UI Update**: `AgentStatusIndicator` component reflects new state

### IPC Channels

| Channel                  | Type    | Payload                             | Description                       |
| ------------------------ | ------- | ----------------------------------- | --------------------------------- |
| `agent:status-changed`   | Event   | `{ workspacePath, status, counts }` | Status update for workspace       |
| `agent:get-status`       | Command | `{ workspacePath: string }`         | Get status for specific workspace |
| `agent:get-all-statuses` | Command | `void`                              | Get all workspace statuses        |
| `agent:refresh`          | Command | `void`                              | Trigger immediate scan            |

### Error Handling

- **Connection Failures**: Exponential backoff reconnection (1s, 2s, 4s... max 30s)
- **Port Reuse**: PID comparison detects when different process reuses a port
- **Concurrent Scans**: Mutex flag prevents overlapping scan operations
- **Resource Cleanup**: `IDisposable` pattern ensures proper cleanup on shutdown

## External URL Handling

All URLs opened from code-server → external system browser:

- Implemented via `setWindowOpenHandler` returning `{ action: 'deny' }`
- Platform-specific: `xdg-open` (Linux), `open` (macOS), `start` (Windows)

## Keyboard Capture System

CodeHydra uses a two-phase keyboard capture system to enable shortcuts inside VS Code views.

### Phase 1: Activation Detection (Main Process)

The `ShortcutController` uses Electron's `before-input-event` API to intercept keyboard events
before they reach VS Code. It detects the Alt+X activation sequence:

- Alt keydown → Enter ALT_WAITING state, prevent event
- X keydown (while ALT_WAITING) → Activate shortcut mode, focus UI layer
- Non-X keydown (while ALT_WAITING) → Let through to VS Code with altKey modifier
- Alt keyup → Always suppressed (VS Code never sees Alt-only events)

### Phase 2: Action Handling (UI Layer)

Once activated, the UI layer has focus and handles keys directly via DOM events:

- Action keys (0-9, arrows, Enter, Delete) → Execute workspace actions
- Alt keyup → Exit shortcut mode, return focus to VS Code
- Window blur → Exit shortcut mode (handles Alt+Tab)

### Key Files

| File                                          | Purpose                            |
| --------------------------------------------- | ---------------------------------- |
| `src/main/shortcut-controller.ts`             | Activation detection state machine |
| `src/renderer/lib/stores/shortcuts.svelte.ts` | UI layer state and handlers        |

### ShortcutController State Machine

```
                              ┌──────────┐
              ┌───────────────│  NORMAL  │◄────────────────────────────────┐
              │               └────┬─────┘                                 │
              │                    │                                       │
              │ Alt up             │ Alt down                              │
              │ (suppress)         │ (preventDefault)                      │
              │                    ▼                                       │
              │            ┌─────────────┐                                 │
              │            │ ALT_WAITING │                                 │
              │            └──────┬──────┘                                 │
              │                   │                                        │
              │     ┌─────────────┼─────────────┐                          │
              │     │             │             │                          │
              │  Alt up      non-X key       X down                        │
              │  (suppress)  (let through)      │                          │
              │     │             │             ▼                          │
              │     │             │      • preventDefault                  │
              │     │             │      • setDialogMode(true)             │
              │     │             │      • focusUI()                       │
              │     │             │      • Emit ENABLE to UI               │
              │     │             │             │                          │
              └─────┴─────────────┴─────────────┘                          │
                                                                           │
              Main process returns to NORMAL immediately ──────────────────┘
```

**Note**: Alt keyup is ALWAYS suppressed (in both states) so VS Code never sees Alt-only key events.

### Race Condition Handling

There is a race condition where the user can release Alt faster than focus switches to the UI layer:

1. User presses Alt+X → ShortcutController activates mode, calls `focusUI()`
2. User releases Alt VERY QUICKLY (before focus actually switches)
3. Workspace view still has focus, catches the Alt keyup via `before-input-event`
4. **Problem**: UI layer never sees Alt keyup, thinks shortcut mode is still active

**Solution**: Main process tracks `shortcutModeActive` flag. On Alt keyup, if the flag was true:

- Reset flag to false
- Send `shortcut:disable` event to UI
- UI receives event and resets its state

This ensures the UI never gets stuck in shortcut mode.

## Data Flow

### Opening a Project

```
User: Click "Open Project"
  → System folder picker
  → Validate: is git repository?
      → If NO: show error "Not a git repository", return to picker
      → If YES: continue
  → Git Worktree Provider: discover worktrees (NOT main directory)
  → Project Store: save project
  → If 0 worktrees: auto-open create dialog
  → If 1+ worktrees: activate first workspace
```

### Switching Workspaces

```
User: Click workspace (or keyboard shortcut)
  → IPC: switch-workspace
  → View Manager: hide current (set bounds to zero)
  → View Manager: show target (set bounds to visible area)
  → View Manager: bring to front (remove/re-add child view)
  → Store: update activeWorkspace
  → Focus: code-server view
```

### Creating a Workspace

```
User: Click [+], fill dialog, click OK
  → Validate name (frontend)
      → If invalid: show error, stay in dialog
      → If valid: continue
  → IPC: create-workspace
  → Git Worktree Provider: create in managed location
      → If git error: return error, show in dialog
      → If success: continue
  → Code-Server Manager: get URL
  → View Manager: create WebContentsView
  → Store: add workspace, set active
```

### Closing a Project

```
User: Click [×] on project row
  → Store: remove project from list
  → View Manager: destroy all workspace views for project
  → If active workspace was in project:
      → Switch to first workspace of another project
      → If no other projects: show empty state
  → Project Store: update persisted list
  (NO files or git data deleted)
```

## IPC Contract

All IPC channels are defined in `src/shared/ipc.ts` with TypeScript types for compile-time safety.

### Commands (renderer → main)

| Channel                     | Payload                             | Response            | Description                       |
| --------------------------- | ----------------------------------- | ------------------- | --------------------------------- |
| `project:open`              | `{ path: string }`                  | `Project`           | Open project, discover workspaces |
| `project:close`             | `{ path: string }`                  | `void`              | Close project, destroy views      |
| `project:list`              | `void`                              | `Project[]`         | List all open projects            |
| `project:select-folder`     | `void`                              | `string \| null`    | Show folder picker dialog         |
| `workspace:create`          | `{ projectPath, name, baseBranch }` | `Workspace`         | Create workspace, create view     |
| `workspace:remove`          | `{ workspacePath, deleteBranch }`   | `RemovalResult`     | Remove workspace, destroy view    |
| `workspace:switch`          | `{ workspacePath }`                 | `void`              | Switch active workspace           |
| `workspace:list-bases`      | `{ projectPath }`                   | `BaseInfo[]`        | List available branches           |
| `workspace:update-bases`    | `{ projectPath }`                   | `UpdateBasesResult` | Fetch from remotes                |
| `workspace:is-dirty`        | `{ workspacePath }`                 | `boolean`           | Check for uncommitted changes     |
| `ui:set-dialog-mode`        | `{ isOpen: boolean }`               | `void`              | Swap UI layer z-order             |
| `ui:focus-active-workspace` | `void`                              | `void`              | Return focus to VS Code           |

### Events (main → renderer)

| Channel              | Payload                                          | Description                               |
| -------------------- | ------------------------------------------------ | ----------------------------------------- |
| `project:opened`     | `{ project: Project }`                           | Project was opened                        |
| `project:closed`     | `{ path: string }`                               | Project was closed                        |
| `workspace:created`  | `{ projectPath: string, workspace: Workspace }`  | Workspace was created                     |
| `workspace:removed`  | `{ projectPath: string, workspacePath: string }` | Workspace was removed                     |
| `workspace:switched` | `{ workspacePath: string }`                      | Active workspace changed                  |
| `shortcut:enable`    | `void`                                           | Shortcut mode activated                   |
| `shortcut:disable`   | `void`                                           | Shortcut mode deactivated (race recovery) |

**Note**: `shortcut:enable` and `shortcut:disable` are defined as channel constants but are not typed in the `IpcEvents` interface (they use simple void payloads).

### IPC Data Flow

```
┌─────────────┐  IPC invoke   ┌─────────────┐  direct call  ┌─────────────┐
│  Renderer   │ ────────────► │    Main     │ ────────────► │  Services   │
│  (Svelte)   │               │  (handlers) │               │  (Node.js)  │
│             │ ◄──────────── │             │ ◄──────────── │             │
└─────────────┘  IPC response/ └─────────────┘  return value/ └─────────────┘
                    events                      throw error
```
