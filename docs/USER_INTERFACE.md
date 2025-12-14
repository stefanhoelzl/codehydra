# CodeHydra User Interface

> **Implementation Note (Phase 4)**: The UI layer has been implemented with Svelte 5 runes and @vscode-elements. The Remove Workspace dialog uses a Cancel/OK pattern with a "Delete branch" checkbox, which differs slightly from some original specifications that showed three buttons.

## VSCode Elements Usage

The UI uses `@vscode-elements/elements` for consistent VS Code styling:

| Component              | vscode-element Used      | Location                                                 |
| ---------------------- | ------------------------ | -------------------------------------------------------- |
| Dialog buttons         | `<vscode-button>`        | CreateWorkspaceDialog, RemoveWorkspaceDialog, SetupError |
| Text input             | `<vscode-textfield>`     | CreateWorkspaceDialog (Name field)                       |
| Checkbox               | `<vscode-checkbox>`      | RemoveWorkspaceDialog (Delete branch)                    |
| Progress bar           | `<vscode-progress-bar>`  | SetupScreen                                              |
| Loading spinner        | `<vscode-progress-ring>` | Sidebar (while loading)                                  |
| Shortcut badges        | `<vscode-badge>`         | Sidebar, ShortcutOverlay                                 |
| Project dividers       | `<vscode-divider>`       | Sidebar (between projects)                               |
| Form validation helper | `<vscode-form-helper>`   | CreateWorkspaceDialog                                    |
| Open Project button    | `<vscode-button>`        | Sidebar                                                  |

**Exception**: BranchDropdown uses a custom implementation with native `<input>` for filtering and grouped options (Local/Remote branches), as `<vscode-single-select>` doesn't support these features.

## Application Layout

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CODEHYDRA - [active workspace name]                                             │
├────────────────────────┬────────────────────────────────────────────────────────┤
│                        │                                                        │
│  PROJECTS              │                                                        │
│                        │                                                        │
│  📁 my-project   [+][×]│                                                        │
│    └─ 🌿 feature       │                VS CODE (code-server)                   │
│    └─ 🌿 bugfix        │                                                        │
│                        │                  Active workspace view                 │
│  📁 other-proj   [+][×]│                                                        │
│    └─ 🌿 experiment    │                                                        │
│                        │                                                        │
│  [Open Project]        │                                                        │
│                        │                                                        │
└────────────────────────┴────────────────────────────────────────────────────────┘
```

### Layout Dimensions

- **Sidebar**: Fixed width (not resizable in v1)
- **Window minimum size**: 800x600
- **Window title**: "CODEHYDRA - [workspace name]" or "CODEHYDRA" if no workspace

## UI Elements

### Project Row (container, NOT selectable)

```
┌────────────────────────────────┐
│ 📁 project-name         [+][×] │
└────────────────────────────────┘
```

| Element    | Behavior                                                     |
| ---------- | ------------------------------------------------------------ |
| Row click  | Nothing (not selectable)                                     |
| [+] button | Opens create workspace dialog                                |
| [×] button | Closes project (removes from sidebar only, NO file deletion) |

Buttons appear on hover.

### Workspace Row (selectable)

```
┌────────────────────────────────┐
│   └─ 🌿 workspace-name    [×]  │
└────────────────────────────────┘
```

| Element          | Behavior                                       |
| ---------------- | ---------------------------------------------- |
| Row click        | Activates workspace, shows in code-server view |
| [×] button       | Opens remove workspace dialog                  |
| Status indicator | Shows OpenCode agent status (if running)       |

[×] button appears on hover.

### Scrolling Behavior

When there are more workspaces than fit:

- Single scrollable list (projects + workspaces together)
- Scroll position preserved when switching workspaces

## User Flows

### VS Code Setup (First Run Only)

On first application launch, a setup screen appears before the main interface:

**Setup Screen (in progress):**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                                                                 │
│                    Setting up VSCode...                         │
│                                                                 │
│                    Installing extensions...                     │
│                                                                 │
│              ┌─────────────────────────────────┐                │
│              │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                │
│              └─────────────────────────────────┘                │
│                   (indeterminate animation)                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Setup Complete (shown briefly):**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                         ✓ Setup complete!                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Setup Failed (with retry option):**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                      Setup Failed                               │
│                                                                 │
│     Failed to install VSCode extensions.                        │
│     Please check your internet connection.                      │
│                                                                 │
│     Error: <error message>                                      │
│                                                                 │
│              ┌────────────┐    ┌────────────┐                   │
│              │   Retry    │    │    Quit    │                   │
│              └────────────┘    └────────────┘                   │
│                (focused)                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Behavior:**

- Setup runs ONCE on first launch
- Installs OpenCode extension from marketplace
- Installs codehydra extension for workspace optimization
- Writes VS Code settings (dark theme, no telemetry)
- Shows success for 1.5 seconds before loading main app
- On failure: Retry button re-attempts, Quit exits app
- Subsequent launches skip setup (unless setup version changes)

### First Launch

On first launch (after VS Code setup completes), the application automatically opens the system folder picker to streamline the onboarding experience:

1. App loads with empty state
2. Folder picker opens automatically
3. User selects a git repository folder
4. If project has no worktrees, create workspace dialog opens automatically (see Opening a Project flow)

**If user cancels the folder picker**, they see the empty state:

```
┌────────────────────────┐
│  PROJECTS              │
│                        │
│  No projects open.     │
│                        │
│  [Open Project]        │
└────────────────────────┘
```

They can click "Open Project" to try again.

### Opening a Project

**Flow:**

1. Click "Open Project" button
2. System folder picker opens
3. Select folder
4. **If not a git repository**: Show error "Selected folder is not a git repository", return to step 2
5. Project added to sidebar (main git directory = project)
6. Worktree discovery runs (finds worktrees, NOT main directory)
7. **If 0 worktrees found**: Create workspace dialog auto-opens
8. **If 1+ worktrees found**: First workspace activated

**Note**: The main git directory is the PROJECT, not a workspace. Only worktrees are workspaces.

**Empty project (no worktrees, auto-opens create dialog):**

```
┌────────────────────────┐        ┌──────────────────────────────────┐
│  PROJECTS              │        │  Create Workspace                │
│                        │        │                                  │
│  📁 new-project  [+][×]│   +    │  Name: [________________]        │
│    (no workspaces)     │        │  Branch: [main________▼]        │
│                        │        │                                  │
│  [Open Project]        │        │         [Cancel]  [OK]           │
└────────────────────────┘        └──────────────────────────────────┘
```

### Closing a Project

**Flow:**

1. Hover project row → [×] button becomes visible
2. Click [×]
3. Project removed from sidebar immediately
4. **NO files or git data deleted** (worktrees remain on disk)
5. If active workspace was in closed project → switch to another project's workspace
6. If no projects remain → show empty state

**Hover state:**

```
┌────────────────────────────────┐
│ 📁 my-project    [+][×]        │  ← [×] visible on hover
│   └─ 🌿 feature          [×]   │
└────────────────────────────────┘
```

### Selecting a Workspace

**Flow:**

1. Click workspace row in sidebar
2. Workspace view becomes visible instantly (no reload)
3. Previous workspace hidden (VS Code state preserved)
4. Sidebar highlights new active workspace

**Visual feedback:**

```
│ 📁 my-project           [+][×] │
│   └─ 🌿 feature           [×]  │  ← Normal
│   └─ 🌿 bugfix            [×]  │  ← ACTIVE (highlighted)
```

### Creating a Workspace

**Flow:**

1. Click [+] on project row
2. Create dialog opens
3. Select target project from dropdown (defaults to current workspace's project)
4. Enter workspace name (validated in real-time against selected project's workspaces)
5. Select base branch from dropdown (the branch to create new worktree from)
6. Click OK
7. Git worktree created in managed location (NOT in main directory)
8. New workspace becomes active

**Default branch pre-selection:**

- When creating a workspace, the Base Branch dropdown is pre-populated with a default:
  - **Within a session**: The last-used base branch for that project is remembered
  - **First time / new session**: Falls back to `main` or `master` (whichever exists, preferring `main`)
  - **If neither exists**: Dropdown starts empty, user must select manually
- If the pre-selected branch no longer exists (e.g., was deleted), the dropdown clears and shows an empty selection
- The last-used branch is stored in memory only (not persisted across app restarts)

**Workspace name validation rules:**

- Must start with letter or number
- Can contain: letters, numbers, hyphens, underscores, slashes, dots
- Max length: 100 characters
- Cannot contain `..` (path traversal)
- Must be unique (not match existing branch or workspace name)

**Dialog states:**

Initial (loading branches):

```
┌──────────────────────────────────────────┐
│  Create Workspace                        │
│                                          │
│  Project                                 │
│  [my-project_______________________▼]    │  ← Defaults to active project
│                                          │
│  Name                                    │
│  [________________________________]      │
│                                          │
│  Base Branch                       [◐]   │  ← Spinner while fetching
│  [main_____________________________▼]    │
│                                          │
│                    [Cancel]  [OK]        │
│                              ~~~~        │  ← Disabled until valid
└──────────────────────────────────────────┘
```

Validation error:

```
│  Name                                    │
│  [-invalid____________________________]  │  ← Red border
│  ⚠ Must start with letter or number     │
```

Note: Name uniqueness is validated against the selected project's existing workspaces.

Valid state:

```
│  Project                                 │
│  [my-project_______________________▼]    │
│                                          │
│  Name                                    │
│  [my-feature__________________________]  │
│                                          │
│  Base Branch                             │
│  [origin/main______________________▼]    │
│                                          │
│                    [Cancel]  [OK]        │
│                              ════        │  ← Enabled
```

Creating:

```
│                    [Cancel]  [◐ Creating...]  │
│                    ~~~~~~~~  ~~~~~~~~~~~~~~~  │  ← Both disabled
```

Error:

```
│  ┌────────────────────────────────────┐  │
│  │ ⚠ Failed to create workspace.      │  │
│  │   Please try again.                │  │
│  └────────────────────────────────────┘  │
│                                          │
│                    [Cancel]  [OK]        │  ← OK re-enabled for retry
```

### Removing a Workspace

**Flow:**

1. Hover workspace row → [×] button becomes visible
2. Click [×]
3. Confirmation dialog opens
4. If uncommitted changes → warning shown
5. Choose action:
   - **Cancel**: Close dialog, no action
   - **Remove** (with "Delete branch" checked): Remove worktree AND delete git branch
   - **Remove** (with "Delete branch" unchecked): Remove worktree only, keep branch
6. On confirm: workspace removed
7. If was active → switch to another workspace in same project
8. If last workspace in project → project remains (can create new)

**Hover state:**

```
│   └─ 🌿 feature              [×]  │  ← [×] appears on hover
```

**Confirmation dialog (clean):**

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
│                                            │
│  Remove workspace "feature-auth"?          │
│                                            │
│  ☑ Delete branch                           │
│                                            │
│                    [Cancel]  [Remove]      │
└────────────────────────────────────────────┘
```

**Confirmation dialog (checking state):**

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
│                                            │
│  Remove workspace "feature-auth"?          │
│                                            │
│  Checking for uncommitted changes...       │
│                                            │
│  ☐ Delete branch                           │
│                                            │
│                    [Cancel]  [Remove]      │
│                              ~~~~~~~~      │  ← Disabled
└────────────────────────────────────────────┘
```

**Confirmation dialog (uncommitted changes warning):**

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
│                                            │
│  Remove workspace "feature-auth"?          │
│                                            │
│  ┌────────────────────────────────────┐    │
│  │ ⚠ This workspace has uncommitted   │    │
│  │   changes that will be lost.       │    │
│  └────────────────────────────────────┘    │
│                                            │
│  ☑ Delete branch                           │
│                                            │
│                    [Cancel]  [Remove]      │
└────────────────────────────────────────────┘
```

**Removing state:**

```
│                    [Cancel]  [Removing...] │
│                    ~~~~~~~~  ~~~~~~~~~~~~  │  ← Both disabled
```

### Agent Status Monitoring

**Flow:**

- User runs OpenCode in VS Code terminal (within a workspace)
- CodeHydra discovers running OpenCode instance
- Status indicator appears next to workspace in sidebar
- Status updates in real-time

**Status indicators:**
| Status | Indicator | Meaning |
|---------|----------------|--------------------------------------------|
| None | (no indicator) | No OpenCode running in this workspace |
| Idle | 🟢 | Agent waiting for user input (includes waiting for permission) |
| Busy | 🔴 | Agent actively processing |
| Mixed | 🟡 | Multiple sessions: some idle, some busy |

> **Note**: When an agent requests permission (e.g., to run a shell command), it displays as "idle" (green) because it's waiting for user action. The agent cannot proceed until the user responds to the permission request.

**Sidebar with status:**

```
│ 📁 my-project           [+][×] │
│   └─ 🌿 feature        🟢 [×]  │  ← Idle (or waiting for permission)
│   └─ 🌿 bugfix         🔴 [×]  │  ← Busy (processing)
│   └─ 🌿 hotfix            [×]  │  ← No agent running
```

## Keyboard Navigation

### How It Works

1. **Press and HOLD `Alt`**
2. **Press `X`** (can release X immediately, keep holding Alt)
3. **Shortcut mode activates**: overlay appears, workspace numbers shown
4. **Press action keys** (while still holding Alt): ↑, ↓, Enter, Delete, 1-9, 0
5. **Release `Alt`**: shortcut mode deactivates, focus returns to VS Code

**Key point**: Alt must be held continuously. X is just the activation trigger.

### Shortcuts (while Alt held after Alt+X)

| Shortcut       | Action                                                     |
| -------------- | ---------------------------------------------------------- |
| Alt+X          | Activate shortcut mode                                     |
| Alt+↑          | Previous workspace (across all projects)                   |
| Alt+↓          | Next workspace (across all projects)                       |
| Alt+Enter      | Create workspace (for project containing active workspace) |
| Alt+Delete     | Remove active workspace                                    |
| Alt+Backspace  | Remove active workspace                                    |
| Alt+1 to Alt+9 | Jump to workspace 1-9                                      |
| Alt+0          | Jump to workspace 10                                       |
| Alt+O          | Open project (folder picker)                               |

### Behavior Details

**Activation:**

- Press Alt+X: shortcut mode activates
- Overlay appears at bottom center of window
- Workspace index numbers (1-9, 0) appear in sidebar
- Actions only execute while shortcut mode is active
- X can be released after pressing; Alt must stay held

**Navigation:**

- Alt+↑/↓ moves through ALL workspaces across ALL projects
- Order: top to bottom as displayed in sidebar
- Wraps: last workspace ↓ → first workspace; first workspace ↑ → last workspace

**Alt+Enter context:**

- Opens create dialog for the project that contains the currently active workspace
- If no active workspace (empty state), Alt+Enter does nothing

**Deactivation (any of these):**

- Release Alt key
- Press Escape (while in shortcut mode)
- Window loses focus
- Dialog opens (create/remove)

**After deactivation:**

- Overlay disappears
- Index numbers disappear
- Focus returns to VS Code editor

### Shortcut Mode UI

**Normal state:**

```
│  📁 my-project           [+][×] │
│    └─ 🌿 feature-auth      [×] │
│    └─ 🌿 bugfix-123        [×] │
│  📁 other-project        [+][×] │
│    └─ 🌿 experiment        [×] │
```

**Shortcut mode active:**

```
│  📁 my-project           [+][×] │
│    └─ 1 🌿 feature-auth    [×] │  ← Index numbers appear
│    └─ 2 🌿 bugfix-123      [×] │
│  📁 other-project        [+][×] │
│    └─ 3 🌿 experiment      [×] │
│    └─ · 🌿 eleventh-ws     [×] │  ← Dot for workspaces 11+
│                                 │
│    O [Open Project]             │  ← "O" prefix appears
```

Index display rules:

- Workspaces 1-9: Show digit (1-9)
- Workspace 10: Show "0"
- Workspaces 11+: Show "·" (dimmed dot, no keyboard shortcut)

**Overlay (bottom center):**

```
┌───────────────────────────────────────────────────────┐
│  ↑↓ Navigate   ⏎ New   ⌫ Del   1-0 Jump   O Open     │
└───────────────────────────────────────────────────────┘
```

**Note**: Some hints are conditionally hidden based on application state:

- "↑↓ Navigate" and "1-0 Jump" only visible when more than 1 workspace exists
- "⏎ New" only visible when there's an active project
- "⌫ Del" only visible when there's an active workspace
- "O Open" is always visible

### Dialog Shortcuts

| Key    | Action                  |
| ------ | ----------------------- |
| Enter  | Confirm / OK            |
| Escape | Cancel / Close          |
| Tab    | Navigate between fields |

## UI States

### Empty State (no projects)

```
┌────────────────────────┐
│  PROJECTS              │
│                        │
│  No projects open.     │
│                        │
│  [Open Project]        │
└────────────────────────┘
```

### Loading State

```
│  📁 my-project           [+][×] │
│    ◐ Loading workspaces...     │
```

### Error State

```
│  📁 my-project           [+][×] │
│    ⚠ Failed to load workspaces │
│    [Retry]                      │
```
