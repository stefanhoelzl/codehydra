# Chime - Multi-Agent IDE

## Vision

**Chime** is a desktop IDE that enables developers to orchestrate multiple AI agents working in parallel across isolated git worktrees. Each agent operates independently in its own VSCode environment, allowing developers to tackle multiple tasks simultaneously without interference.

### Name Origin

- **Chimera**: Mythological creature with multiple parts working as one - metaphor for multi-agent orchestration
- **Chime**: Notification sound that alerts when an agent completes its task

## Core Concept

### The Problem

Developers want to work on multiple features/fixes simultaneously with AI assistance, but:

- Single AI session blocks other work
- Context switching loses momentum
- Can't parallelize independent tasks
- Risk of conflicts when switching branches

### The Solution

Chime provides:

- **Multiple isolated agents** - Each in its own git worktree
- **Parallel execution** - All agents work simultaneously
- **Visual orchestration** - Clear status of all agents at a glance
- **Instant context switching** - Jump between agents with one click
- **Completion notifications** - Audio chime when agent finishes

### User Workflow

```
Developer opens Chime
    ↓
Opens project directory
    ↓
Creates Agent 1: "Add user authentication"
    → Git branch created
    → Worktree created in isolated directory
    → VSCode launches with Claude Code
    → Developer gives first prompt
    ↓
Switches to create Agent 2: "Fix pagination bug"
    → New branch, worktree, VSCode instance
    → Gives second prompt
    ↓
Agent 1 status turns green + chime plays
    → Developer switches back to Agent 1
    → Reviews work, makes adjustments
    ↓
Agent 2 finishes while reviewing Agent 1
    → Chime plays again
    → Developer can switch when ready
    ↓
Reviews both agents, merges work manually
    ↓
Closes completed agents
    → Worktrees cleaned up
    → Branches cleaned up
    → Resources freed
```

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Chime App                           │
│  ┌─────────────┬────────────────────────────────────────┐   │
│  │             │                                        │   │
│  │  Sidebar    │         Main Window                    │   │
│  │             │                                        │   │
│  │ + project_a │    ┌────────────────────────────┐     │   │
│  │ ├─🟢agent_1 │    │                            │     │   │
│  │ ├─🔴agent_2 │    │     VSCode (code-server)   │     │   │
│  │ └─🟢agent_3 │    │                            │     │   │
│  │             │    │   Running Claude Code      │     │   │
│  │ + project_b │    │   for selected agent       │     │   │
│  │ └─🟢agent_1 │    │                            │     │   │
│  │             │    └────────────────────────────┘     │   │
│  └─────────────┴────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri Application                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────┐         ┌────────────────────┐      │
│  │  Svelte Frontend   │   IPC   │   Rust Backend     │      │
│  │                    │◄────────►│                    │      │
│  │  - UI Components   │         │  - Agent Manager   │      │
│  │  - Stores (state)  │         │  - Agent Provider  │      │
│  │  - Notifications   │         │  - Workspace Prov. │      │
│  └────────────────────┘         │  - Agent Observer  │      │
│                                 └──────────┬─────────┘      │
│                                            │                 │
└────────────────────────────────────────────┼─────────────────┘
                                             │
                    ┌────────────────────────┼────────────────────┐
                    │                        │                    │
                    ▼                        ▼                    ▼
          ┌──────────────────┐    ┌──────────────────┐  ┌──────────────────┐
          │  code-server #1  │    │  code-server #2  │  │  code-server #3  │
          │                  │    │                  │  │                  │
          │  Port: dynamic   │    │  Port: dynamic   │  │  Port: dynamic   │
          │  Auth: token     │    │  Auth: token     │  │  Auth: token     │
          │                  │    │                  │  │                  │
          │  + Claude Code   │    │  + Claude Code   │  │  + Claude Code   │
          │  + Launcher Ext  │    │  + Launcher Ext  │  │  + Launcher Ext  │
          └──────────────────┘    └──────────────────┘  └──────────────────┘
                    │                        │                    │
                    ▼                        ▼                    ▼
          ┌──────────────────┐    ┌──────────────────┐  ┌──────────────────┐
          │ Git Worktree #1  │    │ Git Worktree #2  │  │ Git Worktree #3  │
          │ Branch: feature  │    │ Branch: bugfix   │  │ Branch: refactor │
          └──────────────────┘    └──────────────────┘  └──────────────────┘
                                            │
                                            │ (all share)
                                            ▼
                                   ┌──────────────────┐
                                   │  Main Git Repo   │
                                   │  .git directory  │
                                   └──────────────────┘
```

### Data Flow

```
User Action (UI)
    ↓
Tauri Command (Rust)
    ↓
Agent Manager coordinates components
    ↓
WorkspaceProvider creates isolated workspace
AgentProvider sets up runtime environment
AgentObserver monitors state
    ↓
Tauri Events emit state updates
    ↓
Svelte Stores update reactively
    ↓
UI reflects changes (status, notifications)
```

## Tech Stack

### Desktop Framework

**Tauri**

- Rust backend for performance and system integration
- Smaller bundle size than Electron
- Better security model
- Native system access for process management

### Frontend

**Svelte + TypeScript**

- Smallest bundle size
- Best performance (compiled to vanilla JS)
- Cleanest syntax for reactive state
- Built-in stores (no additional state library needed)
- Excellent TypeScript support

### UI Components

**vscode-elements**

- VSCode-like UI components (familiar to developers)
- Web components work with any framework
- Consistent look with embedded VSCode
- URL: https://github.com/vscode-elements/elements

### VSCode Integration

**code-server**

- Full VSCode in the browser
- Embeddable in Tauri WebView
- Supports all VSCode extensions
- Headless operation
- URL: https://github.com/coder/code-server
- **Bundled with app** - Version controlled

### Workspace Isolation

**Git Worktrees**

- Native git feature
- Share .git directory (efficient disk usage)
- True filesystem isolation
- Standard git workflows still work
- Easy cleanup

### Agent Runtime

**Claude Code VSCode Extension**

- Purpose-built for AI-assisted development
- Interactive workflow
- Full IDE integration
- **Bundled with app** - Version controlled

**Command Executor Extension**

- Auto-executes commands on VSCode startup
- Calls Claude Code focus command
- **Bundled with app** - Ensures Claude Code opens automatically

## Key Components

### Rust Backend (Tauri)

#### Agent Manager

**Responsibility:** Orchestrate agent lifecycle

- Coordinate WorkspaceProvider and AgentProvider
- Track agent metadata (ID, name, state, timestamps)
- Handle agent creation/deletion workflow
- Emit state change events to frontend
- Manage agent registry

#### WorkspaceProvider

**Responsibility:** Provide isolated workspace directories

- Create git branches and worktrees
- Delete worktrees and branches on cleanup
- List existing worktrees
- Coordinate concurrent git operations
- Rollback on failures
- Provide workspace path for each agent

**Interface:**

```rust
trait WorkspaceProvider {
    fn initialize()        // Set up from project directory
    fn create_workspace()  // Create isolated workspace
    fn delete_workspace()  // Clean up workspace and branch
    fn list_workspaces()   // Enumerate existing workspaces
    fn get_workspace_path() // Get path to workspace
}
```

**Initial Implementation:** GitWorktreeProvider (uses git worktrees)

**Future Implementations:**

- DockerWorkspaceProvider (container-based isolation)
- RemoteWorkspaceProvider (SSH/remote workspaces)

#### AgentProvider

**Responsibility:** Provide complete agent runtime setup

- Find available ports
- Generate authentication tokens
- Spawn code-server processes with correct configuration
- Install bundled extensions (Claude Code, Command Executor)
- Configure VSCode settings
- Monitor process health
- Stop and cleanup processes
- Handle orphaned processes on startup

**Interface:**

```rust
trait AgentProvider {
    fn setup()      // Configure agent environment
    fn start()      // Launch agent runtime (code-server)
    fn stop()       // Shut down agent runtime
    fn get_ui_url() // Get URL for embedding in iframe
    fn cleanup()    // Remove agent resources
}
```

**Initial Implementation:** ClaudeCodeAgentProvider (code-server + Claude Code)

**Future Implementations:**

- JupyterAgentProvider (Jupyter notebooks)
- CustomAgentProvider (user-defined tools)

#### AgentObserver

**Responsibility:** Observe and report agent state

- Monitor agent activity (idle vs running)
- Detect state transitions
- Emit state change events
- **No lifecycle management** - only observation

**Implementation approach:** To be determined

- May use WebSocket interception
- May use extension bridge
- May use log monitoring
- May use process monitoring
- Likely combination of methods

### Svelte Frontend

#### Stores (State Management)

- **projects**: Current project, path, metadata
- **agents**: List of agents, states, selected agent
- **ui**: Sidebar state, dialogs, preferences

#### Components

- **Sidebar**: Project tree with nested agents
- **TabBar**: VSCode-style tabs for projects/agents
- **MainView**: iframe embedding code-server for selected agent
- **Dialogs**: Create agent, open project, confirmations
- **AgentItem**: Individual agent in sidebar with status indicator

#### Services

- **tauri-api**: Type-safe wrappers for Tauri commands
- **notifications**: Audio playback (chime sound), system notifications

### VSCode Extensions

#### Command Executor Extension

**Responsibility:** Execute commands on VSCode startup

- Bundled with application
- Configured to run on workspace open
- Executes Claude Code focus command
- Ensures Claude Code panel opens automatically

#### Claude Code Extension

**Responsibility:** AI agent functionality

- Bundled with application
- Provides AI-assisted development
- Interactive workflow with developer

## Core Features

### Project Management

- Open project via directory picker
- Auto-detect existing git worktrees on open
- Display project hierarchy in sidebar
- Support multiple projects simultaneously

### Agent Management

**Create Agent:**

- User enters agent name
- WorkspaceProvider creates git branch and worktree
- AgentProvider spawns code-server with extensions
- Command executor auto-focuses Claude Code
- Agent appears in sidebar
- Main view switches to new agent's VSCode

**Agent Display:**

- Status indicator (🟢 idle, 🔴 running)
- Agent name
- Last activity timestamp

**Select Agent:**

- Click agent in sidebar
- Main view switches to agent's VSCode iframe
- URL includes auth token for code-server

**Close Agent:**

- User confirms deletion
- AgentProvider stops code-server process
- WorkspaceProvider removes worktree
- WorkspaceProvider deletes git branch
- Agent removed from sidebar
- All resources cleaned up

### State Detection

**Goal:** Detect when Claude Code is idle vs running

**AgentObserver Implementation:** To be determined during implementation

**Possible Approaches:**

1. **WebSocket Interception**
   - Intercept messages between VSCode and Claude Code
   - Parse protocol to detect state
   - Challenge: Determine if frontend or backend implementation

2. **Extension Bridge**
   - Custom VSCode extension reports state to Tauri
   - Claude Code exposes state via API or events
   - More stable but requires extension cooperation

3. **Log Monitoring**
   - Watch Claude Code extension logs
   - Parse for state indicators
   - Fallback if other methods fail

4. **Process Monitoring**
   - Monitor CPU/resource usage patterns
   - Infer state from activity
   - Least reliable but works as last resort

**Decision:** Research and prototype during implementation

### Notifications

**Idle Transition:**

- AgentObserver detects agent becomes idle
- Event emitted to frontend
- Chime sound plays
- Status indicator turns green
- Optional: System notification

**Audio:**

- Bundled chime sound file
- Play via Web Audio API in Svelte

### Git Worktree Management

**Atomic Operations:**

- Create branch and worktree together
- Rollback branch if worktree creation fails
- Validation before operations

**Concurrent Operation Safety:**

- Coordinate git operations to prevent conflicts
- Handle lock contention gracefully
- Retry failed operations if appropriate

**Cleanup:**

- Remove worktree from filesystem
- Delete git branch
- Update git worktree registry
- Scan for orphaned worktrees on startup

### Code-Server Process Management

**Startup:**

- Find available port
- Generate unique auth token
- Spawn code-server with configuration
- Wait for server ready (health check)
- Install extensions if needed
- Return URL for embedding

**Monitoring:**

- Track process IDs
- Detect crashes
- Auto-restart on unexpected exit (optional)

**Shutdown:**

- Graceful process termination
- Cleanup on app exit
- Track processes across app restarts
- Kill orphaned processes on startup

### Extension Management

**Bundled Extensions:**

- Claude Code extension (.vsix)
- Command Executor extension (.vsix)
- Bundled with application distribution

**Installation:**

- Auto-install on code-server startup
- Verify installation succeeded
- Configure command executor to focus Claude Code

**Configuration:**

- VSCode settings per agent
- User data directory per agent
- Shared extensions directory

## Workflow Philosophy

### User-Controlled Workflows

Chime provides **infrastructure** for parallel agent orchestration. All **workflow decisions** are left to the user:

- **No automatic operations**: User initiates all actions
- **No automatic git operations**: User controls push/pull/fetch/merge
- **No automatic integration**: User decides when/how to merge agent work
- **Full control**: App provides tools, user defines workflow

### Agent Isolation

- **No inter-agent awareness**: Agents don't know about each other
- **No context sharing**: Each agent operates independently
- **No coordination**: User manually transfers knowledge between agents if needed
- **Complete isolation**: Each agent in separate worktree with separate VSCode

### Resource Cleanup

- **Complete cleanup on close**: Worktree, branch, and all resources removed
- **User initiates**: User closes agent when ready
- **Before closing**: User responsible for merging/preserving work
- **Clean slate**: No orphaned worktrees or branches

## Platform Support

- Target all major platforms: Linux, macOS, Windows
- Use cross-platform libraries where possible
- Abstract platform-specific APIs (process management, file paths, etc.)
- Test on all platforms during development

## Performance Characteristics

### Resource Usage

- **Memory**: Each code-server instance uses significant memory
- **CPU**: Multiple VSCode instances active simultaneously
- **Disk**: Each worktree is full repository checkout
- **Target**: Support 3-10 concurrent agents on typical dev machines

### Timing

- **App startup**: Fast (Tauri is lightweight)
- **Agent creation**: Multi-second operation (spawn code-server, load extensions)
- **Agent switching**: Near-instant (just switch iframe URL)
- **State detection**: Real-time updates via AgentObserver

## Technical Constraints

### Git Worktrees

- **Shared .git directory**: All worktrees share same .git
- **Concurrent operations**: Need coordination to prevent conflicts
- **Lock contention**: Git uses locks that can conflict
- **Mitigation**: Coordinate operations, handle errors gracefully

### Bundled Binaries

- **code-server**: Bundled with application
- **Extensions**: Bundled as .vsix files
- **Version control**: App controls versions
- **Updates**: App updates include binary updates
- **Advantage**: No external dependencies, consistent behavior

### Iframe Embedding

- **Security**: CSP configuration, sandboxing
- **Authentication**: Token-based auth for code-server
- **Communication**: PostMessage API for cross-frame communication
- **Isolation**: Each iframe is separate code-server instance

## Open Questions

### 1. AgentObserver Implementation

**Question:** How to reliably detect Claude Code agent state?

**Research Needed:**

- Can we intercept WebSocket from iframe? (Frontend vs backend)
- Does Claude Code expose state via extension API?
- Best fallback methods?

**Decision:** Prototype and test during implementation

### 2. Worktree Directory Location

**Question:** Where to create worktrees?

**Options:**

- Sibling to main repo
- Subdirectory of main repo
- User-configurable location
- Temporary directory

**Decision:** Determine during implementation, consider user preferences

### 3. Process Cleanup Strategy

**Question:** How to ensure no orphaned processes?

**Considerations:**

- PID tracking across app restarts
- Platform-specific process management
- Graceful vs forceful shutdown

**Decision:** Platform abstraction during implementation

### 4. Extension Auto-Installation

**Question:** When to install extensions?

**Options:**

- On first code-server startup
- On every startup (ensure latest)
- Verify before each agent creation

**Decision:** Determine during implementation

## Success Criteria

**MVP is successful when:**

- ✅ Can create multiple agents simultaneously
- ✅ Agents work in isolated worktrees without conflicts
- ✅ State detection accurately reflects Claude Code activity
- ✅ No orphaned processes after app closes
- ✅ Smooth switching between agents
- ✅ Chime notification plays when agent becomes idle
- ✅ Complete cleanup on agent close (worktree + branch)
- ✅ Stable for extended work sessions
- ✅ Works on all major platforms

---

**Project Name:** Chime
**Project Status:** Planning Phase
**Next Step:** Begin implementation - Set up project structure
