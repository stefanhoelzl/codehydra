# CodeHydra User Interface

> **Implementation Note (Phase 4)**: The UI layer has been implemented with Svelte 5 runes and @vscode-elements. The Remove Workspace dialog uses a Cancel/OK pattern with a "Delete branch" checkbox, which differs slightly from some original specifications that showed three buttons.

## VSCode Elements Usage

The UI uses `@vscode-elements/elements` for consistent VS Code styling:

| Component              | vscode-element Used      | Location                                                                                         |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Dialog buttons         | `<vscode-button>`        | CreateWorkspaceDialog, RemoveWorkspaceDialog, OpenProjectErrorDialog, SetupError, GitCloneDialog |
| Text input             | `<vscode-textfield>`     | CreateWorkspaceDialog (Name field), GitCloneDialog (URL field)                                   |
| Checkbox               | `<vscode-checkbox>`      | RemoveWorkspaceDialog (Delete branch), CloseProjectDialog (Remove workspaces, Delete repo)       |
| Progress bar           | `<vscode-progress-bar>`  | SetupScreen                                                                                      |
| Loading spinner        | `<vscode-progress-ring>` | Sidebar (while loading), GitCloneDialog (cloning status)                                         |
| Shortcut badges        | `<vscode-badge>`         | Sidebar, ShortcutOverlay                                                                         |
| Project dividers       | `<vscode-divider>`       | Sidebar (between projects)                                                                       |
| Form validation helper | `<vscode-form-helper>`   | CreateWorkspaceDialog                                                                            |
| Open project button    | `<vscode-button>`        | CreateWorkspaceDialog (folder icon, git clone icon)                                              |

**Exception**: BranchDropdown uses a custom implementation with native `<input>` for filtering and grouped options (Local/Remote branches), as `<vscode-single-select>` doesn't support these features.

## Application Layout

The sidebar minimizes by default to 20px, showing status indicators only. Hover or enter shortcut mode to expand. See "Sidebar Expansion Behavior" below for details.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CODEHYDRA - [active workspace name]                                             │
├──┬──────────────────────────────────────────────────────────────────────────────┤
│▸ │                                                                              │
│██│                                                                              │
│░░│                        VS CODE (code-server)                                 │
│  │                                                                              │
│▸ │                        Active workspace view                                 │
└──┴──────────────────────────────────────────────────────────────────────────────┘
 ↑
20px minimized sidebar (hover to expand to 250px)
```

### Layout Dimensions

- **Sidebar**: 250px wide when expanded, 20px when minimized (hover to expand)
- **VS Code area**: Starts at x=20px, expanded sidebar overlays it
- **Window minimum size**: 800x600
- **Window title**: "CodeHydra - Project / Workspace - (version)" or "CodeHydra - (version)" if no workspace
- **Update available**: Title includes " - (X.Y.Z update available)" suffix when an update is downloaded and ready

### Sidebar Expansion Behavior

The sidebar minimizes by default to show only 20px of status indicators, maximizing VS Code editing space. It expands on hover to reveal full workspace names and actions.

**Minimized state (default):**

```
┌──┬────────────────────────────────────────────────────────────────┐
│▸ │                                                                │
├──┼                                                                │
│██│                                                                │
│░░│                     VS CODE (code-server)                      │
│  │                                                                │
├──┼                     Active workspace view                      │
│  │                                                                │
│▸ │                                                                │
└──┴────────────────────────────────────────────────────────────────┘
 ↑
20px visible (status indicators + chevron hints)
```

**Expanded state (on hover or forced):**

```
┌────────────────────────┬──────────────────────────────────────────┐
│  PROJECTS              │                                          │
│                        │                                          │
│  📁 my-project   [+][×]│         VS CODE (code-server)            │
│    └─ 🌿 feature   ░░  │                                          │
│    └─ 🌿 bugfix    ██  │         Active workspace view            │
│                        │         (sidebar overlays VS Code)       │
│                        │                                          │
│                        │                                          │
└────────────────────────┴──────────────────────────────────────────┘
         ↑                          ↑
   250px sidebar              VS Code starts at x=20px
    (overlays)
```

**Expansion triggers:**

| Condition                      | Sidebar State |
| ------------------------------ | ------------- |
| Mouse hovering over sidebar    | Expanded      |
| Mouse left sidebar (150ms ago) | Minimized     |
| Shortcut mode active (Alt+X)   | Expanded      |
| Dialog open                    | Expanded      |
| No workspaces exist            | Expanded      |

**Status indicators in minimized state:**

- ██ (red, pulsing): Agent busy
- ░░ (green): Agent idle
- (empty): No agent running
- ▸: Expand hint chevron

**Click behavior:**

- Clicking a status indicator in minimized state switches to that workspace

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
│                    Setting up CodeHydra                         │
│                                                                 │
│              This is only required on first startup.            │
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
│     Setup could not be completed.                               │
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
│  Click the + button on │
│  a project header to   │
│  create a workspace,   │
│  or open a project via │
│  the Create Workspace  │
│  dialog.               │
│                        │
└────────────────────────┘
```

They can open a project by clicking the folder icon in the Create Workspace dialog.

### Opening a Project

There are two ways to open a project:

1. **Open local repository** - via folder picker
2. **Clone from URL** - via git clone dialog

#### Opening a Local Repository

**Flow:**

1. Click the folder icon in the Create Workspace dialog (or from first-launch auto-open)
2. System folder picker opens
3. Select folder
4. **If not a git repository**: Error message shown in dialog, user can try again
5. Project added to sidebar (main git directory = project)
6. Project auto-selected in the dropdown
7. Focus moves to Name input for efficient form completion
8. Worktree discovery runs (finds worktrees, NOT main directory)
9. **If 0 worktrees found**: User can create a workspace
10. **If 1+ worktrees found**: First workspace activated (if dialog was auto-opened)

#### Cloning from Git URL

**Flow:**

1. Click the git icon in the Create Workspace dialog
2. Git Clone dialog opens
3. Enter repository URL (HTTPS or SSH format)
4. Click Clone (or press Enter)
5. **If URL already cloned**: Existing project is returned (no duplicate clones)
6. Repository cloned as bare repo to managed location
7. Create Workspace dialog opens with new project selected
8. User creates a workspace from the cloned repo

**Git Clone Dialog:**

```
┌────────────────────────────────────────────────────────────┐
│  Clone from Git Repository                            [×]  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Repository URL                                            │
│  [https://github.com/org/repo.git_____________]            │
│                                                            │
│  Cloning repository...                                     │ ← Status message
│                                                            │
├────────────────────────────────────────────────────────────┤
│                           [Cancel]  [Clone]                │
│                                        ↑                   │
│                               Disabled until valid URL     │
└────────────────────────────────────────────────────────────┘
```

**URL validation:**

- HTTPS: `https://hostname/path/repo.git` (or without `.git`)
- SSH: `git@hostname:org/repo.git`
- Invalid URLs show error message, Clone button disabled

**Duplicate detection:**

- URLs are normalized for comparison (lowercase, `.git` stripped, etc.)
- Cloning same URL returns existing project instead of error

**Note**: The main git directory is the PROJECT, not a workspace. Only worktrees are workspaces.

**Error dialog (shown when folder is not a valid git repository):**

```
┌────────────────────────────────────────────────────────────┐
│  Could Not Open Project                                    │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Path is not a git repository root:                   │  │
│  │ /path/to/folder. Please select the                   │  │
│  │ root directory of your git repository.               │  │
│  └──────────────────────────────────────────────────────┘  │
│   (role="alert" for screen reader announcements)           │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                  [Cancel]  [Select Different Folder]       │
│                     ↑              ↑                       │
│                  secondary      primary (default focus)    │
│                  (Esc key)      (Enter key)                │
└────────────────────────────────────────────────────────────┘
```

**Error dialog behavior:**

| Action                          | Result                                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| Click "Select Different Folder" | Opens folder picker; on success closes dialog; on cancel keeps dialog open |
| Click "Cancel"                  | Closes dialog, returns to normal state                                     |
| Press Escape                    | Same as Cancel                                                             |
| Press Enter                     | Same as "Select Different Folder" (default focus)                          |
| Click outside dialog            | Same as Cancel                                                             |

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

**Flow (project with no workspaces):**

1. Hover project row → [×] button becomes visible
2. Click [×]
3. Project removed from sidebar immediately
4. **NO files or git data deleted**

**Flow (project with workspaces):**

1. Hover project row → [×] button becomes visible
2. Click [×]
3. **Confirmation dialog** opens showing workspace count
4. Two options:
   - **Close Project** (default): Workspaces remain on disk
   - **Remove & Close** (checkbox): All workspaces AND their branches are deleted, then project closes

**Close Project Dialog (local project):**

```
┌──────────────────────────────────────────────────────────────┐
│  Close Project                                          [×]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  This project has 3 workspaces that will remain on disk      │
│  after closing.                                              │
│                                                              │
│  ☐ Remove all workspaces and their branches                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    [Cancel]  [Close Project]                 │
│                              ↑                               │
│                    Button changes to "Remove & Close"        │
│                    when checkbox is checked                  │
└──────────────────────────────────────────────────────────────┘
```

**Close Project Dialog (cloned from URL - has remoteUrl):**

```
┌──────────────────────────────────────────────────────────────┐
│  Close Project                                          [×]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  This project has 3 workspaces that will remain on disk      │
│  after closing.                                              │
│                                                              │
│  ☐ Remove all workspaces and their branches                  │
│                                                              │
│  ☐ Delete cloned repository and all local files              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ⚠ This will permanently delete the cloned repository   │  │ ← Only shown when
│  │   and all workspaces. You can clone it again from:     │  │   delete checkbox
│  │   https://github.com/org/repo.git                      │  │   is checked
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    [Cancel]  [Delete & Close]                │
│                              ↑                               │
│                    Button changes to "Delete & Close"        │
│                    when delete checkbox is checked           │
└──────────────────────────────────────────────────────────────┘
```

**Delete checkbox behavior (cloned projects only):**

- Only visible for projects that have a `remoteUrl` (were cloned from URL)
- Checking this checkbox also auto-checks "Remove all workspaces"
- The "Remove all workspaces" checkbox becomes disabled when delete is checked
- Shows a warning with the original clone URL so users can re-clone if needed

**Post-close behavior:**

- If active workspace was in closed project → switch to another project's workspace
- If no projects remain → show empty state

**Hover state:**

```
┌────────────────────────────────────────┐
│ 📁 my-project    [+][×]        │  ← [×] visible on hover
│   └─ 🌿 feature          [×]   │
└────────────────────────────────────────┘
```

### Selecting a Workspace

**Flow:**

1. Click workspace row in sidebar
2. Workspace view becomes visible instantly (no reload)
3. Previous workspace hidden (VS Code state preserved)
4. Sidebar highlights new active workspace

**Visual feedback:**

```

│ 📁 my-project [+][×] │
│ └─ 🌿 feature [×] │ ← Normal
│ └─ 🌿 bugfix [×] │ ← ACTIVE (highlighted)

```

### Creating a Workspace

**Flow:**

1. Click [+] on project row (or dialog auto-shows when workspace count becomes 0)
2. Create dialog opens
3. Select target project from dropdown (defaults to current workspace's project)
4. Enter workspace name OR select an existing branch from the dropdown
5. Select base branch from dropdown (the branch to create new worktree from)
6. Click OK
7. Git worktree created in managed location (NOT in main directory)
8. New workspace becomes active

**Auto-show dialog behavior:**

The Create Workspace dialog automatically appears when ALL of these conditions are met:

- Workspace count becomes 0 (e.g., after deleting the last workspace)
- At least one project exists
- Loading is complete
- No dialog is currently open
- No deletion is in progress

The dialog is dismissible via Cancel button (returns user to logo backdrop). This prevents users from being stuck in an empty state when they have projects but no workspaces.

**Name field behavior:**

The Name field is a filterable dropdown that supports both:

- **Custom name entry**: Type a new branch name and press Enter
- **Existing branch selection**: Select from local branches without worktrees or remote branches without local counterparts

When selecting an existing branch from the dropdown:

- The name field auto-fills with the branch name
- The base branch field auto-fills with a suggested base:
  - For local branches: uses `codehydra.base` config or matching `origin/*` branch
  - For remote branches: uses the full remote ref (e.g., `origin/feature-x`)

When typing a custom name and pressing Enter with no dropdown selection:

- The typed text is used as the new branch name
- No auto-fill of base branch (user must select manually)

Validation occurs when the user presses Enter or selects an option, not on blur.

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

┌────────────────────────────────────────────┐
│ Create Workspace                           │
│                                            │
│ Project                                    │
│ [my-project_______________________▼] [📁]  │ ← Folder icon opens picker
│                                            │
│ Name                                       │
│ [________________________________]         │
│                                            │
│ Base Branch [◐]                            │ ← Spinner while fetching
│ [main_____________________________▼]       │
│                                            │
│                       [Cancel] [OK]        │
│                                ~~~~        │ ← Disabled until valid
└────────────────────────────────────────────┘

```

**Folder icon behavior:**

- Opens native folder picker
- On success: adds project, auto-selects it in dropdown, focuses Name input
- On error (not a git repo): shows error message in dialog

Validation error:

```

│ Name │
│ [-invalid____________________________] │ ← Red border
│ ⚠ Must start with letter or number │

```

Note: Name uniqueness is validated against the selected project's existing workspaces.

Valid state:

```

│ Project │
│ [my-project_______________________▼] │
│ │
│ Name │
│ [my-feature__________________________] │
│ │
│ Base Branch │
│ [origin/main______________________▼] │
│ │
│ [Cancel] [OK] │
│ ════ │ ← Enabled

```

Creating:

```

│ [Cancel] [◐ Creating...] │
│ ~~~~~~~~ ~~~~~~~~~~~~~~~ │ ← Both disabled

```

Error:

```

│ ┌────────────────────────────────────┐ │
│ │ ⚠ Failed to create workspace. │ │
│ │ Please try again. │ │
│ └────────────────────────────────────┘ │
│ │
│ [Cancel] [OK] │ ← OK re-enabled for retry

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

│ └─ 🌿 feature [×] │ ← [×] appears on hover

```

**Confirmation dialog (clean):**

```

┌────────────────────────────────────────────┐
│ Remove Workspace │
│ │
│ Remove workspace "feature-auth"? │
│ │
│ ☑ Delete branch │
│ │
│ [Cancel] [Remove] │
└────────────────────────────────────────────┘

```

**Confirmation dialog (checking state):**

```

┌────────────────────────────────────────────┐
│ Remove Workspace │
│ │
│ Remove workspace "feature-auth"? │
│ │
│ Checking for uncommitted changes... │
│ │
│ ☐ Delete branch │
│ │
│ [Cancel] [Remove] │
│ ~~~~~~~~ │ ← Disabled
└────────────────────────────────────────────┘

```

**Confirmation dialog (uncommitted changes warning):**

```

┌────────────────────────────────────────────┐
│ Remove Workspace │
│ │
│ Remove workspace "feature-auth"? │
│ │
│ ┌────────────────────────────────────┐ │
│ │ ⚠ This workspace has uncommitted │ │
│ │ changes that will be lost. │ │
│ └────────────────────────────────────┘ │
│ │
│ ☑ Delete branch │
│ │
│ [Cancel] [Remove] │
└────────────────────────────────────────────┘

```

**Removing state:**

```

│ [Cancel] [Removing...] │
│ ~~~~~~~~ ~~~~~~~~~~~~ │ ← Both disabled

```

**Deletion in progress (sidebar):**

When deletion is in progress, the workspace shows a spinner and the [×] button is hidden to prevent double-deletion:

```
│ └─ 🌿 feature    ◐     │ ← Spinner, [×] hidden
```

**Deletion failed (sidebar):**

If deletion fails, a warning icon appears. The [×] button remains hidden. Click the workspace to see the DeletionProgressView with retry options:

```
│ └─ 🌿 feature    ⚠     │ ← Warning icon (red), [×] hidden
```

**Deletion failed with blocking processes (Windows only):**

When deletion fails because files are locked by other processes, a scrollable list shows blocking processes with their locked files:

```
┌────────────────────────────────────────────────────────────────────────┐
│  ⚠ Deletion blocked by 2 process(es) holding 3 file(s)                │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ node.exe (PID: 1234)                                               │ │
│ │   C:\...\node.exe server.js                                        │ │
│ │   Working directory: subdir/                                       │ │
│ │   • server.js                                                      │ │
│ │   • dist/index.js                                                  │ │
│ │                                                                    │ │
│ │ Code.exe (PID: 5678)                                               │ │
│ │   C:\Program Files\...\Code.exe --folder ...                       │ │
│ │   (no files detected)                                              │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│       ↑ scrollable region (max-height: 300px, role="region")           │
│                                                                        │
│  ┌───────────────────┐                                                 │
│  │ Retry           ▼ │      [Dismiss]                                  │
│  ├───────────────────┤         ↑                                       │
│  │ Kill Processes    │      secondary                                  │
│  │ Close Handles     │      (has tooltip)                              │
│  │ Ignore Blockers   │                                                 │
│  └───────────────────┘                                                 │
│    ↑ split button with dropdown                                        │
└────────────────────────────────────────────────────────────────────────┘
```

**Button behavior:**

| Button          | Action                                                          |
| --------------- | --------------------------------------------------------------- |
| Retry (main)    | Retries deletion, skips detection (user claims locks released)  |
| Kill Processes  | Kills listed processes via taskkill, then detects to verify     |
| Close Handles   | Closes file handles (requires UAC elevation), then detects      |
| Ignore Blockers | Skips detection entirely (escape hatch for false positives)     |
| Dismiss         | Closes dialog; workspace removed from sidebar, files may remain |

**Button rationale:**

- **Retry** is the main action because locks may have been released manually
- **Kill Processes** terminates processes - destructive but restartable
- **Close Handles** forcibly closes handles - may corrupt process state, requires elevation
- **Ignore Blockers** skips detection for power users who know the locks are safe
- **Dismiss** closes the dialog with a tooltip explaining that the workspace will be removed from CodeHydra but blocking processes and files may remain on disk

All buttons are disabled during operation. The main Retry button shows a spinner.

**Dismiss button tooltip:** "Close dialog. Workspace will be removed from CodeHydra, but blocking processes and files may remain on disk."

**Accessibility:** The blocking processes list uses `role="region"` and `aria-label="Blocking processes"` for screen reader navigation.

**Note:** This feature is Windows-only. On Linux/macOS, file locking works differently and blocking processes are not detected.

**Shortcut overlay during deletion:**

When the active workspace is being deleted, the Del shortcut hint is hidden in the overlay, and Alt+X+Del does nothing.

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

### App Icon Badge

The app icon displays a visual indicator showing the overall status of all workspaces. This provides an at-a-glance status when CodeHydra is minimized or in the background.

**Badge states:**

| State       | Visual             | Meaning                          |
| ----------- | ------------------ | -------------------------------- |
| No badge    | (none)             | All workspaces ready (idle)      |
| Red circle  | ● (solid red)      | All workspaces working (busy)    |
| Split badge | ◐ (half green/red) | Mixed (some ready, some working) |

**Badge behavior:**

- Badge updates in real-time as workspace status changes
- No badge when all workspaces are ready (green/idle)
- Red circle when all workspaces are working (red/busy)
- Half green/half red when some workspaces are ready and some are working

**Platform support:**

| Platform | Location               | Technology                                   |
| -------- | ---------------------- | -------------------------------------------- |
| macOS    | Dock icon              | Unicode symbols: ● (working), ◐ (mixed)      |
| Windows  | Taskbar icon (overlay) | 16x16 generated bitmap (red or split circle) |
| Linux    | Launcher icon          | Badge count 1 for active, 0 for none         |

**Status definitions:**

- **Ready (green)**: Workspace where all agents are idle (waiting for user input)
- **Working (red)**: Workspace where at least one agent is busy processing
- **Waiting for permission**: Counts as ready (green) since agent is waiting for user action

**Visual appearance:**

- **macOS**: Native dock badge with Unicode circle character
- **Windows**: Taskbar overlay icon (16x16 generated image with anti-aliased circles)
- **Linux**: Launcher badge count (Unity launcher only, silently fails on other desktop environments)

**Sidebar with status:**

```

│ 📁 my-project [+][×] │
│ └─ 🌿 feature 🟢 [×] │ ← Idle (or waiting for permission)
│ └─ 🌿 bugfix 🔴 [×] │ ← Busy (processing)
│ └─ 🌿 hotfix [×] │ ← No agent running

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
| Alt+←          | Previous idle workspace (across all projects)              |
| Alt+→          | Next idle workspace (across all projects)                  |
| Alt+Enter      | Create workspace (for project containing active workspace) |
| Alt+Delete     | Remove active workspace                                    |
| Alt+Backspace  | Remove active workspace                                    |
| Alt+1 to Alt+9 | Jump to workspace 1-9                                      |
| Alt+0          | Jump to workspace 10                                       |

### Behavior Details

**Activation:**

- Press Alt+X: shortcut mode activates
- Overlay appears at bottom center of window
- Workspace index numbers (1-9, 0) appear in sidebar
- Actions only execute while shortcut mode is active
- X can be released after pressing; Alt must stay held

**Navigation:**

- Alt+↑/↓ moves through ALL workspaces across ALL projects
- Alt+←/→ moves through IDLE workspaces only (skips busy workspaces)
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

│ 📁 my-project [+][×] │
│ └─ 🌿 feature-auth [×] │
│ └─ 🌿 bugfix-123 [×] │
│ 📁 other-project [+][×] │
│ └─ 🌿 experiment [×] │

```

**Shortcut mode active:**

```

│ 📁 my-project [+][×] │
│ └─ 1 🌿 feature-auth [×] │ ← Index numbers appear
│ └─ 2 🌿 bugfix-123 [×] │
│ 📁 other-project [+][×] │
│ └─ 3 🌿 experiment [×] │
│ └─ · 🌿 eleventh-ws [×] │ ← Dot for workspaces 11+

```

Index display rules:

- Workspaces 1-9: Show digit (1-9)
- Workspace 10: Show "0"
- Workspaces 11+: Show "·" (dimmed dot, no keyboard shortcut)

**Overlay (bottom center):**

```

┌─────────────────────────────────────────────────────────────────┐
│ ↑↓ Navigate ←→ Idle ⏎ New ⌫ Del 1-0 Jump                        │
└─────────────────────────────────────────────────────────────────┘

```

**Note**: Some hints are conditionally hidden based on application state:

- "↑↓ Navigate" and "1-0 Jump" only visible when more than 1 workspace exists
- "←→ Idle" only visible when more than 1 idle workspace exists
- "⏎ New" only visible when there's an active project
- "⌫ Del" only visible when there's an active workspace

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
│ PROJECTS               │
│                        │
│ No projects open.      │
│ Click the + button on  │
│ a project header to    │
│ create a workspace,    │
│ or open a project via  │
│ the Create Workspace   │
│ dialog.                │
│                        │
└────────────────────────┘

```

### Loading State

```

│ 📁 my-project [+][×] │
│ ◐ Loading workspaces... │

```

### Error State

```

│ 📁 my-project [+][×] │
│ ⚠ Failed to load workspaces │
│ [Retry] │

```

```

```
