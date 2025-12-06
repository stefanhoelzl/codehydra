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

### UI Layer State Machine

The UI layer uses **bounds-based visibility**, not transparency:

| State   | UI Bounds                               | UI Z-Order                  | Focus    | Description                   |
| ------- | --------------------------------------- | --------------------------- | -------- | ----------------------------- |
| Normal  | Sidebar only (x:0, width:SIDEBAR_WIDTH) | Behind workspace views      | VS Code  | User working in editor        |
| Overlay | Full window                             | In front of workspace views | UI layer | Keyboard shortcut mode active |

**State transitions:**

- Normal → Overlay: User activates shortcut mode (Alt+X)
- Overlay → Normal: User releases Alt, presses Escape, or window loses focus

**Implementation:**

- Background: `setBackgroundColor('#00000000')` for transparency
- Bounds: Change dynamically based on state
- Z-order: Remove/re-add child view to change order

## Keyboard Architecture

### Dual Capture Strategy

Both mechanisms required:

| Mechanism        | Level    | Purpose                                                      |
| ---------------- | -------- | ------------------------------------------------------------ |
| `globalShortcut` | OS-level | Capture Alt+X even when VS Code has focus                    |
| Preload capture  | In-view  | Intercept shortcuts in capture phase before VS Code handlers |

### Alt Key Handling

- **Alt+X**: Activates shortcut mode (registered via globalShortcut)
- **Alt must be held**: All shortcuts require Alt to be held continuously
- **X can be released**: After pressing Alt+X, X can be released while Alt stays down
- **Alt release**: Deactivates shortcut mode, returns focus to VS Code
- **Alt keyup suppression**: Must suppress in capture phase to prevent VS Code menu bar activation

### Preload Scripts

| Script             | Used By         | Purpose                                             |
| ------------------ | --------------- | --------------------------------------------------- |
| preload.ts         | UI layer        | Expose IPC API for sidebar, dialogs, stores         |
| webview-preload.ts | Workspace views | Keyboard capture, Alt suppression, URL interception |

## Component Architecture

### Main Process Components

| Component       | Responsibility                                              |
| --------------- | ----------------------------------------------------------- |
| Window Manager  | BaseWindow lifecycle, resize handling, minimum size         |
| View Manager    | WebContentsView create/destroy, bounds calculation, z-order |
| IPC Handlers    | Bridge between renderer and services                        |
| Preload Scripts | Secure IPC exposure, keyboard capture                       |

### App Services (pure Node.js, no Electron deps)

Services are pure Node.js for testability without Electron:

| Service                  | Responsibility                                    |
| ------------------------ | ------------------------------------------------- |
| Git Worktree Provider    | Discover worktrees (not main dir), create, remove |
| Code-Server Manager      | Start/stop code-server, port management           |
| Project Store            | Persist open projects across sessions             |
| OpenCode Discovery       | Find running OpenCode instances                   |
| OpenCode Status Provider | SSE connections, status aggregation               |

```
Electron Main Process
      ↓ imports
App Services (pure Node.js)
      ↓ no Electron deps

Services are unit-testable without Electron runtime.
```

### Frontend Components (Svelte 5)

| Component             | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| Sidebar               | Project list, workspace list, status indicators            |
| CreateWorkspaceDialog | New workspace form with validation                         |
| RemoveWorkspaceDialog | Confirmation with uncommitted changes warning              |
| KeyboardOverlay       | Shortcut hints when active                                 |
| Stores                | projects, activeWorkspace, agentStatus, keyboardNavigation |

## OpenCode Integration

### Discovery

- Scan for OpenCode status server instances (port scanning)
- Match instances to workspaces via process tree / port mapping
- Runs periodically in background

### Status Updates

- SSE connection to each discovered instance
- Real-time status: idle, working, error
- Broadcast changes to frontend via IPC events

## External URL Handling

All URLs opened from code-server → external system browser:

- Implemented via `setWindowOpenHandler` returning `{ action: 'deny' }`
- Platform-specific: `xdg-open` (Linux), `open` (macOS), `start` (Windows)

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

### Commands (renderer → main)

[Placeholder - to be defined in Phase 3]

### Events (main → renderer)

[Placeholder - to be defined in Phase 3]
