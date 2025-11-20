# Chime Architecture

**Document Version:** 1.0  
**Last Updated:** 2025-11-20

This document describes the architecture of the Chime WorkspaceProvider system.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Architecture](#component-architecture)
3. [Data Flow](#data-flow)
4. [WorkspaceProvider Design](#workspaceprovider-design)
5. [State Management](#state-management)
6. [Type System](#type-system)
7. [Error Handling](#error-handling)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Chime Application                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌────────────────────────────┐         ┌────────────────────────────┐ │
│  │   Svelte Frontend (UI)     │   IPC   │   Rust Backend (Tauri)    │ │
│  │                            │◄────────►│                            │ │
│  │  - Project List            │         │  ┌──────────────────────┐  │ │
│  │  - Workspace List          │         │  │   AppState           │  │ │
│  │  - VSCode Iframe           │         │  │                      │  │ │
│  │                            │         │  │ HashMap<Uuid,        │  │ │
│  │  Stores:                   │         │  │   ProjectContext>    │  │ │
│  │  - projects                │         │  └──────────┬───────────┘  │ │
│  │  - workspaces              │         │             │              │ │
│  └────────────────────────────┘         │             │              │ │
│                                         │             │              │ │
│                                         │             ▼              │ │
│                                         │  ┌──────────────────────┐  │ │
│                                         │  │ WorkspaceProvider    │  │ │
│                                         │  │    (Trait)           │  │ │
│                                         │  │                      │  │ │
│                                         │  │ • new()              │  │ │
│                                         │  │ • discover()         │  │ │
│                                         │  └──────────┬───────────┘  │ │
│                                         │             │              │ │
│                                         │             │ impl by      │ │
│                                         │             ▼              │ │
│                                         │  ┌──────────────────────┐  │ │
│                                         │  │ GitWorktreeProvider  │  │ │
│                                         │  │                      │  │ │
│                                         │  │ Uses: git2 library   │  │ │
│                                         │  └──────────────────────┘  │ │
│                                         └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │ Manages
                                              ▼
                    ┌─────────────────────────────────────────┐
                    │         Filesystem Layer                │
                    ├─────────────────────────────────────────┤
                    │                                         │
                    │  Main Git Repository                    │
                    │  /home/user/project/                    │
                    │  └── .git/                              │
                    │                                         │
                    │  Git Worktrees                          │
                    │  /home/user/project/                    │
                    │  ├── .git/worktrees/                    │
                    │  │   ├── feature-auth/                  │
                    │  │   └── fix-bug/                       │
                    │  /other/path/                           │
                    │  ├── feature-auth/  ← Actual worktree   │
                    │  └── fix-bug/       ← Actual worktree   │
                    │                                         │
                    └─────────────────────────────────────────┘
```

---

## Component Architecture

### Frontend (Svelte)

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend Components                   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  UI Layer:                                               │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │  Sidebar   │  │  Main View │  │  WorkspaceItem     │ │
│  │            │  │            │  │                    │ │
│  │  Shows:    │  │  VSCode    │  │  Shows:            │ │
│  │  Projects  │  │  iframe    │  │  - Name            │ │
│  │  Workspaces│  │            │  │  - Branch          │ │
│  └────────────┘  └────────────┘  │  - Path            │ │
│                                  └────────────────────┘ │
│                                                          │
│  State Layer (Svelte Stores):                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  projects: Map<ProjectHandle, Project>            │  │
│  │  selectedProject: ProjectHandle | null            │  │
│  │  selectedWorkspace: string (path) | null          │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  API Layer:                                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │  openProject(path) -> ProjectHandle               │  │
│  │  discoverWorkspaces(handle) -> Workspace[]        │  │
│  │  closeProject(handle) -> void                     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Backend (Rust/Tauri)

```
┌──────────────────────────────────────────────────────────────┐
│                    Backend Architecture                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Command Layer:                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  #[tauri::command]                                     │  │
│  │  async fn open_project(path: String) -> Result<...>   │  │
│  │  async fn discover_workspaces(handle: String) -> ...  │  │
│  │  async fn close_project(handle: String) -> ...        │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  State Management:                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AppState {                                            │  │
│  │    projects: Mutex<HashMap<Uuid, ProjectContext>>     │  │
│  │    code_server_manager: ProcessManager                │  │
│  │  }                                                     │  │
│  │                                                        │  │
│  │  ProjectContext {                                      │  │
│  │    handle: Uuid                                        │  │
│  │    path: PathBuf                                       │  │
│  │    provider: Arc<GitWorktreeProvider>                 │  │
│  │  }                                                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  Provider Layer:                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  trait WorkspaceProvider {                             │  │
│  │    type Workspace: Workspace;                          │  │
│  │    fn new(root: PathBuf) -> Result<Self>;             │  │
│  │    async fn discover() -> Vec<Self::Workspace>;       │  │
│  │  }                                                     │  │
│  │                                                        │  │
│  │  struct GitWorktreeProvider {                          │  │
│  │    project_root: PathBuf                               │  │
│  │  }                                                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  Git Layer:                                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  git2::Repository                                      │  │
│  │  • open()                                              │  │
│  │  • head()                                              │  │
│  │  • worktrees()                                         │  │
│  │  • find_worktree()                                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Opening a Project

```
┌─────────┐
│  USER   │ Clicks "Open Project"
└────┬────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frontend: openProject('/home/user/my-project')             │
└────────────────────────────┬────────────────────────────────┘
                             │ IPC
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Tauri Command: open_project(path: String)                 │
│                                                             │
│  1. Generate UUID handle                                    │
│     let handle = Uuid::new_v4();                            │
│                                                             │
│  2. Create provider (validates git repo)                    │
│     let provider = GitWorktreeProvider::new(path)?;         │
│     ├─→ Repository::open(path)?  // Validates git repo     │
│     └─→ Returns GitWorktreeProvider { project_root }       │
│                                                             │
│  3. Store in AppState                                       │
│     state.projects.insert(handle, ProjectContext {          │
│       handle, path, provider                                │
│     });                                                     │
│                                                             │
│  4. Return handle to frontend                               │
│     Ok(handle.to_string())                                  │
└────────────────────────────┬────────────────────────────────┘
                             │ IPC Response
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Frontend: Receives handle                                  │
│  projectStore.set({ handle, path, workspaces: [] })         │
│                                                             │
│  Displays in sidebar:                                       │
│  📁 my-project (handle: "abc-123...")                       │
└─────────────────────────────────────────────────────────────┘
```

### Discovering Workspaces

```
┌─────────┐
│Frontend │ Auto-triggers after project open
└────┬────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Frontend: discoverWorkspaces(projectHandle)                │
└────────────────────────────┬────────────────────────────────┘
                             │ IPC
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Tauri Command: discover_workspaces(handle: String)        │
│                                                             │
│  1. Parse handle                                            │
│     let uuid = Uuid::parse_str(&handle)?;                   │
│                                                             │
│  2. Get provider from state                                 │
│     let context = state.projects.get(&uuid)?;               │
│     let provider = context.provider;                        │
│                                                             │
│  3. Call discover (async, spawn_blocking)                   │
│     let workspaces = provider.discover().await?;            │
│                                                             │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  GitWorktreeProvider::discover()                            │
│                                                             │
│  tokio::spawn_blocking {                                    │
│    let repo = Repository::open(&project_root)?;             │
│                                                             │
│    // 1. Main worktree                                      │
│    let main_branch = repo.head()?.shorthand();              │
│    workspaces.push(GitWorktree {                            │
│      name: "my-project",                                    │
│      path: "/home/user/my-project",                         │
│      branch: main_branch                                    │
│    });                                                      │
│                                                             │
│    // 2. Additional worktrees                               │
│    for wt_name in repo.worktrees()? {                       │
│      let wt = repo.find_worktree(wt_name)?;                 │
│      let wt_path = wt.path();                               │
│      // Skip main, parse branch, add to workspaces          │
│    }                                                        │
│                                                             │
│    Ok(workspaces)                                           │
│  }                                                          │
└────────────────────────────┬────────────────────────────────┘
                             │ Returns Vec<GitWorktree>
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Frontend: Receives workspaces                              │
│  [                                                          │
│    { name: "my-project", path: "...", branch: "main" },     │
│    { name: "feature-auth", path: "...", branch: "feat" },   │
│    { name: "fix-bug", path: "...", branch: "bugfix" }       │
│  ]                                                          │
│                                                             │
│  Updates UI:                                                │
│  📁 my-project                                              │
│    ├─ 📂 feature-auth (feat)                                │
│    └─ 📂 fix-bug (bugfix)                                   │
└─────────────────────────────────────────────────────────────┘
```

### Selecting a Workspace

```
USER clicks workspace in sidebar
     │
     ▼
Frontend: selectedWorkspace = workspace.path
     │
     ▼
Update iframe src to:
  http://localhost:{port}/?folder={workspace.path}
     │
     ▼
VSCode (code-server) opens at workspace path
```

---

## WorkspaceProvider Design

### Trait Definition

```rust
┌──────────────────────────────────────────────────────────────┐
│  pub trait WorkspaceProvider: Send + Sync                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  type Workspace: Workspace + Serialize + Clone + Send;      │
│                                                              │
│  fn new(project_root: PathBuf)                               │
│    -> Result<Self, WorkspaceError>                           │
│    where Self: Sized;                                        │
│                                                              │
│  async fn discover(&self)                                    │
│    -> Result<Vec<Self::Workspace>, WorkspaceError>;         │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  pub trait Workspace                                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  fn name(&self) -> &str;                                     │
│  fn path(&self) -> &Path;                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Why Associated Types?

```
Problem: Trait objects require boxing

❌ Without Associated Types:
   async fn discover(&self) -> Result<Vec<Box<dyn Workspace>>>
   • Every workspace allocated on heap
   • Runtime dispatch overhead
   • Lost type information

✅ With Associated Types:
   type Workspace: Workspace;
   async fn discover(&self) -> Result<Vec<Self::Workspace>>
   • Concrete type returned
   • No boxing
   • Full type information preserved
   • Zero-cost abstraction
```

### GitWorktreeProvider Implementation

```
┌──────────────────────────────────────────────────────────────┐
│  GitWorktreeProvider                                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Fields:                                                     │
│    project_root: PathBuf                                     │
│                                                              │
│  Methods:                                                    │
│                                                              │
│  new(project_root) -> Result<Self>                           │
│    └─→ Repository::open(project_root)?                      │
│        └─→ Validates git repository exists                  │
│                                                              │
│  discover() -> Result<Vec<GitWorktree>>                      │
│    └─→ tokio::spawn_blocking {                              │
│         ├─→ Open repository                                 │
│         ├─→ Get main worktree branch (HEAD)                 │
│         ├─→ List all worktrees (repo.worktrees())           │
│         ├─→ Parse each worktree                             │
│         │   ├─→ Get path                                    │
│         │   ├─→ Get branch                                  │
│         │   └─→ Derive name from dir                        │
│         └─→ Return Vec<GitWorktree>                         │
│       }                                                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  GitWorktree                                                 │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Fields:                                                     │
│    name: String      // Directory name                       │
│    path: PathBuf     // Full filesystem path                 │
│    branch: String    // Current branch or "(detached)"       │
│                                                              │
│  Implements:                                                 │
│    • Workspace trait                                         │
│    • Serialize (for Tauri)                                   │
│    • Clone                                                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## State Management

### AppState Structure

```
┌────────────────────────────────────────────────────────────┐
│  AppState                                                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  projects: Arc<Mutex<HashMap<Uuid, ProjectContext>>>      │
│    │                                                       │
│    └─→ Key: Uuid (project handle)                         │
│        Value: ProjectContext                               │
│                                                            │
│  code_server_manager: Arc<ProcessManager>                 │
│    │                                                       │
│    └─→ Manages code-server processes                      │
│                                                            │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  ProjectContext                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  handle: Uuid                                              │
│    └─→ Unique identifier for this project                 │
│                                                            │
│  path: PathBuf                                             │
│    └─→ Filesystem path to project root                    │
│                                                            │
│  provider: Arc<GitWorktreeProvider>                        │
│    └─→ Shared ownership of workspace provider             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Why Uuid Instead of String?

```
❌ String handle:
   HashMap<String, ProjectContext>
   • Can accidentally use wrong string
   • No type safety
   • Easy to mix up with paths

✅ Uuid handle:
   HashMap<Uuid, ProjectContext>
   • Type-safe
   • Compiler catches mistakes
   • Clear semantics
   • Proper Hash/Eq implementation
   • Standard type

Frontend Interface:
   Still sees strings (UUID serialized)
   Type: ProjectHandle = string
```

### Concurrency Model

```
Multiple projects open simultaneously:

Thread 1:                          Thread 2:
  open_project("proj-a")             open_project("proj-b")
       │                                  │
       ├─→ lock AppState.projects         │
       │   insert(uuid1, ctx1)            │
       └─→ unlock                         │
                                          ├─→ lock AppState.projects
                                          │   insert(uuid2, ctx2)
                                          └─→ unlock

  discover(uuid1)                    discover(uuid2)
       │                                  │
       ├─→ read AppState.projects         │
       │   get(uuid1) -> ctx1              │
       │   ctx1.provider.discover()        │
       │   (spawn_blocking)                │
       └─→ unlock                         │
                                          ├─→ read AppState.projects
                                          │   get(uuid2) -> ctx2
                                          │   ctx2.provider.discover()
                                          │   (spawn_blocking)
                                          └─→ unlock

No contention - different projects operate independently!
```

---

## Type System

### Rust Types

```rust
// Core trait
pub trait WorkspaceProvider: Send + Sync {
    type Workspace: Workspace + Serialize + Clone + Send;
    fn new(project_root: PathBuf) -> Result<Self, WorkspaceError>
        where Self: Sized;
    async fn discover(&self) -> Result<Vec<Self::Workspace>, WorkspaceError>;
}

pub trait Workspace {
    fn name(&self) -> &str;
    fn path(&self) -> &Path;
}

// Concrete implementation
#[derive(Debug, Clone, Serialize)]
pub struct GitWorktree {
    name: String,
    path: PathBuf,
    branch: String,
}

impl Workspace for GitWorktree {
    fn name(&self) -> &str { &self.name }
    fn path(&self) -> &Path { &self.path }
}

pub struct GitWorktreeProvider {
    project_root: PathBuf,
}

impl WorkspaceProvider for GitWorktreeProvider {
    type Workspace = GitWorktree;
    // ... implementation
}
```

### TypeScript Types

```typescript
// Opaque handle type
export type ProjectHandle = string; // UUID from backend

// Workspace representation
export interface Workspace {
  name: string;
  path: string;
  branch: string;
}

// Project with workspaces
export interface Project {
  handle: ProjectHandle;
  path: string;
  workspaces: Workspace[];
}

// API functions
export async function openProject(path: string): Promise<ProjectHandle>;

export async function discoverWorkspaces(handle: ProjectHandle): Promise<Workspace[]>;

export async function closeProject(handle: ProjectHandle): Promise<void>;
```

### Type Flow Across IPC Boundary

```
Rust Side                    IPC Boundary              TypeScript Side
─────────────────────────────────────────────────────────────────────

Uuid                         →  serialize  →            string
GitWorktree                  →  serialize  →            Workspace
Vec<GitWorktree>             →  serialize  →            Workspace[]
Result<T, WorkspaceError>    →  .to_tauri() →           Result<T, string>
```

---

## Error Handling

### Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("Not a git repository: {0}")]
    NotGitRepository(String),

    #[error("Git operation failed: {0}")]
    GitError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Invalid workspace: {0}")]
    InvalidWorkspace(String),
}
```

### Extension Trait for Tauri

```rust
pub trait ToTauriResult<T> {
    fn to_tauri(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> ToTauriResult<T> for Result<T, E> {
    fn to_tauri(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

// Usage in commands
#[tauri::command]
async fn open_project(path: String) -> Result<String, String> {
    let provider = GitWorktreeProvider::new(path.into()).to_tauri()?;
    // ────────────────────────────────────────────────┬──────────────
    // Converts WorkspaceError -> String automatically  └→ .to_tauri()
    Ok(handle)
}
```

### Error Flow

```
Backend Error                    Frontend
─────────────────────────────────────────────

WorkspaceError::NotGitRepository
    ↓
.to_tauri()
    ↓
Result<T, String>
    ↓
Tauri IPC
    ↓
                                Promise.reject(error: string)
                                    ↓
                                Display error to user
                                "Not a git repository: /path"
```

---

## UI Structure

### Sidebar Layout

```
┌───────────────────────────────────────┐
│  Chime                                │
├───────────────────────────────────────┤
│                                       │
│  📁 project-a  ───┐                   │
│    └─ 📂 feature-auth                 │  ← Click: Open worktree in VSCode
│    └─ 📂 fix-bug-123                  │
│       └─ main                         │  ← Main worktree (shown under project)
│                                       │
│  📁 project-b  ───┐                   │
│    └─ 📂 experiment                   │
│       └─ main                         │
│                                       │
│  [+ Open Project]                     │
│                                       │
└───────────────────────────────────────┘

Click project name → Opens main worktree
Click worktree → Opens that worktree
```

### Main View

```
┌───────────────────────────────────────────────────────────────┐
│  [Tab: project-a]  [Tab: feature-auth]  [Tab: fix-bug-123]   │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                                                         │ │
│  │          <iframe src="http://localhost:7000">          │ │
│  │                                                         │ │
│  │                  VSCode (code-server)                  │ │
│  │                                                         │ │
│  │              Workspace: feature-auth                   │ │
│  │              Branch: feat-auth                         │ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Performance Characteristics

### Operation Costs

| Operation                 | Time         | Notes              |
| ------------------------- | ------------ | ------------------ |
| `Repository::open()`      | 1-5ms        | Per operation      |
| `repo.worktrees()`        | 5-10ms       | List all worktrees |
| `spawn_blocking` overhead | ~0.1ms       | Async wrapper      |
| **Total discover()**      | **~10-15ms** | Not in hot path ✅ |
| UUID generation           | <1μs         | Negligible         |
| HashMap lookup            | <1μs         | O(1)               |

### Memory Usage

| Component           | Size       | Notes                 |
| ------------------- | ---------- | --------------------- |
| GitWorktreeProvider | ~50 bytes  | Just PathBuf          |
| GitWorktree         | ~100 bytes | Strings + PathBuf     |
| ProjectContext      | ~200 bytes | Includes Arc overhead |
| Uuid                | 16 bytes   | Fixed size            |

---

## Future Extensions

### Potential Provider Implementations

```
┌──────────────────────────────────────────────────────────┐
│  WorkspaceProvider (trait)                               │
└────────────────┬─────────────────────────────────────────┘
                 │
     ┌───────────┼───────────┬─────────────────────┐
     │           │           │                     │
     ▼           ▼           ▼                     ▼
┌─────────┐ ┌─────────┐ ┌─────────┐        ┌────────────┐
│   Git   │ │ Docker  │ │ Remote  │        │   Custom   │
│Worktree │ │ Container│ │   SSH   │        │User-Defined│
│Provider │ │ Provider │ │ Provider│        │  Provider  │
└─────────┘ └─────────┘ └─────────┘        └────────────┘
```

### Future Capabilities

- Create/delete worktrees
- Workspace status (dirty, ahead/behind)
- Automatic cleanup
- Workspace metadata persistence
- Progress indicators
- Workspace templates

---

## References

- **Implementation Plan:** See `docs/INITIAL_WORKSPACE_PROVIDER.md`
- **Project Concept:** See `docs/INITIAL_CONCEPT.md`
- **Development Workflow:** See `AGENTS.md`
- **git2 Documentation:** https://docs.rs/git2
- **async-trait Documentation:** https://docs.rs/async-trait

---

**Document Version:** 1.0  
**Last Updated:** 2025-11-20
