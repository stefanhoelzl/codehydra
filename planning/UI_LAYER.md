# UI_LAYER

---

status: COMPLETED
last_updated: 2025-12-06
reviewers: [review-docs, review-typescript, review-electron, review-testing, review-arch]

---

## Overview

- **Problem**: The Electron shell has IPC handlers and view management but no user interface. Users cannot interact with projects or workspaces.

- **Solution**: Implement the Svelte 5 frontend with @vscode-elements, including sidebar, dialogs, and stores that communicate via the existing IPC contract.

- **Risks**:
  | Risk | Likelihood | Impact | Mitigation |
  |------|------------|--------|------------|
  | @vscode-elements compatibility with Svelte 5 | Medium | Medium | Test early; if issues found, use native HTML elements with CSS variables |
  | Store reactivity with IPC events | Low | Medium | Use Svelte 5 runes pattern, test thoroughly |
  | CSS variable availability | Low | Low | Provide fallback values for all VS Code variables |
  | Breaking API change (electronAPI → api) | Certain | Low | Coordinated update of preload, types, and tests in single implementation step |

- **Alternatives Considered**:
  | Alternative | Why Rejected |
  |-------------|--------------|
  | Port Tauri components directly | Tauri version has iframe management we don't need; cleaner to adapt |
  | Use different UI library | @vscode-elements provides consistent VS Code look; already in dependencies |
  | Single monolithic component | Harder to test and maintain; component separation is cleaner |
  | Keep generic `invoke()` pattern | Individual functions provide better discoverability, cleaner call sites, and JSDoc per function |
  | Keep `window.electronAPI` name | Shorter `window.api` is cleaner; breaking change is acceptable in early development |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Electron Main Process                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │  Window Manager │  │  View Manager   │  │     IPC Handlers        │ │
│  │                 │  │  ┌───────────┐  │  │  project:open/close     │ │
│  │                 │  │  │ UI Layer  │  │  │  workspace:create/remove│ │
│  │                 │  │  │ (sidebar) │  │  │  workspace:switch       │ │
│  │                 │  │  └───────────┘  │  │  workspace:list-bases   │ │
│  │                 │  │  ┌───────────┐  │  └─────────────────────────┘ │
│  │                 │  │  │Workspace 1│  │                              │
│  │                 │  │  └───────────┘  │         ▲                    │
│  │                 │  │  ┌───────────┐  │         │                    │
│  │                 │  │  │Workspace 2│  │  ViewManager.setActiveWorkspace()
│  │                 │  │  └───────────┘  │         │                    │
│  └─────────────────┘  └─────────────────┘         │                    │
└───────────────────────────────────────────────────┼────────────────────┘
                                    │               │
                            IPC (contextBridge)     │
                                    │               │
                                    ▼               │
┌─────────────────────────────────────────────────────────────────────────┐
│                      UI Layer (Renderer Process)                        │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         App.svelte                               │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │                      Sidebar.svelte                      │    │   │
│  │  │  <nav aria-label="Projects">                             │    │   │
│  │  │    <ul> <!-- project list -->                            │    │   │
│  │  │      <li> <!-- ProjectItem -->                           │    │   │
│  │  │        <ul> <!-- workspace list -->                      │    │   │
│  │  │          <li aria-current="true"> <!-- WorkspaceItem --> │    │   │
│  │  │        </ul>                                             │    │   │
│  │  │      </li>                                               │    │   │
│  │  │    </ul>                                                 │    │   │
│  │  │  </nav>                                                  │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │                                                                  │   │
│  │  ┌─────────────────┐  ┌─────────────────────┐                   │   │
│  │  │CreateWorkspace  │  │ RemoveWorkspace     │                   │   │
│  │  │    Dialog       │  │     Dialog          │                   │   │
│  │  │  (uses Dialog)  │  │  (uses Dialog)      │                   │   │
│  │  └─────────────────┘  └─────────────────────┘                   │   │
│  │           │                     │                                │   │
│  │           └──────────┬──────────┘                                │   │
│  │                      ▼                                           │   │
│  │              ┌───────────────┐                                   │   │
│  │              │ Dialog.svelte │  ← Base component for all dialogs │   │
│  │              │ - role="dialog", aria-modal="true"                │   │
│  │              │ - aria-labelledby, aria-describedby               │   │
│  │              │ - Focus trap (custom implementation)              │   │
│  │              │ - Escape closes, aria-busy on submit              │   │
│  │              └───────────────┘                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Stores (Svelte 5 Runes)                       │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ projects.ts                                              │    │   │
│  │  │   let projects = $state<Project[]>([]);                  │    │   │
│  │  │   let activeWorkspacePath = $state<string | null>(null); │    │   │
│  │  │   let loadingState = $state<'loading'|'loaded'|'error'>();│   │   │
│  │  │   let loadingError = $state<string | null>(null);        │    │   │
│  │  │   let activeProject = $derived(...);                     │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ dialogs.ts (discriminated union)                         │    │   │
│  │  │   type DialogState =                                     │    │   │
│  │  │     | { type: 'closed' }                                 │    │   │
│  │  │     | { type: 'create'; projectPath: string }            │    │   │
│  │  │     | { type: 'remove'; workspacePath: string }          │    │   │
│  │  │   let triggerElementId = $state<string | null>(null);    │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                       API Layer                                  │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │ Preload exposes window.api with typed functions         │    │   │
│  │  │ api/index.ts re-exports for mockability in tests        │    │   │
│  │  │                                                          │    │   │
│  │  │ import * as api from '$lib/api'; // In components       │    │   │
│  │  │ vi.mock('$lib/api', ...);         // In tests           │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### API Layer Design

**Breaking Change**: The current preload exposes `window.electronAPI` with a generic `invoke()` function. This plan changes to `window.api` with individual typed functions for better discoverability and cleaner call sites.

**Files requiring update**:

- `src/preload/index.ts` - Change `electronAPI` to `api`, replace generic invoke with individual functions
- `src/shared/electron-api.d.ts` - Replace `ElectronAPI` interface with `Api` interface, change `window.electronAPI` to `window.api`
- `src/preload/index.test.ts` - Update tests for new API shape

The renderer's `api/index.ts` re-exports `window.api` for mockability. This indirection enables `vi.mock('$lib/api', ...)` in tests without needing `vi.stubGlobal()`, which is the standard Vitest pattern for module mocking.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Preload Script (preload/index.ts)                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  import { IpcChannels } from '../shared/ipc';  // Channel name constants│
│                                                                         │
│  // Expose typed API directly on window.api                             │
│  contextBridge.exposeInMainWorld('api', {                               │
│    // Commands (each wraps ipcRenderer.invoke with typed channel)       │
│    selectFolder: () => ipcRenderer.invoke(IpcChannels.PROJECT_SELECT),  │
│    openProject: (path) => ipcRenderer.invoke(IpcChannels.PROJECT_OPEN,  │
│                                              { path }),                 │
│    closeProject: (path) => ipcRenderer.invoke(IpcChannels.PROJECT_CLOSE,│
│                                               { path }),                │
│    listProjects: () => ipcRenderer.invoke(IpcChannels.PROJECT_LIST),    │
│    createWorkspace: (projectPath, name, baseBranch) =>                  │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_CREATE,                   │
│                         { projectPath, name, baseBranch }),             │
│    removeWorkspace: (workspacePath, deleteBranch) =>                    │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_REMOVE,                   │
│                         { workspacePath, deleteBranch }),               │
│    switchWorkspace: (workspacePath) =>                                  │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_SWITCH, { workspacePath }),
│    listBases: (projectPath) =>                                          │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_LIST_BASES, { projectPath }),
│    updateBases: (projectPath) =>                                        │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_UPDATE_BASES,             │
│                         { projectPath }),                               │
│    isWorkspaceDirty: (workspacePath) =>                                 │
│      ipcRenderer.invoke(IpcChannels.WORKSPACE_IS_DIRTY, { workspacePath }),
│                                                                         │
│    // Event subscriptions (return Unsubscribe function)                 │
│    onProjectOpened: (callback) => createEventSub('project:opened', cb), │
│    onProjectClosed: (callback) => createEventSub('project:closed', cb), │
│    onWorkspaceCreated: (cb) => createEventSub('workspace:created', cb), │
│    onWorkspaceRemoved: (cb) => createEventSub('workspace:removed', cb), │
│    onWorkspaceSwitched: (cb) => createEventSub('workspace:switched',cb),│
│  });                                                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Renderer API (lib/api/index.ts)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  // Re-export window.api for mockability                                │
│  export const {                                                         │
│    selectFolder,                                                        │
│    openProject,                                                         │
│    closeProject,                                                        │
│    // ... all functions                                                 │
│  } = window.api;                                                        │
│                                                                         │
│  // Re-export types for convenience                                     │
│  export type {                                                          │
│    Project,                                                             │
│    Workspace,                                                           │
│    BaseInfo,                                                            │
│    // ... all types from shared/ipc.ts                                  │
│  } from '@shared/ipc';                                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Component Usage                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  // In components - import from api layer                               │
│  import { openProject, onProjectOpened, type Project } from '$lib/api';│
│                                                                         │
│  // In tests - mock the api layer                                       │
│  vi.mock('$lib/api', () => ({                                          │
│    openProject: vi.fn(),                                                │
│    onProjectOpened: vi.fn(() => vi.fn()), // Returns unsubscribe       │
│  }));                                                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Rate Limiting for Git Operations

The `updateBases` function triggers `git fetch` for all remotes, which can be slow on large repositories. Rate limiting is handled in the **main process IPC handlers** (not in the renderer):

- If an `updateBases` call is in progress for a project, subsequent calls are queued or ignored
- Minimum 5-second interval between fetch operations per project
- This prevents UI spam from triggering multiple concurrent git operations

**Note**: This rate limiting is implemented in `workspace-handlers.ts`, not in this UI layer plan.

### ViewManager Integration

The `workspace:switch` IPC handler in main process coordinates with ViewManager:

```
User clicks workspace in Sidebar
         │
         ▼
┌─────────────────┐
│ Sidebar.svelte  │ ──► api.switchWorkspace(path)
└─────────────────┘            │
                               ▼
                    ┌─────────────────────┐
                    │ IPC Handler (main)  │
                    │ workspace:switch    │
                    └─────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Update       │  │ ViewManager  │  │ Emit         │
    │ AppState     │  │ .setActive() │  │ workspace:   │
    │              │  │ (show/hide)  │  │ switched     │
    └──────────────┘  └──────────────┘  └──────────────┘
                                                │
                               ┌────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │ onWorkspaceSwitched │ ──► Update activeWorkspacePath
                    │ event in renderer   │     in projects store
                    └─────────────────────┘
```

### Data Flow: Opening a Project

```
User clicks "Open Project"
         │
         ▼
┌─────────────────┐
│ Sidebar.svelte  │ ──► api.selectFolder()
└─────────────────┘            │
                               ▼
                    ┌─────────────────────┐
                    │ IPC Handler (main)  │ ──► dialog.showOpenDialog()
                    │ project:select      │
                    └─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Returns path or null│
                    └─────────────────────┘
                               │
         ┌─────────────────────┘
         ▼
┌─────────────────┐
│ api.openProject │ ──► invoke('project:open', { path })
└─────────────────┘            │
                               ▼
                    ┌─────────────────────────────────┐
                    │ IPC Handler (main)              │
                    │ - Validates git repo            │
                    │ - GitWorktreeProvider.list()    │
                    │ - Creates Project object        │
                    │ - Saves to AppState             │
                    │ - ViewManager.createViews()     │
                    │ - Emits project:opened event    │
                    └─────────────────────────────────┘
                               │
         ┌─────────────────────┘
         ▼
┌─────────────────┐
│ onProjectOpened │ ──► projects = [...projects, event.project]
│ $effect cleanup │     activeWorkspacePath = first workspace
└─────────────────┘
```

## UI Design

### CSS Architecture

**File Structure:**

```
src/renderer/lib/styles/
├── variables.css    # VS Code CSS custom properties with fallbacks
├── global.css       # Resets, :focus-visible, global utilities
└── (component styles in .svelte files using scoped <style>)
```

**CSS Import (in main.ts):**

```typescript
import "./lib/styles/variables.css";
import "./lib/styles/global.css";
```

**Key Variables (with fallbacks):**

```css
/* variables.css */
:root {
  --ch-foreground: var(--vscode-foreground, #cccccc);
  --ch-background: var(--vscode-editor-background, #1e1e1e);
  --ch-button-bg: var(--vscode-button-background, #0e639c);
  --ch-button-fg: var(--vscode-button-foreground, #ffffff);
  --ch-input-bg: var(--vscode-input-background, #3c3c3c);
  --ch-input-border: var(--vscode-input-border, #3c3c3c);
  --ch-focus-border: var(--vscode-focusBorder, #007fd4);
  --ch-error-fg: var(--vscode-errorForeground, #f48771);
  --ch-error-bg: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  --ch-list-active-bg: var(--vscode-list-activeSelectionBackground, #094771);

  /* Component-specific */
  --ch-sidebar-width: 250px;
  --ch-dialog-max-width: 450px;
}
```

**CSS Reset (in global.css):**

```css
/* Minimal reset for consistent base */
*,
*::before,
*::after {
  box-sizing: border-box;
}

* {
  margin: 0;
}

body {
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

button,
input,
select,
textarea {
  font: inherit;
}
```

**Focus Visible Styles:**

```css
/* global.css */
:focus-visible {
  outline: 2px solid var(--ch-focus-border);
  outline-offset: 2px;
}

/* Prefix custom utilities with ch- */
.ch-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

**Note**: The variables listed in the "Key Variables" section above are the COMPLETE set required for this phase. Additional variables may be added in future phases.

### Main Layout (Sidebar Only)

```
┌──────────────────────────┬─────────────────────────────────────────────┐
│ <nav aria-label="Projects">                                            │
│                          │                                             │
│  PROJECTS                │                                             │
│                          │                                             │
│  <ul>                    │                                             │
│    <li>                  │                                             │
│      📁 my-project [+][×]│         (WebContentsView managed by         │
│      <ul>                │          Electron main process)             │
│        <li aria-current> │                                             │
│          🌿 feature      │                                             │
│        </li>             │                                             │
│        <li>              │                                             │
│          🌿 bugfix       │                                             │
│        </li>             │                                             │
│      </ul>               │                                             │
│    </li>                 │                                             │
│  </ul>                   │                                             │
│                          │                                             │
│  <button>Open Project</button>                                         │
│ </nav>                   │                                             │
└──────────────────────────┴─────────────────────────────────────────────┘
```

### Empty State

```
┌──────────────────────────┐
│ <nav aria-label="Projects">
│                          │
│  PROJECTS                │
│                          │
│  <p>No projects open.</p>│
│                          │
│  <button>Open Project</button>
│                          │
│ </nav>                   │
└──────────────────────────┘
```

### Loading State

```
┌──────────────────────────┐
│                          │
│  PROJECTS                │
│                          │
│  <div role="status">     │
│    ◐ Loading projects... │
│  </div>                  │
│                          │
└──────────────────────────┘
```

### Dialog Base Component

```svelte
<!-- Dialog.svelte usage -->
<Dialog
  open={true}
  onClose={handleClose}
  aria-labelledby="dialog-title"
  aria-describedby="dialog-desc"
>
  {#snippet title()}<h2 id="dialog-title">Title</h2>{/snippet}
  {#snippet content()}<p id="dialog-desc">Content</p>{/snippet}
  {#snippet actions()}<button>OK</button>{/snippet}
</Dialog>
```

**Accessibility attributes:**

- `role="dialog"`
- `aria-modal="true"`
- `aria-labelledby` → title element ID
- `aria-describedby` → content/description element ID
- `aria-busy="true"` during async operations

**Focus trap implementation:**

```typescript
// On Tab keypress within dialog:
const focusables = dialog.querySelectorAll<HTMLElement>(
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
);
const first = focusables[0];
const last = focusables[focusables.length - 1];

if (event.shiftKey && document.activeElement === first) {
  event.preventDefault();
  last?.focus();
} else if (!event.shiftKey && document.activeElement === last) {
  event.preventDefault();
  first?.focus();
}
```

### Create Workspace Dialog

```
┌──────────────────────────────────────────┐
│  <h2 id="dlg-title">Create Workspace</h2>│
│                                          │
│  <label for="ws-name">Name</label>       │
│  <input id="ws-name" type="text"         │
│         aria-describedby="name-error" /> │
│  <span id="name-error" role="alert">     │  ← Only if error
│    Name cannot be empty                  │
│  </span>                                 │
│                                          │
│  <label for="branch-select">Base Branch</label>
│  <!-- Searchable dropdown (combobox) --> │
│  <div role="combobox"                    │
│       aria-expanded="true|false"         │
│       aria-controls="branch-listbox"     │
│       aria-activedescendant="branch-X">  │
│    <input type="text"                    │  ← Filter input
│           aria-autocomplete="list" />    │
│    <ul id="branch-listbox"               │
│        role="listbox">                   │
│      <li role="presentation">            │
│        Local Branches                    │  ← Group header
│      </li>                               │
│      <li id="branch-1" role="option"     │
│          aria-selected="true">main</li>  │
│      <li id="branch-2" role="option">    │
│        develop</li>                      │
│      <li role="presentation">            │
│        Remote Branches                   │
│      </li>                               │
│      <li id="branch-3" role="option">    │
│        origin/main</li>                  │
│    </ul>                                 │
│  </div>                                  │
│  <p class="empty-state">                 │  ← If filter has no matches
│    No branches found                     │
│  </p>                                    │
│                                          │
│  <!-- Error message area -->             │
│  <div role="alert" class="error-box">    │  ← Only on API error
│    Failed to create workspace            │
│  </div>                                  │
│                                          │
│              [Cancel]  [OK / ◐ Creating...]
└──────────────────────────────────────────┘

Keyboard behavior:
- Tab: Name → Branch combobox → Cancel → OK → (cycle)
- In combobox: Arrow ↑↓ navigate, typing filters, Enter/Tab selects
- Enter (when form valid): Submit
- Escape: Cancel and close

Name validation rules:
- Not empty
- No path separators (/, \)
- No special chars except dash (-) and underscore (_)
- Max 100 characters
- No '..' sequences
- Not duplicate of existing workspace in same project (case-insensitive)
```

### Create Workspace Dialog - Submitting State

```
┌──────────────────────────────────────────┐
│  Create Workspace                        │
│                                          │
│  Name                                    │
│  [my-feature______________________]      │  ← disabled
│                                          │
│  Base Branch                             │
│  [origin/main_____________________]      │  ← disabled
│                                          │
│  <div aria-live="polite">                │
│    Creating workspace...                 │  ← Screen reader announcement
│  </div>                                  │
│                                          │
│              [Cancel]  [◐ Creating...]   │
│              ~~~~~~~~  ~~~~~~~~~~~~~~~   │
│              disabled  disabled+spinner  │
│                                          │
│  (dialog has aria-busy="true")           │
└──────────────────────────────────────────┘
```

### Remove Workspace Dialog

**Simplified to Cancel/OK with checkbox:**

```
┌────────────────────────────────────────────┐
│  <h2>Remove Workspace</h2>                 │
│                                            │
│  <p>Remove workspace "feature-auth"?</p>   │
│                                            │
│  <div class="warning-box" role="alert">    │  ← Only if dirty
│    ⚠ This workspace has uncommitted        │
│    changes that will be lost.              │
│  </div>                                    │
│                                            │
│  <label>                                   │
│    <input type="checkbox" checked />       │  ← Checked by default
│    Delete branch                           │
│  </label>                                  │
│                                            │
│  <!-- Error message area -->               │
│  <div role="alert" class="error-box">      │  ← Only on API error
│    Failed to remove workspace              │
│  </div>                                    │
│                                            │
│                    [Cancel]  [OK]          │
└────────────────────────────────────────────┘

Keyboard behavior:
- Tab: Checkbox → Cancel → OK → (cycle)
- Enter: Activate focused button (or submit if on OK)
- Escape: Cancel and close
- Space: Toggle checkbox (when focused)
```

### Remove Workspace Dialog - Submitting State

```
┌────────────────────────────────────────────┐
│  Remove Workspace                          │
│                                            │
│  Remove workspace "feature-auth"?          │
│                                            │
│  <label>                                   │
│    <input type="checkbox" checked disabled/>
│    Delete branch                           │
│  </label>                                  │
│                                            │
│  <div aria-live="polite">                  │
│    Removing workspace...                   │
│  </div>                                    │
│                                            │
│                [Cancel]  [◐ Removing...]   │
│                disabled  disabled+spinner  │
│                                            │
│  (dialog has aria-busy="true")             │
└────────────────────────────────────────────┘
```

### Dialog Keyboard Navigation Summary

| Key       | Create Dialog                               | Remove Dialog                    |
| --------- | ------------------------------------------- | -------------------------------- |
| Tab       | Name → Branch → Cancel → OK → (cycle)       | Checkbox → Cancel → OK → (cycle) |
| Shift+Tab | Reverse of Tab                              | Reverse of Tab                   |
| Enter     | Submit if valid, or activate focused button | Activate focused button          |
| Escape    | Cancel and close                            | Cancel and close                 |
| Space     | N/A                                         | Toggle checkbox                  |
| Arrow ↑↓  | Navigate branch list (when combobox open)   | N/A                              |
| Typing    | Filter branch list (when combobox focused)  | N/A                              |

### User Interactions

| Interaction          | Component    | Action                                           |
| -------------------- | ------------ | ------------------------------------------------ |
| Click "Open Project" | Sidebar      | api.selectFolder() → api.openProject()           |
| Click project [+]    | Sidebar      | Open CreateWorkspaceDialog                       |
| Click project [×]    | Sidebar      | api.closeProject() (no confirmation - see note)  |
| Click workspace row  | Sidebar      | api.switchWorkspace()                            |
| Click workspace [×]  | Sidebar      | Open RemoveWorkspaceDialog                       |
| Dialog Cancel/Escape | Dialog       | Close, return focus to trigger element           |
| Dialog OK (Create)   | CreateDialog | Spinner on OK, api.createWorkspace()             |
| Dialog OK (Remove)   | RemoveDialog | Spinner on OK, api.removeWorkspace(deleteBranch) |

**Note on project close**: Closing a project does not show a confirmation dialog. This is intentional:

- Workspaces are git worktrees; uncommitted changes remain on disk
- User can reopen the project immediately if closed by mistake
- Future enhancement (Phase 5+): Add confirmation if any workspace has uncommitted changes

## Implementation Steps

**Note: Follow TDD - write failing tests FIRST, then implement.**

### Step 1: Test Infrastructure

- [x] **Step 1.1: Write test utilities and fixtures**
  - Files:
    - `src/renderer/lib/test-utils.ts` (new)
    - `src/renderer/lib/test-fixtures.ts` (new)
  - Implementation:

    ```typescript
    // test-utils.ts
    import type { Api } from "@shared/electron-api";

    export function createMockApi(): Api {
      return {
        selectFolder: vi.fn().mockResolvedValue(null),
        openProject: vi.fn().mockResolvedValue(undefined),
        closeProject: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
        createWorkspace: vi.fn().mockResolvedValue(undefined),
        removeWorkspace: vi.fn().mockResolvedValue(undefined),
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        listBases: vi.fn().mockResolvedValue([]),
        updateBases: vi.fn().mockResolvedValue(undefined),
        isWorkspaceDirty: vi.fn().mockResolvedValue(false),
        // Event subscriptions return unsubscribe functions
        onProjectOpened: vi.fn(() => vi.fn()),
        onProjectClosed: vi.fn(() => vi.fn()),
        onWorkspaceCreated: vi.fn(() => vi.fn()),
        onWorkspaceRemoved: vi.fn(() => vi.fn()),
        onWorkspaceSwitched: vi.fn(() => vi.fn()),
      };
    }

    // test-fixtures.ts
    import type { Project, Workspace, BaseInfo } from "@shared/ipc";

    export function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
      return {
        path: "/test/project/.worktrees/feature-1",
        name: "feature-1",
        branch: "feature-1",
        isMain: false,
        ...overrides,
      };
    }

    export function createMockProject(overrides: Partial<Project> = {}): Project {
      return {
        path: "/test/project",
        name: "test-project",
        workspaces: [createMockWorkspace()],
        ...overrides,
      };
    }

    export function createMockBaseInfo(overrides: Partial<BaseInfo> = {}): BaseInfo {
      return {
        name: "main",
        isRemote: false,
        ...overrides,
      };
    }
    ```

- [x] **Step 1.2: Write tests for test utilities**
  - File: `src/renderer/lib/test-utils.test.ts` (new)
  - Tests:
    - `createMockApi returns object with all Api functions`
    - `createMockApi event subscriptions return unsubscribe functions`
    - `createMockProject returns valid Project with defaults`
    - `createMockProject allows property overrides`
    - `createMockWorkspace returns valid Workspace with defaults`
    - `createMockBaseInfo returns valid BaseInfo with defaults`

- [x] **Step 1.3: Configure vitest for component tests**
  - Verify `@testing-library/svelte` works with Svelte 5
  - Update `vitest.config.ts` to add coverage configuration:
    ```typescript
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/renderer/**/*.ts', 'src/renderer/**/*.svelte'],
      exclude: ['**/*.test.ts', '**/test-*.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    }
    ```

### Step 2: Global Styles

- [x] **Step 2.1: Create CSS files**
  - Files:
    - `src/renderer/lib/styles/variables.css` (new)
    - `src/renderer/lib/styles/global.css` (new)
  - Content:
    - VS Code CSS custom properties with fallbacks (prefixed `--ch-`)
    - `:focus-visible` styles with 2px outline
    - `.ch-visually-hidden` for screen reader text
    - CSS reset for consistent base styles

- [x] **Step 2.2: Import styles in main.ts**
  - Update `src/renderer/main.ts`:
    ```typescript
    import "./lib/styles/variables.css";
    import "./lib/styles/global.css";
    ```

### Step 3: Preload API Update

**Breaking Change**: This step changes `window.electronAPI` to `window.api` with individual functions.

- [x] **Step 3.1: Write tests for new preload API**
  - File: `src/preload/index.test.ts` (update existing tests)
  - Tests for each command function:
    - `api.selectFolder calls ipcRenderer.invoke with 'project:select-folder'`
    - `api.openProject calls ipcRenderer.invoke with channel and path`
    - `api.closeProject calls ipcRenderer.invoke with channel and path`
    - `api.listProjects calls ipcRenderer.invoke with 'project:list'`
    - `api.createWorkspace calls ipcRenderer.invoke with correct payload`
    - `api.removeWorkspace calls ipcRenderer.invoke with correct payload`
    - `api.switchWorkspace calls ipcRenderer.invoke with workspacePath`
    - `api.listBases calls ipcRenderer.invoke with projectPath`
    - `api.updateBases calls ipcRenderer.invoke with projectPath`
    - `api.isWorkspaceDirty calls ipcRenderer.invoke with workspacePath`
  - Tests for each event subscription:
    - `api.onProjectOpened subscribes to 'project:opened' and returns unsubscribe`
    - `api.onProjectClosed subscribes to 'project:closed' and returns unsubscribe`
    - `api.onWorkspaceCreated subscribes and returns unsubscribe`
    - `api.onWorkspaceRemoved subscribes and returns unsubscribe`
    - `api.onWorkspaceSwitched subscribes and returns unsubscribe`
  - Error handling tests:
    - `api functions propagate IPC errors to caller`

- [x] **Step 3.2: Update preload to expose window.api**
  - File: `src/preload/index.ts` (update)
  - Change `contextBridge.exposeInMainWorld('electronAPI', ...)` to `'api'`
  - Replace generic `invoke` with individual typed functions
  - Use `IpcChannels` constants from `src/shared/ipc.ts` for channel names
  - Keep existing `createEventSubscription` helper for event subscriptions
  - Add JSDoc comments to all functions

- [x] **Step 3.3: Update type definitions**
  - File: `src/shared/electron-api.d.ts` (update)
  - Rename `ElectronAPI` interface to `Api`
  - Replace generic `invoke<K>()` with individual function signatures:
    ```typescript
    export interface Api {
      selectFolder(): Promise<string | null>;
      openProject(path: string): Promise<void>;
      closeProject(path: string): Promise<void>;
      listProjects(): Promise<Project[]>;
      createWorkspace(projectPath: string, name: string, baseBranch: string): Promise<void>;
      removeWorkspace(workspacePath: string, deleteBranch: boolean): Promise<void>;
      switchWorkspace(workspacePath: string): Promise<void>;
      listBases(projectPath: string): Promise<BaseInfo[]>;
      updateBases(projectPath: string): Promise<void>;
      isWorkspaceDirty(workspacePath: string): Promise<boolean>;
      // Event subscriptions
      onProjectOpened(callback: (event: ProjectOpenedEvent) => void): Unsubscribe;
      onProjectClosed(callback: (event: ProjectClosedEvent) => void): Unsubscribe;
      onWorkspaceCreated(callback: (event: WorkspaceCreatedEvent) => void): Unsubscribe;
      onWorkspaceRemoved(callback: (event: WorkspaceRemovedEvent) => void): Unsubscribe;
      onWorkspaceSwitched(callback: (event: WorkspaceSwitchedEvent) => void): Unsubscribe;
    }
    ```
  - Change global declaration from `window.electronAPI` to `window.api`
  - Export `Unsubscribe` type (already exported, verify it remains exported)

### Step 4: Renderer API Layer

- [x] **Step 4.1: Write tests for API re-exports**
  - File: `src/renderer/lib/api/index.test.ts` (new)
  - Tests:
    - `exports all API functions from window.api`
    - `exports all types from shared/ipc`
    - `throws descriptive error if window.api is undefined`
    - Type-level tests with `expectTypeOf`:
      ```typescript
      expectTypeOf(api.openProject).parameter(0).toMatchTypeOf<string>();
      expectTypeOf(api.onProjectOpened).returns.toMatchTypeOf<Unsubscribe>();
      expectTypeOf<typeof api.listProjects>().returns.resolves.toMatchTypeOf<Project[]>();
      ```

- [x] **Step 4.2: Create API re-export module**
  - File: `src/renderer/lib/api/index.ts` (new)
  - Check `window.api` existence and throw helpful error if missing
  - Re-export `window.api` functions for mockability in tests
  - Re-export types from `@shared/ipc`
  - Implementation:

    ```typescript
    import type { Unsubscribe } from "@shared/electron-api";

    if (typeof window === "undefined" || !window.api) {
      throw new Error(
        "window.api is not available. " + "Ensure the preload script is loaded correctly."
      );
    }

    export const {
      selectFolder,
      openProject,
      closeProject,
      listProjects,
      createWorkspace,
      removeWorkspace,
      switchWorkspace,
      listBases,
      updateBases,
      isWorkspaceDirty,
      onProjectOpened,
      onProjectClosed,
      onWorkspaceCreated,
      onWorkspaceRemoved,
      onWorkspaceSwitched,
    } = window.api;

    export type { Project, Workspace, BaseInfo, Unsubscribe } from "@shared/ipc";
    ```

### Step 5: Projects Store

- [x] **Step 5.1: Write failing tests for projects store**
  - File: `src/renderer/lib/stores/projects.test.ts` (new)
  - Tests:
    - `initializes with empty projects array`
    - `initializes with loadingState 'loading'`
    - `initializes with loadingError null`
    - `addProject updates projects array (immutable)`
    - `removeProject removes from array and updates active`
    - `setActiveWorkspace updates activeWorkspacePath`
    - `activeProject derived returns correct project`
    - `activeProject derived returns undefined when no match`
    - `flatWorkspaceList derived flattens all workspaces`
    - `derived stores update when source changes`
    - `setError sets loadingState to 'error' and stores message`
    - `event subscriptions are set up in $effect`
    - `event subscriptions are cleaned up on unmount (verify unsubscribe called)`
  - Error handling tests:
    - `handles API errors gracefully (stores error message)`
    - `listProjects rejection sets error state`

- [x] **Step 5.2: Implement projects store**
  - File: `src/renderer/lib/stores/projects.ts` (new)
  - Use Svelte 5 runes: `$state`, `$derived`
  - Use **mutable** array type with **immutable update patterns** (reassignment):

    ```typescript
    import type { Project } from "$lib/api";

    // State (mutable type, but always use reassignment for updates)
    let projects = $state<Project[]>([]);
    let activeWorkspacePath = $state<string | null>(null);
    let loadingState = $state<"loading" | "loaded" | "error">("loading");
    let loadingError = $state<string | null>(null);

    // Derived (explicitly typed, can be undefined)
    const activeProject = $derived<Project | undefined>(
      projects.find((p) => p.workspaces.some((w) => w.path === activeWorkspacePath))
    );

    const flatWorkspaceList = $derived(
      projects.flatMap((p) => p.workspaces.map((w) => ({ projectPath: p.path, workspace: w })))
    );

    // Actions (use reassignment, not mutation)
    function addProject(project: Project) {
      projects = [...projects, project];
    }

    function removeProject(path: string) {
      projects = projects.filter((p) => p.path !== path);
      // Update active if removed project contained active workspace
      if (activeProject?.path === path) {
        activeWorkspacePath = projects[0]?.workspaces[0]?.path ?? null;
      }
    }

    function setError(message: string) {
      loadingState = "error";
      loadingError = message;
    }
    ```

  - Event subscriptions in `$effect()` with array-based cleanup pattern

### Step 6: Dialog State Store

- [x] **Step 6.1: Write failing tests for dialog store**
  - File: `src/renderer/lib/stores/dialogs.test.ts` (new)
  - Tests:
    - `initializes with type 'closed'`
    - `initializes with triggerElementId null`
    - `openCreateDialog sets type to 'create' with projectPath`
    - `openCreateDialog stores triggerElementId`
    - `openRemoveDialog sets type to 'remove' with workspacePath`
    - `openRemoveDialog stores triggerElementId`
    - `closeDialog sets type to 'closed' and clears triggerElementId`
    - `opening new dialog closes previous (exclusive)`
    - `getTriggerElement returns element by ID or null`

- [x] **Step 6.2: Implement dialog store**
  - File: `src/renderer/lib/stores/dialogs.ts` (new)
  - **Important**: Store element ID string instead of DOM reference to avoid lifecycle issues

    ```typescript
    type DialogState =
      | { type: "closed" }
      | { type: "create"; projectPath: string }
      | { type: "remove"; workspacePath: string };

    let dialogState = $state<DialogState>({ type: "closed" });
    let triggerElementId = $state<string | null>(null);

    function openCreateDialog(projectPath: string, triggerId: string | null) {
      dialogState = { type: "create", projectPath };
      triggerElementId = triggerId;
    }

    function openRemoveDialog(workspacePath: string, triggerId: string | null) {
      dialogState = { type: "remove", workspacePath };
      triggerElementId = triggerId;
    }

    function closeDialog() {
      dialogState = { type: "closed" };
      triggerElementId = null;
    }

    function getTriggerElement(): HTMLElement | null {
      if (!triggerElementId) return null;
      return document.getElementById(triggerElementId);
    }
    ```

  - Components assign unique IDs to trigger buttons (e.g., `id="add-ws-{projectPath}"`)
  - Dialog uses `getTriggerElement()` on close to return focus

### Step 7: Dialog Base Component

- [x] **Step 7.1: Write failing tests for Dialog component**
  - File: `src/renderer/lib/components/Dialog.test.ts` (new)
  - Accessibility tests:
    - `renders with role="dialog" and aria-modal="true"`
    - `has aria-labelledby pointing to title`
    - `has aria-describedby when provided`
    - `sets aria-busy when busy prop is true`
  - Render tests:
    - `renders title, content, actions snippets`
    - `does not render when open is false`
  - Focus management tests:
    - `initial focus on first focusable element`
    - `Tab cycles within dialog (focus trap)`
    - `Shift+Tab cycles in reverse`
    - `Tab from last focusable goes to first`
    - `returns focus to trigger element on close`
  - Interaction tests:
    - `click on overlay calls onClose`
    - `Escape key calls onClose`
    - `click inside dialog does not call onClose`

- [x] **Step 7.2: Create focus trap utility**
  - File: `src/renderer/lib/utils/focus-trap.ts` (new)
  - Extract focus trap logic for reusability and testability:

    ```typescript
    export function createFocusTrap(container: HTMLElement) {
      const focusableSelector =
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

      function getFocusables(): HTMLElement[] {
        return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector));
      }

      function handleKeyDown(event: KeyboardEvent) {
        if (event.key !== "Tab") return;

        const focusables = getFocusables();
        if (focusables.length === 0) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      return {
        activate: () => container.addEventListener("keydown", handleKeyDown),
        deactivate: () => container.removeEventListener("keydown", handleKeyDown),
        focusFirst: () => getFocusables()[0]?.focus(),
      };
    }
    ```

- [x] **Step 7.3: Implement Dialog component**
  - File: `src/renderer/lib/components/Dialog.svelte` (new)
  - Props (using `$props()` rune):

    ```typescript
    interface DialogProps {
      open: boolean;
      onClose: () => void;
      busy?: boolean;
      title: Snippet;
      content: Snippet;
      actions: Snippet;
      "aria-labelledby": string;
      "aria-describedby"?: string;
    }

    let {
      open,
      onClose,
      busy = false,
      title,
      content,
      actions,
      "aria-labelledby": labelledby,
      "aria-describedby": describedby,
    }: DialogProps = $props();
    ```

  - Use focus trap utility from `$lib/utils/focus-trap`
  - Use `getTriggerElement()` from dialog store to return focus on close

### Step 8: Empty State Component

- [x] **Step 8.1: Write failing tests for EmptyState**
  - File: `src/renderer/lib/components/EmptyState.test.ts` (new)
  - Tests:
    - `renders "No projects open" message`
    - `renders "Open Project" button`
    - `button click calls onOpenProject callback`
    - `button is keyboard accessible`

- [x] **Step 8.2: Implement EmptyState component**
  - File: `src/renderer/lib/components/EmptyState.svelte` (new)

### Step 9: Sidebar Component

- [x] **Step 9.1: Write failing tests for Sidebar**
  - File: `src/renderer/lib/components/Sidebar.test.ts` (new)
  - Accessibility tests:
    - `renders with nav element and aria-label="Projects"`
    - `active workspace has aria-current="true"`
    - `action buttons are always in DOM (accessible)`
    - `action buttons have unique IDs for focus management`
    - `long branch names (>30 chars) show title attribute with full name`
  - State rendering tests:
    - `shows loading state when loadingState is 'loading'`
    - `shows empty state when no projects`
    - `shows error state with error message when loadingState is 'error'`
    - `shows retry button on error state`
    - `retry button calls listProjects`
  - List structure tests:
    - `renders project list with ul/li structure`
    - `renders workspaces under each project`
  - Interaction tests:
    - `hover shows action buttons (CSS visibility change, not removal)`
    - `[+] button opens create dialog with projectPath`
    - `[×] on project calls closeProject`
    - `[×] on workspace opens remove dialog with workspacePath`
    - `clicking workspace calls switchWorkspace`
    - `Open Project button triggers selectFolder flow`
  - Error handling tests:
    - `selectFolder rejection shows error (or handles gracefully)`
    - `openProject rejection shows error state`
    - `closeProject rejection shows error (toast/inline)`
    - `switchWorkspace rejection does not corrupt state`

- [x] **Step 9.2: Implement Sidebar component**
  - File: `src/renderer/lib/components/Sidebar.svelte` (new)
  - Semantic HTML: `<nav>`, `<ul>`, `<li>`, `<button>`
  - Action buttons always in DOM, CSS visibility on hover/focus-within
  - Assign unique IDs to action buttons: `id="add-ws-{projectPath}"`, `id="close-project-{projectPath}"`, `id="remove-ws-{workspacePath}"`
  - Truncate long branch names with CSS and add `title` attribute for tooltip

### Step 10: Branch Dropdown Component

- [x] **Step 10.1: Write failing tests for BranchDropdown**
  - File: `src/renderer/lib/components/BranchDropdown.test.ts` (new)
  - Accessibility tests:
    - `renders with combobox role and aria attributes`
    - `selected option has aria-selected="true"`
    - `aria-activedescendant updates on navigation`
    - `aria-expanded reflects dropdown open state`
  - Loading tests:
    - `loads branches using api.listBases(projectPath) on mount`
    - `shows spinner while loading`
    - `handles listBases error gracefully`
  - Display tests:
    - `displays Local and Remote branch groups`
    - `shows "No branches found" when filter has no matches`
  - Debounce tests (use `vi.useFakeTimers()`):
    - `typing doesn't filter immediately`
    - `filter applies after 200ms debounce`
    - `rapid typing resets debounce timer`
  - Keyboard navigation tests:
    - `Arrow Down moves to next option`
    - `Arrow Up moves to previous option`
    - `Arrow Down at last option wraps to first`
    - `Arrow Up at first option wraps to last`
    - `Enter selects current option`
    - `Tab selects current option and moves focus`
    - `Escape closes dropdown without selecting`

- [x] **Step 10.2: Implement BranchDropdown component**
  - File: `src/renderer/lib/components/BranchDropdown.svelte` (new)
  - Props: `projectPath: string`, `value: string`, `onSelect: (branch: string) => void`
  - Load branches using `api.listBases(projectPath)` on mount
  - Full ARIA combobox pattern
  - Debounce filter input (200ms) using setTimeout/clearTimeout
  - **Note**: Rate limiting for `updateBases` (git fetch) is handled in main process IPC handlers, not here

### Step 11: Create Workspace Dialog

- [x] **Step 11.1: Write failing tests for CreateWorkspaceDialog**
  - File: `src/renderer/lib/components/CreateWorkspaceDialog.test.ts` (new)
  - Structure tests:
    - `uses Dialog base component`
    - `renders name input and branch dropdown`
    - `name input has aria-describedby for errors`
  - **Validation tests** (extract validation to pure function for unit testing):
    - `empty name shows error "Name is required"`
    - `name with / shows error "Name cannot contain /"`
    - `name with \ shows error "Name cannot contain \"`
    - `name with .. shows error "Name cannot contain .."`
    - `name > 100 chars shows error "Name must be 100 characters or less"`
    - `duplicate name shows error "Workspace already exists" (case-insensitive)`
    - `valid name clears error`
    - `name with dash and underscore is valid`
  - Keyboard tests:
    - `Tab cycles: Name → Branch → Cancel → OK`
    - `Enter submits when valid`
    - `Escape closes (via Dialog)`
  - Submit flow tests:
    - `OK disabled until form valid`
    - `OK shows spinner during submit`
    - `all inputs disabled during submit`
    - `aria-busy="true" during submit`
    - `aria-live region announces "Creating workspace..."`
    - `api.createWorkspace called with correct params`
    - `success closes dialog`
  - Error handling tests:
    - `api.createWorkspace failure displays error in role="alert"`
    - `error re-enables form for retry`
    - `error message cleared on next submit attempt`

- [x] **Step 11.2: Implement CreateWorkspaceDialog**
  - File: `src/renderer/lib/components/CreateWorkspaceDialog.svelte` (new)
  - Props: `projectPath: string` (from dialog store)
  - **Duplicate validation**: Read existing workspaces from projects store:

    ```typescript
    import { projects } from "$lib/stores/projects";

    const existingNames = $derived(
      projects.find((p) => p.path === projectPath)?.workspaces.map((w) => w.name.toLowerCase()) ??
        []
    );

    function validateName(name: string): string | null {
      if (!name.trim()) return "Name is required";
      if (name.includes("/")) return "Name cannot contain /";
      if (name.includes("\\")) return "Name cannot contain \\";
      if (name.includes("..")) return "Name cannot contain ..";
      if (name.length > 100) return "Name must be 100 characters or less";
      if (!/^[a-zA-Z0-9_-]+$/.test(name))
        return "Name can only contain letters, numbers, dash, underscore";
      if (existingNames.includes(name.toLowerCase())) return "Workspace already exists";
      return null;
    }
    ```

### Step 12: Remove Workspace Dialog

- [x] **Step 12.1: Write failing tests for RemoveWorkspaceDialog**
  - File: `src/renderer/lib/components/RemoveWorkspaceDialog.test.ts` (new)
  - Structure tests:
    - `uses Dialog base component`
    - `renders confirmation with workspace name`
    - `renders "Delete branch" checkbox, checked by default`
  - Dirty status tests:
    - `loads dirty status using api.isWorkspaceDirty(workspacePath) on mount`
    - `shows spinner while checking dirty status`
    - `shows warning box when workspace is dirty`
    - `hides warning box when workspace is clean`
    - `handles isWorkspaceDirty error gracefully (assume clean)`
  - Keyboard tests:
    - `Tab cycles: Checkbox → Cancel → OK`
    - `Space toggles checkbox`
    - `Enter activates focused button`
    - `Escape closes (via Dialog)`
  - Submit flow tests:
    - `OK calls api.removeWorkspace with workspacePath and deleteBranch value`
    - `OK shows spinner during submit`
    - `checkbox and buttons disabled during submit`
    - `aria-busy="true" during submit`
    - `success closes dialog`
  - Error handling tests:
    - `api.removeWorkspace failure displays error in role="alert"`
    - `error re-enables form for retry`

- [x] **Step 12.2: Implement RemoveWorkspaceDialog**
  - File: `src/renderer/lib/components/RemoveWorkspaceDialog.svelte` (new)
  - Props: `workspacePath: string` (from dialog store)
  - Load dirty status on mount using `api.isWorkspaceDirty(workspacePath)`
  - Extract workspace name from path for display

### Step 13: App Integration

- [x] **Step 13.1: Write failing tests for App**
  - File: `src/renderer/App.test.ts` (new)
  - Render tests:
    - `renders Sidebar`
    - `renders CreateWorkspaceDialog when dialog type is 'create'`
    - `renders RemoveWorkspaceDialog when dialog type is 'remove'`
    - `does not render dialogs when dialog type is 'closed'`
  - Initialization tests:
    - `calls listProjects on mount to initialize`
    - `sets loadingState to 'loaded' after successful listProjects`
    - `sets loadingState to 'error' with message on listProjects failure`
  - Event subscription tests:
    - `subscribes to all IPC events on mount`
    - `unsubscribes from all IPC events on unmount (verify all unsubscribe functions called)`
  - Error handling tests:
    - `handles window.api unavailable gracefully`

- [x] **Step 13.2: Update App.svelte**
  - File: `src/renderer/App.svelte` (update)
  - Import and render Sidebar
  - Conditionally render dialogs based on dialogState
  - Set up IPC event subscriptions in `$effect()` with **array-based cleanup pattern**:

    ```svelte
    <script lang="ts">
      import * as api from "$lib/api";
      import {
        projects,
        setProjects,
        addProject,
        removeProject,
        loadingState,
        setLoaded,
        setError,
        setActiveWorkspace,
      } from "$lib/stores/projects";
      import { dialogState } from "$lib/stores/dialogs";

      $effect(() => {
        // Track all subscriptions for cleanup
        const subscriptions: (() => void)[] = [];

        // Initialize
        api
          .listProjects()
          .then((p) => {
            setProjects(p); // Use store action, not mutation
            setLoaded();
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : "Failed to load projects");
          });

        // Subscribe to events (use immutable updates in callbacks)
        subscriptions.push(api.onProjectOpened((event) => addProject(event.project)));
        subscriptions.push(api.onProjectClosed((event) => removeProject(event.projectPath)));
        subscriptions.push(
          api.onWorkspaceCreated((event) => {
            // Update project's workspaces array immutably
            // Implementation in store action
          })
        );
        subscriptions.push(
          api.onWorkspaceRemoved((event) => {
            // Update project's workspaces array immutably
          })
        );
        subscriptions.push(
          api.onWorkspaceSwitched((event) => setActiveWorkspace(event.workspacePath))
        );

        // Cleanup all subscriptions
        return () => subscriptions.forEach((unsub) => unsub());
      });
    </script>
    ```

### Step 14: Integration Tests

- [x] **Step 14.1: Write integration tests**
  - File: `src/renderer/lib/integration.test.ts` (new)
  - **Happy paths:**
    - `open project: selectFolder returns path → openProject → project:opened event → UI shows project in sidebar`
    - `close project: click [×] → closeProject → project:closed event → project removed from sidebar`
    - `create workspace: click [+] → dialog opens → submit → workspace:created event → new workspace in sidebar`
    - `remove workspace: click [×] → dialog opens → confirm → workspace:removed event → workspace removed from sidebar`
    - `switch workspace: click workspace → workspace:switched event → aria-current updates`
  - **Error paths:**
    - `selectFolder returns null (user cancelled) → no action taken`
    - `openProject rejects with "not a git repo" → error shown in sidebar`
    - `createWorkspace rejects → error shown in dialog, form re-enabled for retry`
    - `removeWorkspace rejects → error shown in dialog, form re-enabled`
    - `API rejection during load → loadingState is 'error', loadingError has message`
  - **Edge cases:**
    - `clicking 5 different workspaces within 100ms results in final clicked workspace being active`
    - `closing CreateWorkspaceDialog while createWorkspace is pending → dialog closes, operation completes in background, UI updates when workspace:created event fires`
    - `opening new project while another is loading → both projects appear when loaded`
  - **State consistency:**
    - `projects store matches sidebar display at all times`
    - `activeWorkspacePath matches aria-current element`

## Testing Strategy

**Note**: Accessibility tests are integrated into each component's test file (Steps 7-12), not a separate step. This follows TDD - accessibility is tested when the component is built.

### Test Utilities

| File                   | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `lib/test-utils.ts`    | `createMockApi()`, render helpers                    |
| `lib/test-fixtures.ts` | `createMockProject()`, `createMockWorkspace()`, etc. |

### Mocking Pattern

```typescript
// In component/store tests
import { vi, beforeEach } from "vitest";
import { createMockApi } from "$lib/test-utils";

// Module-level mock
vi.mock("$lib/api", () => createMockApi());

// Reset mocks between tests to prevent test interdependence
beforeEach(() => {
  vi.clearAllMocks();
});

// For timer-dependent tests (e.g., BranchDropdown debounce)
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
```

### Unit Tests (vitest)

| Test Case            | Description                              | File                            |
| -------------------- | ---------------------------------------- | ------------------------------- |
| test utils api       | createMockApi returns all Api functions  | `test-utils.test.ts`            |
| test utils fixtures  | createMockProject/Workspace work         | `test-utils.test.ts`            |
| preload selectFolder | Calls ipcRenderer.invoke correctly       | `preload/index.test.ts`         |
| preload all commands | Each command calls correct channel       | `preload/index.test.ts`         |
| preload event sub    | Returns unsubscribe function             | `preload/index.test.ts`         |
| preload errors       | IPC errors propagate to caller           | `preload/index.test.ts`         |
| api re-exports       | Exports all functions from window.api    | `api/index.test.ts`             |
| api types            | Type-level tests with expectTypeOf       | `api/index.test.ts`             |
| api unavailable      | Throws if window.api undefined           | `api/index.test.ts`             |
| projects init        | Initializes with empty state             | `stores/projects.test.ts`       |
| projects add         | Adding project updates state (immutable) | `stores/projects.test.ts`       |
| projects remove      | Removing updates state and active        | `stores/projects.test.ts`       |
| projects derived     | activeProject, flatWorkspaceList work    | `stores/projects.test.ts`       |
| projects error       | setError stores message                  | `stores/projects.test.ts`       |
| projects cleanup     | Event subs cleaned up on unmount         | `stores/projects.test.ts`       |
| dialogs init         | Initializes with type 'closed'           | `stores/dialogs.test.ts`        |
| dialogs open         | Opening sets correct state               | `stores/dialogs.test.ts`        |
| dialogs exclusive    | Only one dialog at a time                | `stores/dialogs.test.ts`        |
| dialogs trigger      | Stores and retrieves trigger element ID  | `stores/dialogs.test.ts`        |
| focus trap           | Tab cycles within container              | `utils/focus-trap.test.ts`      |
| name valid empty     | Empty name invalid                       | `CreateWorkspaceDialog.test.ts` |
| name valid chars     | Path separators rejected                 | `CreateWorkspaceDialog.test.ts` |
| name valid dotdot    | '..' sequences rejected                  | `CreateWorkspaceDialog.test.ts` |
| name valid length    | > 100 chars rejected                     | `CreateWorkspaceDialog.test.ts` |
| name valid dup       | Duplicate rejected (case-insensitive)    | `CreateWorkspaceDialog.test.ts` |

### Component Tests (@testing-library/svelte)

| Test Case               | Description                              | File                            |
| ----------------------- | ---------------------------------------- | ------------------------------- |
| Dialog render           | Has role, aria-modal, aria-labelledby    | `Dialog.test.ts`                |
| Dialog escape           | Escape calls onClose                     | `Dialog.test.ts`                |
| Dialog overlay          | Click outside closes                     | `Dialog.test.ts`                |
| Dialog focus trap       | Tab cycles within                        | `Dialog.test.ts`                |
| Dialog focus return     | Returns to trigger on close              | `Dialog.test.ts`                |
| Dialog aria-busy        | Set during async                         | `Dialog.test.ts`                |
| EmptyState render       | Shows message and button                 | `EmptyState.test.ts`            |
| Sidebar loading         | Shows loading state                      | `Sidebar.test.ts`               |
| Sidebar empty           | Shows empty state                        | `Sidebar.test.ts`               |
| Sidebar error           | Shows error state with message           | `Sidebar.test.ts`               |
| Sidebar semantic        | Uses nav, ul, li                         | `Sidebar.test.ts`               |
| Sidebar active          | aria-current on active                   | `Sidebar.test.ts`               |
| Sidebar buttons         | Action buttons accessible, have IDs      | `Sidebar.test.ts`               |
| Sidebar tooltip         | Branch names >30 chars have title attr   | `Sidebar.test.ts`               |
| Sidebar error handling  | API errors don't corrupt state           | `Sidebar.test.ts`               |
| BranchDropdown combobox | Has correct ARIA                         | `BranchDropdown.test.ts`        |
| BranchDropdown load     | Calls api.listBases on mount             | `BranchDropdown.test.ts`        |
| BranchDropdown debounce | Filter applies after 200ms (fake timers) | `BranchDropdown.test.ts`        |
| BranchDropdown nav      | Arrow keys work                          | `BranchDropdown.test.ts`        |
| BranchDropdown select   | Enter/Tab selects                        | `BranchDropdown.test.ts`        |
| BranchDropdown empty    | Shows "No branches found"                | `BranchDropdown.test.ts`        |
| BranchDropdown error    | Handles listBases error gracefully       | `BranchDropdown.test.ts`        |
| CreateDialog a11y       | All ARIA attributes present              | `CreateWorkspaceDialog.test.ts` |
| CreateDialog validation | Shows errors with aria-describedby       | `CreateWorkspaceDialog.test.ts` |
| CreateDialog duplicate  | Validates against projects store         | `CreateWorkspaceDialog.test.ts` |
| CreateDialog submit     | Spinner, aria-busy, aria-live announce   | `CreateWorkspaceDialog.test.ts` |
| CreateDialog error      | API error shows in role="alert"          | `CreateWorkspaceDialog.test.ts` |
| RemoveDialog a11y       | All ARIA attributes present              | `RemoveWorkspaceDialog.test.ts` |
| RemoveDialog checkbox   | Default checked, toggles                 | `RemoveWorkspaceDialog.test.ts` |
| RemoveDialog dirty      | Calls isWorkspaceDirty, shows warning    | `RemoveWorkspaceDialog.test.ts` |
| RemoveDialog submit     | Correct deleteBranch value               | `RemoveWorkspaceDialog.test.ts` |
| RemoveDialog error      | API error shows in role="alert"          | `RemoveWorkspaceDialog.test.ts` |

### Integration Tests

| Test Case                 | Description                               | File                  |
| ------------------------- | ----------------------------------------- | --------------------- |
| open project flow         | selectFolder → openProject → UI update    | `integration.test.ts` |
| close project flow        | click [×] → closeProject → UI update      | `integration.test.ts` |
| create workspace flow     | dialog → submit → workspace:created → UI  | `integration.test.ts` |
| remove workspace flow     | dialog → confirm → workspace:removed → UI | `integration.test.ts` |
| switch workspace flow     | click → workspace:switched → aria-current | `integration.test.ts` |
| user cancel               | selectFolder returns null → no action     | `integration.test.ts` |
| error recovery            | API error shows message, state intact     | `integration.test.ts` |
| rapid clicks              | 5 clicks in 100ms → correct final state   | `integration.test.ts` |
| dialog close during async | operation completes, UI updates later     | `integration.test.ts` |
| state consistency         | store matches UI at all times             | `integration.test.ts` |

### Coverage Thresholds

```typescript
// vitest.config.ts - add this configuration
coverage: {
  provider: 'v8',
  reporter: ['text', 'html', 'lcov'],
  include: ['src/renderer/**/*.ts', 'src/renderer/**/*.svelte'],
  exclude: ['**/*.test.ts', '**/test-*.ts'],
  thresholds: {
    lines: 80,
    branches: 80,  // Increased from 75% - achievable with TDD
    functions: 80,
    statements: 80,
  }
}
```

**Note**: Coverage configuration must be added to `vitest.config.ts` in Step 1.3 before writing tests.

### Manual Testing Checklist

- [ ] Open project via folder picker
- [ ] Project appears in sidebar with correct name
- [ ] Workspaces appear under project with branch names
- [ ] Long branch names show tooltip on hover
- [ ] Click workspace switches active (highlighted, aria-current)
- [ ] Hover project shows [+] and [×] buttons
- [ ] Hover workspace shows [×] button
- [ ] Tab navigates through sidebar items
- [ ] Create workspace dialog opens on [+] click
- [ ] Create dialog: Tab navigates between fields correctly
- [ ] Create dialog: Name validation shows accessible errors
- [ ] Create dialog: Branch dropdown filters on typing (debounced)
- [ ] Create dialog: Arrow keys navigate branch list
- [ ] Create dialog: Enter/Tab selects branch
- [ ] Create dialog: Empty filter shows "No branches found"
- [ ] Create dialog: Enter submits when valid
- [ ] Create dialog: Escape closes
- [ ] Create dialog: OK shows spinner during creation
- [ ] Create dialog: Screen reader announces "Creating workspace..."
- [ ] Create workspace succeeds and appears in sidebar
- [ ] Remove workspace dialog opens on workspace [×] click
- [ ] Remove dialog: Shows dirty warning (if applicable)
- [ ] Remove dialog: "Delete branch" checkbox checked by default
- [ ] Remove dialog: Space toggles checkbox
- [ ] Remove dialog: Tab navigates between elements
- [ ] Remove dialog: Enter activates focused button
- [ ] Remove dialog: Escape closes
- [ ] Remove dialog: OK shows spinner on click
- [ ] Remove workspace works (with and without delete branch)
- [ ] Close project removes from sidebar (no confirmation)
- [ ] Empty state shows when no projects
- [ ] Loading state shows on initial load
- [ ] Focus returns to trigger element after dialog closes
- [ ] All keyboard navigation works without mouse
- [ ] Screen reader announces dialog content properly

## Dependencies

| Package | Purpose                                 | Approved |
| ------- | --------------------------------------- | -------- |
| (none)  | All required packages already installed | N/A      |

**Note**: The project already has `@vscode-elements/elements`, `@vscode/codicons`, `svelte`, and `@testing-library/svelte` installed.

## Documentation Updates

### Files to Update

| File                           | Changes Required                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`         | Update Frontend Components table (lines 163-169) with: Sidebar, Dialog, EmptyState, CreateWorkspaceDialog, RemoveWorkspaceDialog, BranchDropdown. Format: Component \| Purpose                                                                                                                                                                                            |
| `docs/USER_INTERFACE.md`       | Add implementation note: "UI layer implemented as of Phase 4. Remove Workspace dialog uses Cancel/OK with checkbox (differs from original three-button spec)."                                                                                                                                                                                                            |
| `AGENTS.md`                    | Add new "Renderer Architecture" section after "Project Structure" with: (1) Directory structure: `lib/components`, `lib/stores`, `lib/api`, `lib/utils`, `lib/styles` (2) Patterns: Always import from `$lib/api` not `window.api`; Use Svelte 5 runes (`$state`, `$derived`, `$effect`); Mock `$lib/api` in tests (3) Note: `window.electronAPI` renamed to `window.api` |
| `src/shared/electron-api.d.ts` | Rename interface and global (breaking change documented in Step 3)                                                                                                                                                                                                                                                                                                        |

### New Documentation Required

| File   | Purpose                                            |
| ------ | -------------------------------------------------- |
| (none) | Component usage is self-documenting via TypeScript |

## Definition of Done

- [ ] All implementation steps complete (test-first!)
- [ ] `pnpm validate:fix` passes
- [ ] All unit tests pass (including test utilities tests)
- [ ] All component tests pass (including accessibility assertions)
- [ ] Integration tests pass
- [ ] Coverage thresholds met (80% all metrics)
- [ ] Manual testing checklist complete
- [ ] Documentation updated (ARCHITECTURE.md, USER_INTERFACE.md, AGENTS.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
