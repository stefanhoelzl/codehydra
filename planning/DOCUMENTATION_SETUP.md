---
status: COMPLETE
last_updated: 2025-01-06
reviewers: []
---

# DOCUMENTATION_SETUP

## Overview

- **Problem**: CodeHydra needs foundational documentation for AI agents and developers to understand the target Electron application architecture, user flows, and quality standards.
- **Solution**: Create high-level documentation that describes the target application (not migration process). Documents will evolve as features are built.
- **Risks**:
  - Documentation may become stale as implementation progresses → Mitigate by updating docs during each phase
  - Over-documenting upfront → Mitigate by keeping docs high-level, expanding during implementation
- **Alternatives Considered**:
  - Comprehensive docs upfront (rejected: delays Phase 1, docs may change)
  - No docs until after implementation (rejected: agents need context to contribute)

## Architecture

```
codehydra/
├── AGENTS.md                      # AI agent onboarding, quality standards
├── docs/
│   ├── ARCHITECTURE.md            # System design, WebContentsView patterns
│   └── USER_INTERFACE.md          # User flows, UI mockups, keyboard navigation
└── planning/
    ├── ELECTRON_MIGRATION.md      # Migration master plan (existing)
    └── DOCUMENTATION_SETUP.md     # This plan
```

### Key Architecture Decisions

| Decision            | Choice                                  | Rationale                          |
| ------------------- | --------------------------------------- | ---------------------------------- |
| Project concept     | Git repo path (container, not viewable) | Simplifies worktree handling       |
| Workspace concept   | Git worktree (all equal, no "main")     | No special cases                   |
| Worktree discovery  | Find in ANY location                    | Support manually created worktrees |
| Worktree creation   | Only in managed location                | Consistent, predictable paths      |
| Empty project       | Auto-open create dialog                 | Clear UX for new projects          |
| Keyboard navigation | Spans all projects                      | Simple mental model                |
| Package manager     | pnpm                                    | Project standard                   |
| Ignore comments     | Never without approval                  | Strict code quality                |

### Managed Worktree Location

```
~/.local/share/codehydra/
└── projects/
    └── <project-name>-<8-char-hash>/
        └── workspaces/
            ├── feature-auth/    ← git worktree
            └── bugfix-123/      ← git worktree
```

## Implementation Steps

- [ ] **Step 1: Create docs directory**
  - Create `docs/` directory at project root
  - Files affected: none (new directory)
  - Test criteria: Directory exists

- [ ] **Step 2: Create AGENTS.md**
  - Create AI agent onboarding document at project root
  - Content: Project overview, tech stack, quality standards, critical rules
  - Files affected: `AGENTS.md` (new)
  - Test criteria: File exists, covers all required sections

- [ ] **Step 3: Create docs/ARCHITECTURE.md**
  - Create system architecture document
  - Content: System overview, WebContentsView patterns, components, data flow
  - Files affected: `docs/ARCHITECTURE.md` (new)
  - Test criteria: File exists, ASCII diagrams readable

- [ ] **Step 4: Create docs/USER_INTERFACE.md**
  - Create combined user flows and UI mockups document
  - Content: Application layout, user flows, keyboard navigation, mockups
  - Files affected: `docs/USER_INTERFACE.md` (new)
  - Test criteria: File exists, all flows documented

## Testing Strategy

### Manual Verification

| Check             | Criteria                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| AGENTS.md         | Covers: overview, tech stack, quality standards, pnpm, no-ignore rule     |
| ARCHITECTURE.md   | Covers: system diagram, project/workspace concepts, components, data flow |
| USER_INTERFACE.md | Covers: layout mockup, all user flows, keyboard shortcuts, UI states      |
| Consistency       | No references to codehydra-tauri or demo                                  |
| Accuracy          | Architecture matches key decisions table above                            |

## Dependencies

No new dependencies required for documentation.

## Documentation Updates

### New Documentation Required

| File                     | Purpose                                   |
| ------------------------ | ----------------------------------------- |
| `AGENTS.md`              | AI agent onboarding and quality standards |
| `docs/ARCHITECTURE.md`   | System architecture and component design  |
| `docs/USER_INTERFACE.md` | User flows, mockups, keyboard navigation  |

## Definition of Done

- [ ] `docs/` directory created
- [ ] `AGENTS.md` created at project root
- [ ] `docs/ARCHITECTURE.md` created
- [ ] `docs/USER_INTERFACE.md` created
- [ ] All docs use pnpm (not npm)
- [ ] No references to codehydra-tauri or demo
- [ ] Architecture reflects: discover anywhere, create in managed location
- [ ] Project = container (not viewable), Workspace = worktree (viewable)
- [ ] Keyboard navigation documented as cross-project
- [ ] No-ignore-comments policy documented in AGENTS.md

---

## Document Content Specifications

### AGENTS.md Content

```markdown
# CodeHydra - AI Agent Instructions

## Project Overview

- Multi-workspace IDE for parallel AI agent development
- Each workspace = git worktree in isolated WebContentsView with VS Code (code-server)
- Real-time OpenCode agent status monitoring

## Tech Stack

| Layer           | Technology                               |
| --------------- | ---------------------------------------- |
| Desktop         | Electron (BaseWindow + WebContentsViews) |
| Frontend        | Svelte 5 + TypeScript + @vscode-elements |
| Backend         | Node.js services                         |
| Testing         | Vitest                                   |
| Build           | Vite                                     |
| Package Manager | pnpm                                     |

## Key Concepts

| Concept         | Description                                   |
| --------------- | --------------------------------------------- |
| Project         | Git repository path (container, not viewable) |
| Workspace       | Git worktree (viewable in code-server)        |
| WebContentsView | Electron view for embedding (not iframe)      |

## Development Workflow

- TDD: failing test → implement → refactor
- Scripts: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`
- Use `pnpm add <package>` for dependencies (never edit package.json manually)

## Code Quality Standards

- TypeScript strict mode, no `any`, no implicit types
- ESLint warnings treated as errors
- Prettier enforced formatting
- All tests must pass

## CRITICAL: No Ignore Comments

**NEVER add without explicit user approval:**

- `// @ts-ignore`, `// @ts-expect-error`
- `// eslint-disable`, `// eslint-disable-next-line`
- `any` type assertions
- Modifications to `.eslintignore`, `.prettierignore`

**Process if exception needed:**

1. Explain why the exception is necessary
2. Wait for explicit user approval
3. Only then add with explanatory comment

## Validation Commands

| Check      | Command           | Requirement   |
| ---------- | ----------------- | ------------- |
| TypeScript | pnpm check        | Zero errors   |
| ESLint     | pnpm lint         | Zero errors   |
| Prettier   | pnpm format:check | All formatted |
| Tests      | pnpm test         | All passing   |
| Build      | pnpm build        | Completes     |

Run all checks before marking any task complete.
```

### docs/ARCHITECTURE.md Content

```markdown
# CodeHydra Architecture

## System Overview

┌─────────────────────────────────────────────────────────────────────────┐
│ CodeHydra Application │
├─────────────────────────────────────────────────────────────────────────┤
│ Main Process (Electron) │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────────────────┐ │
│ │ Window Manager │ │ View Manager │ │ App Services │ │
│ │ BaseWindow │ │ WebContentsView│ │ ├─ Git Worktree Provider │ │
│ │ resize/bounds │ │ create/destroy │ │ ├─ Code-Server Manager │ │
│ │ │ │ z-order │ │ ├─ Project Store │ │
│ └────────────────┘ └────────────────┘ │ └─ OpenCode Discovery │ │
│ └────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────┤
│ UI Layer (transparent WebContentsView) │
│ Sidebar, Dialogs, Keyboard Overlay │
├─────────────────────────────────────────────────────────────────────────┤
│ Workspace Views (code-server WebContentsViews) │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│ │ Workspace 1 │ │ Workspace 2 │ │ Workspace 3 │ │
│ │ (visible) │ │ (hidden) │ │ (hidden) │ │
│ └──────────────┘ └──────────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘

## Core Concepts

### Project vs Workspace

| Concept   | What it is          | Viewable          | Actions              |
| --------- | ------------------- | ----------------- | -------------------- |
| Project   | Git repository path | No                | Close, Add workspace |
| Workspace | Git worktree        | Yes (code-server) | Select, Remove       |

**Key behavior:**

- Projects are containers, not viewable
- All workspaces are equal (no "main" worktree concept)
- Worktrees discovered in ANY location
- New worktrees created only in managed location

### Worktree Storage

Managed location for created worktrees:
```

~/.local/share/codehydra/
└── projects/
└── <project-name>-<8-char-hash>/
└── workspaces/
├── feature-auth/ ← git worktree
└── bugfix-123/ ← git worktree

```

Discovery also finds worktrees in other locations (e.g., manually created).

## WebContentsView Architecture

### Why WebContentsView (not iframe)
- Full keyboard event capture (VS Code shortcuts work)
- Proper z-ordering control
- Focus management between views
- No cross-origin restrictions

### View Management
- **Create**: When workspace added
- **Destroy**: When workspace removed
- **Show**: Set bounds to visible area, add as child view
- **Hide**: Set bounds to zero (preserves VS Code state, no reload)
- **Z-order**: Controlled via add/remove child view order

## Component Architecture

### Main Process Components

| Component | Responsibility |
|-----------|----------------|
| Window Manager | BaseWindow lifecycle, resize handling |
| View Manager | WebContentsView create/destroy, bounds, z-order |
| IPC Handlers | Bridge between renderer and services |
| Preload Scripts | Secure IPC exposure to renderers |

### App Services (pure Node.js, no Electron deps)

| Service | Responsibility |
|---------|----------------|
| Git Worktree Provider | Discover, create, remove worktrees |
| Code-Server Manager | Start/stop code-server, port management |
| Project Store | Persist open projects across sessions |
| OpenCode Discovery | Find running OpenCode instances |
| OpenCode Status Provider | SSE connections, status aggregation |

### Frontend Components (Svelte 5)

| Component | Purpose |
|-----------|---------|
| Sidebar | Project list, workspace list, status indicators |
| CreateWorkspaceDialog | New workspace form |
| RemoveWorkspaceDialog | Confirmation with options |
| KeyboardOverlay | Shortcut hints when active |
| Stores | projects, activeWorkspace, agentStatus, keyboardNavigation |

## OpenCode Integration

### Discovery
- Scan for OpenCode status server instances
- Match instances to workspaces via process tree / port mapping
- Runs periodically in background

### Status Updates
- SSE connection to each discovered instance
- Real-time status: idle, working, error
- Broadcast changes to frontend via IPC events

## Data Flow

### Opening a Project
```

User: Click "Open Project"
→ System folder picker
→ Validate: is git repository?
→ Git Worktree Provider: discover existing worktrees
→ Project Store: save project
→ If 0 worktrees: auto-open create dialog
→ If 1+ worktrees: activate first workspace

```

### Switching Workspaces
```

User: Click workspace (or keyboard shortcut)
→ IPC: switch-workspace
→ View Manager: hide current (zero bounds)
→ View Manager: show target (full bounds)
→ View Manager: bring to front (z-order)
→ Store: update activeWorkspace
→ Focus: code-server view

```

### Creating a Workspace
```

User: Click [+], fill dialog, click OK
→ IPC: create-workspace
→ Git Worktree Provider: create in managed location
→ Code-Server Manager: get URL
→ View Manager: create WebContentsView
→ Store: add workspace, set active

```

## IPC Contract

### Commands (renderer → main)
[Placeholder - to be defined in Phase 3]

### Events (main → renderer)
[Placeholder - to be defined in Phase 3]
```

### docs/USER_INTERFACE.md Content

```markdown
# CodeHydra User Interface

## Application Layout

┌─────────────────────────────────────────────────────────────────────────────────┐
│ CODEHYDRA │
├────────────────────────┬────────────────────────────────────────────────────────┤
│ │ │
│ PROJECTS │ │
│ │ │
│ 📁 my-project [+][×]│ │
│ └─ 🌿 feature (feat)│ VS CODE (code-server) │
│ └─ 🌿 bugfix (fix) │ │
│ │ Active workspace view │
│ 📁 other-proj [+][×]│ │
│ └─ 🌿 experiment │ │
│ │ │
│ [Open Project] │ │
│ │ │
└────────────────────────┴────────────────────────────────────────────────────────┘

## UI Elements

### Project Row (container, NOT selectable)
```

┌────────────────────────────────┐
│ 📁 project-name [+][×] │
└────────────────────────────────┘

```

| Element | Behavior |
|---------|----------|
| Row click | Nothing (not selectable) |
| [+] button | Opens create workspace dialog |
| [×] button | Closes project (removes from sidebar only, NO file deletion) |

### Workspace Row (selectable)

```

┌────────────────────────────────┐
│ └─ 🌿 name (branch) [×] │
└────────────────────────────────┘

```

| Element | Behavior |
|---------|----------|
| Row click | Activates workspace, shows in code-server view |
| Branch name | Shows git branch in parentheses |
| [×] button | Opens remove workspace dialog |
| Status indicator | Shows OpenCode agent status (if running) |

## User Flows

### First Launch

```

┌────────────────────────┐
│ PROJECTS │
│ │
│ No projects open. │
│ │
│ [Open Project] │
└────────────────────────┘

```

User sees empty state with "Open Project" button.

### Opening a Project

**Flow:**
1. Click "Open Project" button
2. System folder picker opens
3. Select folder containing git repository
4. Project added to sidebar
5. Worktree discovery runs (checks all locations)
6. **If 0 worktrees found**: Create workspace dialog auto-opens
7. **If 1+ worktrees found**: First workspace activated

**Empty project (auto-opens create dialog):**
```

┌────────────────────────┐ ┌──────────────────────────────────┐
│ PROJECTS │ │ Create Workspace │
│ │ │ │
│ 📁 new-project [+][×]│ + │ Name: [________________] │
│ (no workspaces) │ │ Branch: [main________▼] │
│ │ │ │
│ [Open Project] │ │ [Cancel] [OK] │
└────────────────────────┘ └──────────────────────────────────┘

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
│ 📁 my-project [+][×] │ ← [×] visible on hover
│ └─ 🌿 feature [×] │
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

│ 📁 my-project [+][×] │
│ └─ 🌿 feature (feat) [×] │ ← Normal
│ └─ 🌿 bugfix (fix) [×] │ ← ACTIVE (highlighted)

```

### Creating a Workspace

**Flow:**
1. Click [+] on project row
2. Create dialog opens
3. Enter workspace name (validated in real-time)
4. Select base branch from dropdown
5. Click OK
6. Git worktree created in managed location
7. New workspace becomes active

**Dialog states:**

Initial (loading branches):
```

┌──────────────────────────────────────────┐
│ Create Workspace │
│ │
│ Name │
│ [________________________________] │
│ │
│ Base Branch [◐] │ ← Spinner
│ [main_____________________________▼] │
│ │
│ [Cancel] [OK] │
│ ~~~~ │ ← Disabled
└──────────────────────────────────────────┘

```

Validation error:
```

│ Name │
│ [-invalid____________________________] │ ← Red border
│ ⚠ Must start with letter or number │

```

Valid state:
```

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

### Removing a Workspace

**Flow:**
1. Hover workspace row → [×] button becomes visible (branch name stays visible)
2. Click [×]
3. Confirmation dialog opens
4. If uncommitted changes → warning shown
5. Choose action:
   - **Cancel**: Close dialog, no action
   - **Keep Branch**: Remove worktree, keep git branch
   - **Delete**: Remove worktree AND delete git branch
6. On confirm: workspace removed
7. If was active → switch to another workspace in same project
8. If last workspace in project → project remains (can create new)

**Hover state (branch stays visible):**
```

│ └─ 🌿 feature (feat) [×] │ ← [×] appears, branch visible

```

**Confirmation dialog (clean):**
```

┌────────────────────────────────────────────┐
│ Remove Workspace │
│ │
│ Remove workspace "feature-auth"? │
│ │
│ [Cancel] [Keep Branch] [Delete] │
│ ~~~~~~~~ │ ← Red/destructive
└────────────────────────────────────────────┘

```

**Confirmation dialog (uncommitted changes):**
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
│ [Cancel] [Keep Branch] [Delete] │
└────────────────────────────────────────────┘

```

### Agent Status Monitoring

**Flow:**
- User runs OpenCode in VS Code terminal (within a workspace)
- CodeHydra discovers running OpenCode instance
- Status indicator appears next to workspace in sidebar
- Status updates in real-time

**Status indicators:**
| Status | Indicator | Meaning |
|--------|-----------|---------|
| Idle | 🟢 | Agent waiting for input |
| Working | 🟡 | Agent actively processing |
| Error | 🔴 | Agent encountered error |

**Sidebar with status:**
```

│ 📁 my-project [+][×] │
│ └─ 🌿 feature (feat) 🟢 [×] │ ← Idle
│ └─ 🌿 bugfix (fix) 🟡 [×] │ ← Working

```

## Keyboard Navigation

### Activation

Press and hold `Alt`, then press `X` to enter shortcut mode.

### Shortcuts (while Alt held after Alt+X)

| Shortcut | Action |
|----------|--------|
| Alt+X | Activate shortcut mode |
| Alt+↑ | Previous workspace (across all projects) |
| Alt+↓ | Next workspace (across all projects) |
| Alt+Enter | Create workspace (current project context) |
| Alt+Delete | Remove current workspace |
| Alt+Backspace | Remove current workspace |
| Alt+1 to Alt+9 | Jump to workspace 1-9 |
| Alt+0 | Jump to workspace 10 |

### Behavior Details

**Activation:**
- Press Alt+X to activate shortcut mode
- Overlay appears at bottom center
- Workspace index numbers appear in sidebar
- Actions only work while shortcut mode is active

**Navigation:**
- Alt+↑/↓ moves through ALL workspaces across ALL projects
- Navigation order: top to bottom as shown in sidebar
- Wraps: last workspace → first workspace (and vice versa)

**Deactivation:**
- Release Alt key → deactivate
- Press Escape → deactivate
- Window loses focus → deactivate
- Focus returns to VS Code editor after deactivation

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
│ └─ 1 🌿 feature-auth [×] │ ← Index numbers
│ └─ 2 🌿 bugfix-123 [×] │
│ 📁 other-project [+][×] │
│ └─ 3 🌿 experiment [×] │

```

**Overlay (bottom center):**
```

┌─────────────────────────────────────────┐
│ ↑↓ Navigate ⏎ New ⌫ Del 1-0 Jump │
└─────────────────────────────────────────┘

```

### Dialog Shortcuts

| Key | Action |
|-----|--------|
| Enter | Confirm / OK |
| Escape | Cancel / Close |
| Tab | Navigate between fields |

## UI States

### Empty State (no projects)
```

┌────────────────────────┐
│ PROJECTS │
│ │
│ No projects open. │
│ │
│ [Open Project] │
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
