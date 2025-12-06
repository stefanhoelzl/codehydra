# CodeHydra Electron Migration Plan

## Overview

Migrate CodeHydra from Tauri to Electron to replace iframe-based code-server embedding with native `WebContentsView` components, solving keyboard capture, focus management, and z-ordering issues.

**Reference Implementations**:

- `../codehydra-tauri` - Current Tauri implementation (source of business logic and UI)
- `../demo` - Electron PoC demonstrating WebContentsView-based embedding solution

---

## Key Decisions

| Decision         | Choice                                                         |
| ---------------- | -------------------------------------------------------------- |
| Backend          | Node.js (port from Rust in `codehydra-tauri/src-tauri/`)       |
| Node.js runtime  | Use Electron's bundled Node.js for code-server                 |
| UI framework     | Svelte 5 + @vscode-elements (as in Tauri version)              |
| Platform support | Linux, macOS, Windows (all from start)                         |
| OpenCode         | Discover externally-running instances (spawned by code-server) |
| Bundling         | code-server + extensions bundled at build time                 |
| Testing          | Unit + Integration first, E2E later                            |
| Linting          | Strict mode (all warnings = errors)                            |
| Phases           | Sequential execution                                           |

---

## Development Workflow (Applies to All Phases)

### Code Quality Standards

| Rule       | Enforcement                                       |
| ---------- | ------------------------------------------------- |
| TypeScript | Strict mode, no `any`, no implicit types          |
| ESLint     | All warnings treated as errors                    |
| Prettier   | Enforced formatting, checked in CI                |
| Tests      | TDD approach: failing test → implement → refactor |

### Dependency Management

- **Always use `npm install <package>`** to add dependencies (ensures latest versions)
- **Never directly edit package.json** for dependencies
- **Agent rule**: Ask user before adding any new dependency

### Implementation Approach

- **TDD**: Write failing test first, then implement, then refactor
- **Libraries over shell**: Use Node.js libraries instead of spawning shell commands
- **Agent rule**: Ask user before deviating from the agreed phase plan

### Reference Usage

- Tauri business logic in `codehydra-tauri/src-tauri/src/` → Port to TypeScript
- Tauri frontend in `codehydra-tauri/src/` → Adapt for Electron IPC
- Electron patterns from `demo/main.js` → WebContentsView management

---

## Phase Overview

```
Phase 0: Documentation
    ↓
Phase 1: Project Setup
    ↓
Phase 2: App Services (Git, Code-Server, Project Management)
    ↓
Phase 3: Electron Backend (IPC, View Management)
    ↓
Phase 4: UI Layer
    ↓
Phase 5: Keyboard & Focus
    ↓
Phase 6: Agent Integration
    ↓
Phase 7: Packaging & Distribution
```

---

## Phase Summaries

### Phase 0: Documentation

**Goal**: Establish project foundation for AI agents and developers

**Deliverables**:

- `AGENTS.md` - Project overview for AI agents starting work on the project
- `docs/ARCHITECTURE.md` - System architecture and component relationships
- `docs/USER_FLOWS.md` - User workflows and interactions
- `docs/UI_MOCKUPS.md` - ASCII wireframes and behavior descriptions

**Scope**: Documents describe the **target application** (what we're building), not the migration process. This is a new application specification.

---

### Phase 1: Project Setup

**Goal**: Initialize project with strict tooling and minimal Electron shell

**Deliverables**:

- npm project structure
- TypeScript configuration (strict mode)
- ESLint configuration (warnings = errors)
- Prettier configuration
- Vitest configuration for unit/integration tests
- Basic Electron main process (empty BaseWindow)
- Development scripts (`dev`, `build`, `test`, `lint`)

**Reference**: Build tooling patterns from `codehydra-tauri/package.json`

---

### Phase 2: App Services

**Goal**: Implement core business logic services in Node.js

**Services** (ported from `codehydra-tauri/src-tauri/src/`):

| Service               | Tauri Source               | Responsibility                                          |
| --------------------- | -------------------------- | ------------------------------------------------------- |
| Code-server manager   | `code_server.rs`           | Start/stop code-server, port management, URL generation |
| Git worktree provider | `git_worktree_provider.rs` | Discover, create, remove worktrees, branch operations   |
| Project store         | `project_store.rs`         | Persist open projects across sessions                   |

**Note**: These services are pure Node.js with no Electron dependencies. Library choices (git library, etc.) will be discussed when planning this phase in detail.

---

### Phase 3: Electron Backend

**Goal**: Implement Electron main process with WebContentsView architecture

**Components** (patterns from `demo/main.js`):

| Component       | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| Window manager  | BaseWindow creation, resize handling                                 |
| View manager    | Create/destroy WebContentsViews, bounds calculation, z-order         |
| IPC handlers    | Bridge between renderer and app services (IPC contract defined here) |
| Preload scripts | `preload.ts` (UI layer), `webview-preload.ts` (code-server views)    |

**Key Behaviors**:

- UI layer as transparent WebContentsView (sidebar visible, rest transparent)
- Workspace views hidden via zero-bounds (preserves VS Code state)
- Z-order control via add/remove child views

---

### Phase 4: UI Layer

**Goal**: Implement Svelte frontend with @vscode-elements

**Components** (adapted from `codehydra-tauri/src/lib/components/`):

| Component     | Tauri Source                   | Responsibility                                  |
| ------------- | ------------------------------ | ----------------------------------------------- |
| Sidebar       | `Sidebar.svelte`               | Project list, workspace list, status indicators |
| Create dialog | `CreateWorkspaceDialog.svelte` | New workspace form                              |
| Remove dialog | `RemoveWorkspaceDialog.svelte` | Confirmation with options                       |
| Setup modal   | `SetupModal.svelte`            | First-run experience (if needed)                |
| Empty states  | `WorkspaceView.svelte`         | No project, loading, error states               |

**Key Changes from Tauri**:

- Remove iframe management (handled by Electron main process)
- Replace Tauri API calls (`$lib/api/tauri.ts`) with Electron IPC (`$lib/api/electron.ts`)
- Stores communicate via IPC events instead of Tauri event listeners

---

### Phase 5: Keyboard & Focus

**Goal**: Implement keyboard navigation that works inside code-server

**Components** (patterns from `demo/main.js` and `demo/webview-preload.js`):

| Component        | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| Global shortcuts | OS-level shortcuts via Electron `globalShortcut`            |
| Webview preload  | Capture-phase keyboard interception before VS Code handlers |
| Focus manager    | Transfer focus between UI layer and workspace views         |
| Shortcut overlay | Visual indicator of available shortcuts                     |

**Key Behaviors** (from `codehydra-tauri/docs/KEYBOARD_NAVIGATION.md`):

- Alt+X (hold): Activate shortcut mode, show overlay
- Alt+{1-9,0}: Jump to workspace by index
- Alt+Arrow: Navigate workspace list
- Alt+Enter: Create workspace
- Alt+Delete: Remove workspace
- Release Alt+X: Deactivate, return focus to editor

---

### Phase 6: Agent Integration

**Goal**: Monitor and display OpenCode agent status

**Components** (ported from `codehydra-tauri/src-tauri/src/opencode/`):

| Component         | Tauri Source              | Responsibility                       |
| ----------------- | ------------------------- | ------------------------------------ |
| Discovery service | `discovery.rs`            | Port scanning for OpenCode instances |
| SSE client        | `client.rs`               | Connect to OpenCode status endpoints |
| Status provider   | `provider.rs`             | Map OpenCode instances to workspaces |
| Status manager    | `agent_status_manager.rs` | Aggregate status, broadcast changes  |

**Key Behaviors**:

- Scan for OpenCode instances running as children of code-server
- Connect via SSE to receive real-time status updates
- Display status indicators in sidebar (idle/working/error)

---

### Phase 7: Packaging & Distribution

**Goal**: Create distributable app bundles for all platforms

**Components**:

| Component           | Responsibility                                            |
| ------------------- | --------------------------------------------------------- |
| Build config        | electron-builder configuration                            |
| Bundled code-server | code-server binary using Electron's Node.js               |
| Bundled extensions  | Pre-installed VS Code extensions                          |
| Platform builds     | Linux (AppImage/deb), macOS (dmg), Windows (exe/msi)      |
| External links      | Open URLs in system browser (pattern from `demo/main.js`) |

**Build-time Bundling**:

- code-server downloaded/built during package step
- Extensions installed into bundled code-server
- No runtime bootstrapping needed (unlike Tauri version)

---

## User Workflows

| Workflow            | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| First Launch        | Open app → Empty state → Open project → Workspaces discovered         |
| Workspace Switching | Click sidebar or keyboard shortcut → Instant switch (state preserved) |
| Create Workspace    | Dialog → Select branch → New worktree created → Opens in view         |
| Remove Workspace    | Confirmation → Optional branch deletion → View removed                |
| Agent Monitoring    | OpenCode runs in terminal → Status indicator updates in real-time     |
| Keyboard Navigation | Hold Alt+X → See overlay → Press shortcut → Action executed           |
