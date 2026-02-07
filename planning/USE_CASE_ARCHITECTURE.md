# CodeHydra Architecture

## Overview

Four concepts: **Providers**, **Use Cases**, **Modules**, **Dispatcher**. Wired by a **Composition Root**. No framework.

Key principles:

- **Use Cases** = class with typed `invoke(input): Promise<output>`. Phases dispatched to registered handlers.
- **Modules** = plain classes with domain methods. Depend only on providers. Don't know about use case interfaces.
- **Adapters** = co-located with modules. Adapter factories exported alongside the module class, mapping domain methods → use case phases.
- **Dispatcher** = typed interface with one method per use case. All triggers (IPC, Plugin API) and transitions go through it. Fully typed — no string dispatch.
- **Transitions are explicit** — the running use case calls `dispatcher.switchWorkspace(data)` in its own `invoke()`. No hidden registrations.
- **Interface is stable** — adding a module = export adapter factory from module file, register in composition root. No interface changes.

---

# Part 1: Core Concepts

## Architecture

### General Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        COMPOSITION ROOT                              │
│  Creates providers, use cases, dispatcher, modules.                  │
│  Wires use cases into dispatcher. Registers adapters with UCs.       │
│  The ONLY place that knows all components.                           │
└──┬────────────────┬───────────────┬─────────────────────────────┬────┘
   │ creates        │ creates       │ creates                     │ creates
   ▼                ▼               ▼                             ▼
┌──────────────┐  ┌────────────┐  ┌──────────┐    injected   ┌──────────┐
│  USE CASES   │  │ DISPATCHER │  │ MODULES  │◄───  into  ───│PROVIDERS │
│              │  │            │  │          │               │          │
│ invoke(in)   │  │ Typed      │  │ Plain    │               │ Stateless│
│   :out       │  │ interface  │  │ classes  │               │ I/O abs. │
│              │  │ one method │  │ domain   │               │          │
│ Dispatches   │  │ per use    │  │ methods  │               │ fs, git, │
│ phases to    │  │ case       │  │ ~50-200  │               │ ipc, ... │
│ adapters     │  │            │  │ LOC each │               │          │
└──────────────┘  └─────▲──────┘  └──────────┘               └──────────┘
       │                │
       │ registers      │ triggers
       │ with (via      │
       │ adapters)      │
       ▼                │
┌──────────────────┐ ┌──┴──────────┐
│ USE CASE         │ │EVENT SOURCES│
│ transitions      │ │             │
│ (explicit calls  │ │ IPC         │
│  in invoke())    │ │ Plugin API  │
└──────────────────┘ │ Internal cb │
                     └─────────────┘
```

### Event Sources → Dispatcher → Use Cases

```
EVENT SOURCES              DISPATCHER                    USE CASES
─────────────              ──────────                    ─────────

IPC (renderer) ──┐
                 ├──► dispatcher.createWorkspace(input) ──► CreateWorkspace.invoke(): WorkspaceInfo
Plugin API ──────┘
                       dispatcher.agentStatusChanged(e) ──► AgentStatusChanged.invoke()  (no await)
Internal cb ─────────►

Dispatcher interface (fully typed, one method per use case):
  createWorkspace(input: CreateInput):        Promise<WorkspaceInfo>
  deleteWorkspace(input: DeleteInput):        Promise<void>
  switchWorkspace(input: SwitchInput):        Promise<void>
  setWorkspaceMetadata(input: SetMetaInput):  Promise<void>
  getWorkspaceMetadata(input: GetMetaInput):  Promise<Metadata>
  getWorkspaceStatus(input: GetStatusInput):  Promise<WorkspaceStatus>
  getAgentSession(input: GetSessionInput):    Promise<AgentSession | null>
  restartAgentServer(input: RestartInput):    Promise<AgentSession>
  openProject(input: OpenInput):              Promise<ProjectInfo>
  closeProject(input: CloseInput):            Promise<void>
  enterShortcutMode():                        Promise<void>
  changeViewMode(input: ViewModeInput):       Promise<void>
  agentStatusChanged(input: StatusEvent):     Promise<void>
  appLifecycle():                             Promise<void>

IPC trigger wiring (composition root):
  api:workspace:create ─────► dispatcher.createWorkspace(payload)
  api:workspace:remove ─────► dispatcher.deleteWorkspace(payload)
  api:workspace:switch ─────► dispatcher.switchWorkspace(payload)
  ...etc (one line per IPC channel → dispatcher method)

Use case transitions (explicit in invoke()):
  DeleteWorkspace.invoke() ──► dispatcher.switchWorkspace(...)
  CreateWorkspace.invoke() ──► dispatcher.switchWorkspace(...)
```

### Wiring Detail

```
COMPOSITION ROOT
  1. Create providers
  2. Create use cases
  3. Create dispatcher (wire use case instances → typed methods)
  4. Inject dispatcher into use cases that need transitions
  5. Create modules (inject ONLY providers)
  6. Register adapters: useCase.register(adapterFactory(module)) (order = execution order)
  7. Wire triggers: IPC/Plugin API channels → typed dispatcher methods
  8. dispatcher.appLifecycle()  -- modules activate via onStart phase

       USE CASE                        USE CASE
       (class: invoke(in):out          (class: invoke(in):out
        + phase declarations)           + phase declarations)
            │                               │
            │ phases dispatched to          │ phases dispatched to
            │ registered adapters           │ registered adapters
            │                               │
       ┌────┼────┐                     ┌────┼────┐
       mod  mod  mod                   mod  mod  mod
       (via co-located adapters)       (via co-located adapters)

  Transitions: use case A calls dispatcher.switchWorkspace(data)
  explicitly in its own invoke() — visible, no hidden registrations
```

### Design Principles

1. **Open-Closed Principle** — adding a module = export adapter factory from module file + register in composition root. No interface changes.
2. **Generic interfaces** — phases like `finalize()` not `copyKeepfiles()`. Modules plug into generic lifecycle phases.
3. **One-way dependency** — use case `invoke()` dispatches to registered handlers, never the reverse
4. **Modules depend only on providers** — no module-to-module dependency. Modules don't know about use case interfaces.
5. **Use case `invoke(input): output`** — typed input/output. Dispatches phases to registered handlers. Calls dispatcher for transitions.
6. **Co-located adapters** — adapter factories exported alongside the module class. Map domain methods → use case phases. Module logic and adaptation logic in same file, separate concerns.
7. **Explicit transitions** — use case calls `dispatcher.switchWorkspace(data)` in its own `invoke()`. Fully typed, no hidden registrations.
8. **Removable** — remove adapter registration from composition root, rest works
9. **Minimal base class** — UseCase base class handles registration + phase dispatch. Not a framework.

---

## Providers

Pure, stateless abstractions over external systems. Injected via constructor into modules.

### Platform Providers

| Provider           | Abstracts                         | Current Implementation           |
| ------------------ | --------------------------------- | -------------------------------- |
| FileSystemProvider | `fs/promises`                     | DefaultFileSystemLayer           |
| GitProvider        | `simple-git`                      | SimpleGitClient                  |
| ProcessProvider    | `execa`                           | ExecaProcessRunner               |
| HttpProvider       | `fetch()`                         | DefaultNetworkLayer              |
| PortProvider       | `net` module                      | DefaultPortManager               |
| PathProvider       | App paths                         | DefaultPathProvider              |
| ConfigProvider     | Config load/save                  | ConfigService (becomes provider) |
| DownloadProvider   | Binary downloads                  | BinaryDownloadService            |
| LoggingProvider    | `electron-log`                    | ElectronLogService               |
| BuildInfo          | App version, paths, dev/prod mode | ElectronBuildInfo                |

### Shell Providers (Electron abstractions)

| Provider        | Abstracts                                    | Current Implementation |
| --------------- | -------------------------------------------- | ---------------------- |
| WindowProvider  | `BaseWindow`                                 | DefaultWindowLayer     |
| ViewProvider    | `WebContentsView`                            | DefaultViewLayer       |
| SessionProvider | `session`                                    | DefaultSessionLayer    |
| IpcProvider     | `ipcMain` + renderer push + request-response | DefaultIpcLayer        |
| DialogProvider  | `dialog`                                     | DefaultDialogLayer     |
| AppProvider     | `app`                                        | DefaultAppLayer        |
| ImageProvider   | `nativeImage`                                | DefaultImageLayer      |
| MenuProvider    | `Menu`                                       | DefaultMenuLayer       |

### Agent Providers

| Provider           | Abstracts                                                 | Current Implementation                          |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------- |
| AgentServerManager | Agent server lifecycle (start/stop/restart per workspace) | OpenCodeServerManager, ClaudeCodeServerManager  |
| AgentProvider      | Per-workspace agent connection + status                   | OpenCodeProvider, ClaudeCodeProvider            |
| AgentSetupInfo     | Agent binary info, config generation                      | OpenCodeSetupInfo, ClaudeCodeSetupInfo          |
| AgentStatusManager | Status aggregation across workspaces                      | AgentStatusManager (delegates to OpenCode impl) |

Agent providers are pluggable — factory functions (`createAgentServerManager()`, `createAgentProvider()`) select implementation by agent type (`"opencode"` | `"claude"`). Currently in `src/agents/`, moves to `src/providers/agents/`.

### IPC Communication Patterns

IpcProvider supports three distinct communication modes:

```
1. TRIGGERS (renderer → main, inbound)
   ┌──────────┐   IPC message    ┌──────────────────┐   invoke()   ┌──────────┐
   │ Renderer │ ───────────────► │ Composition Root │ ───────────► │ Use Case │
   └──────────┘                  └──────────────────┘              └──────────┘
   Wired by composition root. One-way. Initiates use case execution.

2. NOTIFICATIONS (main → renderer, outbound, one-way)
   ┌──────────┐   ipc.send()     ┌──────────┐
   │  Module  │ ───────────────► │ Renderer │
   └──────────┘                  └──────────┘
   Modules call ipcProvider.send(channel, data). Fire-and-forget.
   Used in Notify phases (onFinalized, onDeleted, onSwitched, ...).

3. DIALOGS (main ↔ renderer, request-response round-trip)
   ┌─────────────┐  ipc.request()  ┌──────────┐  user input  ┌─────────────┐
   │ Dialog      │ ───────────────►│ Renderer │ ────────────►│ Dialog      │
   │ Module      │ ◄───────────────│ (dialog) │              │ Module      │
   │             │   response      └──────────┘              │ (continues) │
   └─────────────┘                                           └─────────────┘
   Dialog modules call ipcProvider.request(channel, data) → Promise<response>.
   Used in Interact phases (gatherUserChoice). Per-dialog modules own this.
```

**Why dialogs need round-trips:** The use case's gather phases run first (collecting options/config from modules), then the dialog module sends the gathered data to the renderer and awaits the user's choice. The renderer can't pre-fill because the data comes from modules at runtime.

---

## Use Cases

A use case is a **class** with four parts:

1. **Typed I/O** — `invoke(input: TInput): Promise<TOutput>`. Callers get typed results.

2. **Phase declarations** — explicitly typed phases (gather, execute, notify, etc.). Generic enough that new modules can implement them without changing the interface.

3. **`invoke()` method** — the orchestration logic. Dispatches phases to registered handlers. Calls typed dispatcher methods for transitions to other use cases.

4. **Registered handlers** — composition root calls `useCase.register({ phaseName: (args) => module.method(args) })` to map module methods to phases via inline adapters.

The **UseCase base class** handles registration and phase dispatch. Each phase type has defined behavior (gather = merge results, execute = sequential, notify = fire-and-forget, etc.).

### Phase Types (Explicitly Declared)

| Type         | Behavior                               | Example                          |
| ------------ | -------------------------------------- | -------------------------------- |
| **Gather**   | Calls all implementers, merges results | `gatherOptions()`                |
| **Interact** | Single implementer, user interaction   | `gatherUserChoice(options)`      |
| **Execute**  | Sequential across implementers         | `create(input)`, `delete(input)` |
| **Error**    | Cleanup on failure, sequential         | `createFailed(input, error)`     |
| **React**    | Sequential, can do work                | `onCreated(event)`               |
| **Finalize** | Sequential, post-operation             | `finalize(input)`                |
| **Notify**   | Fire-and-forget, non-blocking          | `onFinalized(event)`             |

Not every use case needs all types. Each declares only the phases it needs.

### Example: CreateWorkspace

```typescript
// Use case class — typed I/O, phases, dispatcher for transitions
class CreateWorkspace extends UseCase<CreateInput, WorkspaceInfo> {
  constructor(private dispatcher: Dispatcher) { super() }

  // Phase declarations — type determines dispatch behavior
  readonly gatherOptions = this.gather<Option[]>()
  readonly gatherConfig = this.gather<ConfigData>()
  readonly gatherUserChoice = this.interact<[Option[], ConfigData], UserChoice>()
  readonly create = this.execute<[CreateContext]>()
  readonly createFailed = this.error<[CreateContext, Error]>()
  readonly onCreated = this.react<[CreateContext]>()
  readonly finalize = this.finalize_<[CreateContext]>()
  readonly onFinalized = this.notify<[CreateContext]>()

  async invoke(input: CreateInput): Promise<WorkspaceInfo> {
    const options = this.gatherOptions()
    const config = this.gatherConfig()
    const choice = await this.gatherUserChoice(options, config)
    if (choice?.cancelled) return null

    const context = { ...input, ...choice, config }

    try {
      await this.create(context)
    } catch (error) {
      await this.createFailed(context, error)
      throw error
    }

    await this.onCreated(context)

    // Transition: switch to new workspace (fully typed dispatcher call)
    if (!input.keepInBackground) {
      await this.dispatcher.switchWorkspace({ path: context.path })
    }

    await this.finalize(context)
    this.onFinalized(context)  // fire-and-forget

    return { path: context.path, name: context.name }
  }
}

// Module file: keepfiles-manager.ts
// Module class + co-located adapter factories

class KeepfilesManager {
  constructor(private fs: FileSystemProvider) {}

  getOptions(): Option[] { return [{ id: 'keepfiles', label: 'Copy keepfiles' }] }
  async copyKeepfiles(ctx: CreateContext) { await this.fs.copyFile(...) }
}

// Adapter factory — maps domain methods → CreateWorkspace phases
const keepfilesCreateWsAdapter = (m: KeepfilesManager) => ({
  gatherOptions: () => m.getOptions(),
  finalize:      (ctx: CreateContext) => m.copyKeepfiles(ctx),
})

export { KeepfilesManager, keepfilesCreateWsAdapter }


// Composition root: create use cases, dispatcher, modules, register adapters
const createWs = new CreateWorkspace(dispatcher)
const switchWs = new SwitchWorkspace()
// ...all use cases...

const dispatcher = createDispatcher({ createWorkspace: createWs, switchWorkspace: switchWs, ... })
createWs.setDispatcher(dispatcher)

// Register adapters — registration order = execution order within each phase
createWs.register(agentLifecycleCreateWsAdapter(agentLifecycle))
createWs.register(keepfilesCreateWsAdapter(keepfilesMgr))
createWs.register(codeServerRunnerCreateWsAdapter(codeServerRunner))
createWs.register(pluginBridgeCreateWsAdapter(pluginBridge))
createWs.register(mcpServerCreateWsAdapter(mcpServer))
createWs.register(createWsDialogAdapter(createWsDialog))
createWs.register(workspaceMgrCreateWsAdapter(workspaceMgr))
createWs.register(viewLifecycleCreateWsAdapter(viewLifecycle))
createWs.register(workspaceFileGenCreateWsAdapter(workspaceFileGen))
createWs.register(projectRegistryCreateWsAdapter(projectRegistry))
createWs.register(telemetryTrackerCreateWsAdapter(telemetryTracker))

// IPC trigger wiring (fully typed)
ipc.handle("api:workspace:create", (p) => dispatcher.createWorkspace(p))
```

**Key**: adding a new module (e.g., LintConfigCopier) = add adapter factory to module file + one `createWs.register(...)` line. No interface change. Module doesn't know about use case phases.

### Use Case Transitions

Transitions are **explicit calls** in the running use case's `invoke()` method. The use case knows its own logic including which other use cases it needs to invoke:

```typescript
class DeleteWorkspace extends UseCase<DeleteInput, void> {
  constructor(private dispatcher: Dispatcher) {
    super();
  }

  async invoke(input: DeleteInput): Promise<void> {
    // Transition: switch away from active workspace before deleting
    if (input.isActive && !input.skipSwitch) {
      await this.dispatcher.switchWorkspace({ next: pickNext(input) });
    }

    await this.prepare(input); // stop agent, destroy view, kill processes
    await this.delete(input); // remove git worktree
    this.onDeleted(input); // fire-and-forget: state + IPC + telemetry
  }
}
```

Fully typed — `dispatcher.switchWorkspace()` has typed input/output. No string keys, no `any`. Rename a use case and the compiler catches every caller.

### Use Case List

| Use Case             | Phases                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| CreateWorkspace      | gatherOptions, gatherConfig, gatherUserChoice, create, createFailed, onCreated, finalize, onFinalized |
| DeleteWorkspace      | prepare, delete, deleteFailed, onDeleted, onProgress                                                  |
| SwitchWorkspace      | switch, onSwitched                                                                                    |
| OpenProject          | gatherUserChoice, open, openFailed, onOpened                                                          |
| CloseProject         | close, onClosed                                                                                       |
| EnterShortcutMode    | enter, onEntered                                                                                      |
| ChangeViewMode       | change, onChanged                                                                                     |
| RestartAgentServer   | restart, onRestarted                                                                                  |
| SetWorkspaceMetadata | set, onSet                                                                                            |
| AgentStatusChanged   | gatherState, onStatusChanged                                                                          |
| AppLifecycle         | gatherState, setup, onStart, shutdown                                                                 |
| GetWorkspaceStatus   | gatherStatus                                                                                          |
| GetWorkspaceMetadata | gatherMetadata                                                                                        |
| GetAgentSession      | gatherSession                                                                                         |

**Query use cases** are simple gather-only use cases. The composition root wires them to IPC handlers for pull-based renderer access. Adding query use cases = define class with gather phase + register adapters for modules that provide data.

This list is representative, not exhaustive. Adding a use case = define class with phases + `invoke()` + register adapters in composition root.

### Use Case Transitions (complete map)

Only 2 transitions exist. Both are typed dispatcher calls:

```
CreateWorkspace.invoke()
  │
  ├── ...phases (gather, create, onCreated)...
  │
  ├── dispatcher.switchWorkspace({ path }) ──► SwitchWorkspace.invoke()
  │   (condition: !keepInBackground)              returns void
  │
  ├── ...phases (finalize, onFinalized)...
  │
  └── returns WorkspaceInfo


DeleteWorkspace.invoke()
  │
  ├── dispatcher.switchWorkspace({ next }) ──► SwitchWorkspace.invoke()
  │   (condition: isActive && !skipSwitch)        returns void
  │
  ├── ...phases (prepare, delete, onDeleted)...
  │
  └── returns void
```

All other use cases are standalone — no transitions.

---

## Modules

Plain classes with domain methods. Don't know about use case interfaces. Adapter factories co-located in same file.

- One focused responsibility (~50-200 LOC)
- Receives **only providers** via constructor
- Has **domain-specific method names** (e.g., `copyKeepfiles`, `startForWorkspace`) — not use case phase names
- **Does not implement any use case interface** — adapter factories in the same file map domain methods → use case phases
- Each module file exports: `ModuleClass` + one adapter factory per use case it participates in
- Never calls use case `invoke()` — only provides business logic
- **IPC is a provider, not a module** — modules that need to communicate with the renderer receive IpcProvider directly
- **Pull-based queries are use cases** — simple gather-only use cases (e.g., GetWorkspaceStatus) wired to IPC handlers by composition root
- Activation/shutdown via AppLifecycle phases (no separate lifecycle concept)
- Can be removed (remove adapter registration in composition root) without breaking other modules

---

## Composition Root

The only place that knows about all providers, modules, use cases, dispatcher, and registration.

```
BOOT:
  1. Create providers
  2. Create use cases
  3. Create dispatcher (wire use case instances → typed methods)
  4. Inject dispatcher into use cases that need transitions (CreateWorkspace, DeleteWorkspace)
  5. Create modules (inject ONLY providers)
  6. Register adapters: useCase.register(adapterFactory(module))
     -> registration order = execution order within each phase
  7. Wire triggers: external events → typed dispatcher methods
     -> IPC messages from renderer (e.g., api:workspace:create → dispatcher.createWorkspace(payload))
     -> Plugin API calls from extensions (e.g., pluginServer.on("workspace:create") → dispatcher.createWorkspace)
     -> Module callbacks (e.g., AgentStatusTracker status → dispatcher.agentStatusChanged(event))
  8. dispatcher.appLifecycle()
     -> onStart dispatches to registered modules in registration order
     -> modules activate themselves (start processes, open connections, etc.)

SHUTDOWN:
  appLifecycle shutdown phase -> modules shut down in reverse registration order
```

---

# Part 2: Use Case Details

## CreateWorkspace

```
IPC / Plugin API
       │
       ▼
CreateWorkspace.invoke(input)
       │
       ├─── gatherOptions() ◄── GATHER: merge all ──────────────────────┐
       │         ├── AgentLifecycle ────► ["Start agent"]               │
       │         └── KeepfilesManager ─► ["Copy keepfiles"]             │
       │                                        ╠══► options[]          │
       ├─── gatherConfig() ◄── GATHER: merge all ──────────────────────┤
       │         ├── CodeServerRunner ─► { codeServerPort }             │
       │         ├── PluginBridge ─────► { pluginPort }                 │
       │         └── McpServer ────────► { mcpPort }                    │
       │                                        ╠══► config             │
       ├─── gatherUserChoice(options) ◄── INTERACT: single ────────────┤
       │         └── CreateWsDialog ─► ipc.request() ► renderer dialog │
       │              ◄── user choice   cancelled? ──► return           │
       │                                                                │
       │    context = { input + choice + config }                       │
       │                                                                │
       ├─── create(context) ◄── EXECUTE: sequential ───────────────────┤
       │    │    └── WorkspaceManager ─► git worktree add               │
       │    └─ on error:                                                │
       │         createFailed(context) ◄── ERROR ──────────────────────┤
       │              └── WorkspaceManager ► remove failed worktree     │
       │              throw                                             │
       │                                                                │
       ├─── onCreated(context) ◄── REACT: sequential ──────────────────┤
       │         ├── AgentLifecycle ───► start agent (mcpPort,pluginPort)│
       │         └── ViewLifecycle ────► create view (codeServerPort)   │
       │                                                                │
       ├─── TRANSITION (if !keepInBackground): ────────────────────────┤
       │         dispatcher.switchWorkspace({ path })                   │
       │         └──► SwitchWorkspace.invoke() ──► returns void         │
       │                                                                │
       ├─── finalize(context) ◄── FINALIZE: sequential ────────────────┤
       │         ├── KeepfilesManager ─► copy keepfiles                 │
       │         └── WorkspaceFileGen ─► generate .code-workspace       │
       │                                                                │
       └─── onFinalized(context) ◄── NOTIFY: fire-and-forget ─────────┘
                 ├── ProjectRegistry ──► state update + IPC to renderer
                 └── TelemetryTracker ─► track event
```

---

## DeleteWorkspace

```
IPC / Plugin API
       │
       ▼
DeleteWorkspace.invoke(input)
       │
       ├─── TRANSITION (if isActive && !skipSwitch): ─────────────────┐
       │         dispatcher.switchWorkspace({ next })                  │
       │         └──► SwitchWorkspace.invoke() ──► returns void        │
       │                                                               │
       ├─── prepare(input) ◄── EXECUTE: sequential ───────────────────┤
       │         ├── AgentLifecycle ───► stop agent server             │
       │         │   (error → cancel entire deletion)                  │
       │         ├── ViewLifecycle ────► destroy view                  │
       │         └── ProcessKiller ────► kill blocking processes       │
       │              (optional, platform-specific)                    │
       │                                                               │
       ├─── delete(input) ◄── EXECUTE: sequential ────────────────────┤
       │    │    └── WorkspaceManager ─► git worktree remove           │
       │    └─ on error:                                               │
       │         deleteFailed(input) ◄── ERROR ───────────────────────┤
       │              throw                                            │
       │                                                               │
       └─── onDeleted(event) ◄── NOTIFY: fire-and-forget ────────────┘
                 ├── ProjectRegistry ──► state update + IPC to renderer
                 └── TelemetryTracker ─► track event
```

---

## SwitchWorkspace

```
IPC / Plugin API / DeleteWorkspace.prepare
       │
       ▼
SwitchWorkspace.invoke(input)
       │
       ├─── switch(input) ◄── EXECUTE ────────────────────────────────┐
       │         └── WorkspaceSwitcher ► perform workspace switch      │
       │                                                               │
       └─── onSwitched(event) ◄── NOTIFY: fire-and-forget ───────────┘
                 └── ViewActivation ───► activate view + IPC to renderer
```

---

## OpenProject / CloseProject

**OpenProject:**

```
IPC
 │
 ▼
OpenProject.invoke(input)
 │
 ├─── gatherUserChoice() ◄── INTERACT ────────────────────────────────┐
 │         └── OpenProjectDialog ─► ipc.request() ► folder picker/URL │
 │              ◄── user choice     cancelled? ──► return              │
 │                                                                     │
 ├─── open(choice) ◄── EXECUTE ───────────────────────────────────────┤
 │    │    └── ProjectManager ─► validate, clone if remote, setup git  │
 │    └─ on error:                                                     │
 │         openFailed(choice) ◄── ERROR ──────────────────────────────┤
 │              └── ProjectManager ► cleanup                           │
 │              throw                                                  │
 │                                                                     │
 └─── onOpened(event) ◄── NOTIFY: fire-and-forget ────────────────────┘
           ├── ProjectRegistry ────────► state update + IPC to renderer
           ├── OrphanedWorkspaceCleaner ► clean stale worktrees
           ├── BranchPreferenceCache ──► cache base branch
           └── TelemetryTracker ───────► track event
```

**CloseProject:**

```
IPC
 │
 ▼
CloseProject.invoke(input)
 │
 ├─── close(input) ◄── EXECUTE ───────────────────────────────────────┐
 │         └── ProjectManager ─► cleanup project resources             │
 │                                                                     │
 └─── onClosed(event) ◄── NOTIFY: fire-and-forget ────────────────────┘
           ├── ProjectRegistry ──► state update + IPC to renderer
           └── TelemetryTracker ─► track event
```

---

## UI Use Cases (EnterShortcutMode, ChangeViewMode)

```
IPC                                    IPC
 │                                      │
 ▼                                      ▼
EnterShortcutMode.invoke()         ChangeViewMode.invoke(mode)
 │                                      │
 ├── enter() ◄── EXECUTE               ├── change(mode) ◄── EXECUTE
 │    ├── ShortcutHandler               │    └── UiModeManager
 │    └── UiModeManager                 │
 │                                      │
 └── onEntered() ◄── NOTIFY            └── onChanged() ◄── NOTIFY
      └── (IPC to renderer)                  └── (IPC to renderer)
```

---

## RestartAgentServer

```
IPC / Plugin API
       │
       ▼
RestartAgentServer.invoke(input)
       │
       ├─── restart(input) ◄── EXECUTE ───────────────────────────────┐
       │         └── AgentLifecycle ───► stop + restart server         │
       │              (preserves session)                              │
       │                                                               │
       └─── onRestarted(event) ◄── NOTIFY: fire-and-forget ──────────┘
                 └── AgentLifecycle ───► IPC to renderer
```

---

## SetWorkspaceMetadata

```
IPC / Plugin API
       │
       ▼
SetWorkspaceMetadata.invoke(input)
       │
       ├─── set(input) ◄── EXECUTE ──────────────────────────────────┐
       │         └── WorkspaceMetadataManager ► write git config      │
       │                                                               │
       └─── onSet(event) ◄── NOTIFY: fire-and-forget ────────────────┘
                 └── WorkspaceMetadataManager ► IPC to renderer
```

---

## AgentStatusChanged

```
AgentStatusTracker detects SSE status event
       │
       ▼  (trigger wired by composition root)
AgentStatusChanged.invoke(event)
       │
       ├─── gatherState() ◄── GATHER ────────────────────────────────┐
       │         └── AgentStatusTracker ► { status, session }         │
       │                                                               │
       └─── onStatusChanged(event + state) ◄── NOTIFY: fire-and-forget┘
                 ├── BadgeUpdater ─────────► update dock/taskbar badge
                 └── AgentStatusTracker ───► IPC to renderer
```

---

## AppLifecycle

```
app.whenReady()
       │
       ▼
AppLifecycle.invoke()
       │
       ├─── gatherState() ◄── GATHER: merge all ─────────────────────┐
       │         ├── ProjectRegistry ──► project/workspace state       │
       │         └── AgentStatusTracker ► agent status per workspace   │
       │                                                               │
       ├─── setup(state) ◄── EXECUTE ─────────────────────────────────┤
       │         └── AgentLifecycle ───► setup UI + configure agent    │
       │                                                               │
       ├─── onStart() ◄── EXECUTE: sequential (registration order) ───┤
       │         ├── CodeServerRunner ─► start code-server process     │
       │         ├── PluginBridge ─────► start Socket.IO bridge        │
       │         ├── McpServer ────────► start MCP server              │
       │         ├── AgentLifecycle ───► initialize agent management   │
       │         ├── WindowSetup ──────► create BaseWindow             │
       │         ├── ProjectPersistence ► load saved projects          │
       │         └── AutoUpdater ──────► schedule update check         │
       │                                                               │
       │    ┌─── (app runs until quit) ────────────────────────┐       │
       │    │                                                  │       │
       │                                                               │
       └─── shutdown() ◄── EXECUTE: reverse registration order ───────┘
                 ├── WindowSetup ──────► close window
                 ├── CodeServerRunner ─► stop code-server
                 ├── PluginBridge ─────► stop Socket.IO bridge
                 ├── McpServer ────────► stop MCP server
                 └── ProjectPersistence ► save project list
```

**Registration order = activation order.** Shutdown dispatches in reverse registration order.

**Renderer initial state**: After `appLifecycle.invoke()` completes, the composition root invokes query use cases and pushes initial state to renderer via IpcProvider. On reconnection, same flow. Ongoing pull queries: renderer calls query use cases via IPC handlers.

---

## Query Use Cases (GetWorkspaceStatus, GetWorkspaceMetadata, GetAgentSession)

```
IPC / Plugin API                 IPC / Plugin API                 IPC / Plugin API
       │                                │                                │
       ▼                                ▼                                ▼
GetWorkspaceStatus.invoke()    GetWorkspaceMetadata.invoke()   GetAgentSession.invoke()
       │                                │                                │
       └── gatherStatus() ◄── GATHER   └── gatherMetadata() ◄── GATHER └── gatherSession() ◄── GATHER
            │                                │                                │
            └── ProjectRegistry             └── WsMetadataManager            └── AgentStatusTracker
                 ► { dirty, agentStatus,         ► { key: value, ... }            ► { port, sessionId }
                   workspaceInfo }                  from git config                  or null
```

Gather-only. No side effects. Wired to IPC handlers by composition root.

---

# Part 3: Module Catalog

**~30 modules.** Each: one responsibility, ~50-200 LOC, independently testable, removable.

## Core Modules

| Module             | Adapted To                                                                                                                                                   | Providers                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| WorkspaceManager   | CreateWs (create, createFailed), DeleteWs (delete)                                                                                                           | GitProvider, FileSystemProvider                            |
| WorkspaceSwitcher  | SwitchWs (switch)                                                                                                                                            | —                                                          |
| ProjectManager     | OpenProject (open, openFailed), CloseProject (close)                                                                                                         | GitProvider, FileSystemProvider, PathProvider              |
| ProjectRegistry    | CreateWs (onFinalized), DeleteWs (onDeleted), OpenProject (onOpened), CloseProject (onClosed), AppLifecycle (gatherState), GetWorkspaceStatus (gatherStatus) | IpcProvider                                                |
| ProjectPersistence | AppLifecycle (onStart, shutdown)                                                                                                                             | ConfigProvider                                             |
| AgentLifecycle     | AppLifecycle (setup, onStart, shutdown), CreateWs (gatherOptions, onCreated), DeleteWs (prepare), RestartAgent (restart, onRestarted)                        | ProcessProvider, HttpProvider, ConfigProvider, IpcProvider |
| AgentStatusTracker | AgentStatusChanged (gatherState, onStatusChanged), AppLifecycle (gatherState), GetAgentSession (gatherSession)                                               | HttpProvider, IpcProvider                                  |

## View/UI Modules

| Module                  | Adapted To                                         | Providers                     |
| ----------------------- | -------------------------------------------------- | ----------------------------- |
| WindowSetup             | AppLifecycle (onStart, shutdown)                   | WindowProvider, ImageProvider |
| WindowTitleUpdater      | SwitchWs (onSwitched)                              | WindowProvider                |
| ViewLifecycle           | CreateWs (onCreated), DeleteWs (prepare)           | ViewProvider, SessionProvider |
| ViewActivation          | SwitchWs (onSwitched)                              | ViewProvider, IpcProvider     |
| WorkspaceLoadingTracker | CreateWs (onCreated, onFinalized)                  | ViewProvider                  |
| SessionConfigurator     | CreateWs (onCreated)                               | SessionProvider               |
| ShortcutHandler         | AppLifecycle (onStart), EnterShortcutMode (enter)  | ViewProvider, IpcProvider     |
| UiModeManager           | EnterShortcutMode (enter), ChangeViewMode (change) | ViewProvider                  |
| CreateWsDialog          | CreateWs (gatherUserChoice)                        | IpcProvider                   |
| OpenProjectDialog       | OpenProject (gatherUserChoice)                     | IpcProvider                   |

## Infrastructure Modules

| Module           | Adapted To                                                | Providers                                                                         |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| CodeServerRunner | AppLifecycle (onStart, shutdown), CreateWs (gatherConfig) | ProcessProvider, PortProvider, PathProvider, DownloadProvider, FileSystemProvider |
| PluginBridge     | AppLifecycle (onStart, shutdown), CreateWs (gatherConfig) | HttpProvider                                                                      |
| McpServer        | AppLifecycle (onStart, shutdown), CreateWs (gatherConfig) | HttpProvider, PortProvider                                                        |

## Utility Modules

| Module                   | Adapted To                                                                                    | Providers                                  |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| WorkspaceFileGen         | CreateWs (finalize)                                                                           | FileSystemProvider                         |
| KeepfilesManager         | CreateWs (gatherOptions, finalize)                                                            | FileSystemProvider                         |
| ProcessKiller            | DeleteWs (prepare)                                                                            | ProcessProvider                            |
| BadgeUpdater             | AgentStatusChanged (onStatusChanged)                                                          | AppProvider, ImageProvider, WindowProvider |
| TelemetryTracker         | CreateWs (onFinalized), DeleteWs (onDeleted), OpenProject (onOpened), CloseProject (onClosed) | ConfigProvider, HttpProvider               |
| WorkspaceMetadataManager | CreateWs (finalize), SetWsMeta (set, onSet), GetWorkspaceMetadata (gatherMetadata)            | GitProvider, IpcProvider                   |
| BranchPreferenceCache    | CreateWs (onFinalized), OpenProject (onOpened)                                                | ConfigProvider                             |
| OrphanedWorkspaceCleaner | OpenProject (onOpened)                                                                        | GitProvider, FileSystemProvider            |
| AutoUpdater              | AppLifecycle (onStart)                                                                        | LoggingProvider                            |

**Use case transitions (typed dispatcher calls in invoke()):**

- CreateWorkspace → `dispatcher.switchWorkspace({ path })` (if !keepInBackground)
- DeleteWorkspace → `dispatcher.switchWorkspace({ next })` (if isActive && !skipSwitch)

**Notes:**

- ProcessKiller: optional, platform-specific, removable.
- AgentLifecycle: manages agent server processes (start, stop, restart). Triggers AgentStatusChanged via callback wired by composition root.
- AgentStatusTracker: composes SSE client, aggregates status across workspaces. Provides data for query use cases (GetAgentSession).
- Agent config (MCP_PORT, PLUGIN_PORT): flows through `gatherConfig` phase — McpServer/PluginBridge provide ports, AgentLifecycle receives them in the `onCreated` event context.
- **IPC is provider-based**: no centralized IPC module. IpcProvider supports three modes: `send()` for notifications (one-way push), `request()` for dialogs (round-trip, await response), and trigger registration (wired by composition root). Modules that need to notify the renderer call `ipc.send()`. Dialog modules that need user input call `ipc.request()`.
- **Dialog modules** (CreateWsDialog, OpenProjectDialog): per-dialog modules that implement Interact phases. Each calls `ipcProvider.request()` to show a dialog in the renderer and await the user's choice. Needed because gather phases run first to collect options/config, so the renderer can't pre-fill.
- WorkspaceMetadataManager: saves base branch to git config during CreateWs finalize. Currently embedded in GitWorktreeProvider — extract during refactoring.
- **Triggers have two sources**: IPC messages from renderer AND plugin API calls from extensions. Both trigger the same use cases. PluginBridge module handles infrastructure (start/stop Socket.IO), plugin call handlers are registered as triggers in the composition root alongside IPC triggers.
- ShortcutHandler: owns key input state machine (Alt+X detection, key dispatch). Registers keyboard listeners on workspace views. Currently `shortcut-controller.ts`.
- WorkspaceLoadingTracker: tracks per-workspace loading state (created → loaded). Marked loaded when MCP first request arrives or code-server signals ready.
- SessionConfigurator: configures Electron session permissions (clipboard, media, etc.) per workspace view. Currently embedded in ViewManager.createWorkspaceView().
- WindowTitleUpdater: updates window title on workspace switch and when update is available. Currently in api-handlers.ts.
- BranchPreferenceCache: caches last-used base branch per project. Currently `lastBaseBranches` map in AppState.
- OrphanedWorkspaceCleaner: cleans up orphaned worktree directories on project open. Currently fire-and-forget in `git-worktree-provider.ts`.

---

# Part 4: How Challenges Are Solved

| Challenge                   | Before                                      | After                                                                      |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Circular deps               | `AppState.setAgentStatusManager()`          | Modules depend only on providers                                           |
| Strict ordering             | 700-line `startServices()`                  | Registration order = execution order                                       |
| Large classes               | AppState 739 LOC, CoreModule 1060 LOC       | ~20 modules, each ~50-200 LOC                                              |
| Two coordination mechanisms | Kernel hooks + small interfaces             | One concept: use case interfaces                                           |
| Deletion saga               | Complex saga in CoreModule                  | Generic phases: prepare -> delete -> onDeleted                             |
| Platform-specific logic     | Process killing mixed into deletion         | ProcessKiller: adapted to `prepare`, removable                             |
| Adding new behavior         | Change interfaces + wiring                  | Add adapter factory to module file + register in composition root          |
| Cross-module data           | ViewManager needs ports, Agent needs config | Gather phases: modules provide data, use case logic passes it to consumers |

---

# Part 5: Testing

Follows existing behavioral testing strategy (docs/TESTING.md). Two levels:

**Use case integration tests** — test through `dispatcher.*()` entry point, behavioral provider mocks:

```typescript
// create-workspace.integration.test.ts
describe("CreateWorkspace", () => {
  let dispatcher: Dispatcher
  let gitMock: MockGitClient
  let fsMock: MockFileSystemLayer

  beforeEach(() => {
    gitMock = createGitClientMock({
      repositories: new Map([["/project", { branches: ["main"], worktrees: [] }]]),
    })
    fsMock = createFileSystemMock()
    // Real use cases + modules, behavioral provider mocks
    dispatcher = createTestDispatcher({ gitClient: gitMock, fileSystem: fsMock })
  })

  it("creates workspace with worktree and files", async () => {
    const result = await dispatcher.createWorkspace({
      projectPath: "/project", name: "feature-1", baseBranch: "main",
    })

    expect(result.name).toBe("feature-1")
    expect(gitMock).toHaveWorktree("feature-1")          // behavioral assertion
    expect(fsMock).toHaveFile("/project/.worktrees/feature-1/.code-workspace")
  })

  it("switches to new workspace after creation", async () => {
    await dispatcher.createWorkspace({
      projectPath: "/project", name: "feature-1", baseBranch: "main",
    })
    // Assert behavior, not that switchWorkspace was "called"
    expect(viewMock).toHaveActiveView("/project/.worktrees/feature-1")
  })

  it("rolls back worktree on creation failure", async () => {
    fsMock.$.simulateError("/project/.worktrees/feature-1", "EIO")
    const snapshot = gitMock.$.snapshot()

    await expect(dispatcher.createWorkspace({ ... })).rejects.toThrow()
    expect(gitMock).toBeUnchanged(snapshot)  // no leftover worktree
  })
})
```

**Module tests** — test domain methods directly, behavioral provider mocks:

```typescript
// keepfiles-manager.integration.test.ts
describe("KeepfilesManager", () => {
  it("copies keepfiles to new workspace", async () => {
    const fs = createFileSystemMock({
      files: new Map([
        ["/project/.keepfiles", "*.env\n.vscode/"],
        ["/project/.env", "SECRET=123"],
        ["/project/.vscode/settings.json", "{}"],
      ]),
    });
    const mgr = new KeepfilesManager(fs);

    await mgr.copyKeepfiles({ projectPath: "/project", workspacePath: "/ws/feature-1" });

    expect(fs).toHaveFile("/ws/feature-1/.env"); // behavioral
    expect(fs).toHaveFileContaining("/ws/feature-1/.env", "SECRET=123");
    expect(fs).toHaveFile("/ws/feature-1/.vscode/settings.json");
  });
});
```

**Adapter factory tests** are not needed separately — use case integration tests exercise the full chain (adapter → module → provider mock). Adapter factories are trivial mappings; bugs in them surface as use case test failures.

All tests: integration tests with behavioral mocks (state-mock pattern), <50ms per test. No `vi.fn()` call-tracking. Assert outcomes, not calls.

---

# Part 6: Verification

1. `pnpm test` — all existing tests pass
2. `pnpm test:integration` — new tests for each module + use case logic
3. `pnpm dev` — manual smoke test:
   - Open a project
   - Create workspace -> verify dialog, agent starts, files copied
   - Delete workspace -> verify ordered cleanup
   - Remove an adapter registration from a use case -> verify app still boots

---

# Part 7: Naming Conventions

| Concept             | Pattern                        | Examples                             |
| ------------------- | ------------------------------ | ------------------------------------ |
| Provider            | `*Provider`                    | `FileSystemProvider`, `GitProvider`  |
| Use case class      | `<Verb><Noun>`                 | `CreateWorkspace`, `DeleteWorkspace` |
| Use case method     | `invoke()`                     | `createWs.invoke(input)`             |
| Module class        | Descriptive name               | `WorkspaceManager`, `ViewLifecycle`  |
| Gather phase        | `gather*`                      | `gatherOptions`, `gatherUserChoice`  |
| Execute phase       | `<verb>`                       | `create`, `delete`, `switch`, `open` |
| Error phase         | `<verb>Failed`                 | `createFailed`, `deleteFailed`       |
| React phase         | `on<Verb>ed`                   | `onCreated`, `onDeleted`             |
| Finalize phase      | `finalize`                     | `finalize`                           |
| Notify phase        | `on<Phase>`                    | `onFinalized`, `onSwitched`          |
| Gather config phase | `gatherConfig` / `gatherState` | `gatherConfig()`, `gatherState()`    |

---

# Part 8: Decisions

## Decided

- **Use case = class with typed I/O** — `invoke(input): Promise<output>`. Phase declarations + orchestration logic.
- **Dispatcher** — typed interface with one method per use case. All triggers and transitions go through it. Fully typed input/output — no string dispatch. Fire-and-forget = don't await.
- **Explicit transitions** — running use case calls `dispatcher.switchWorkspace(data)` in its own `invoke()`. Fully typed, no hidden registrations. You can read `invoke()` and see the complete flow.
- **Co-located adapters** — adapter factories exported alongside module class in same file. Map domain methods → use case phases. Module logic and adaptation logic separated but co-located. Always used, not optional.
- **UseCase base class** — handles registration + phase dispatch based on declared phase types
- **Explicitly declared phase types** — gather, interact, execute, error, react, finalize, notify
- **Generic lifecycle phases** — `finalize()` not `copyKeepfiles()`. Interface never changes when adding modules.
- **Modules are plain classes** — domain method names, depend only on providers, no use case interface coupling
- **One-way dependency** — `invoke()` dispatches to adapters → modules, never the reverse
- **Error phases** — `createFailed`, `deleteFailed` for cleanup on error
- **User interaction as a phase** — `gatherUserChoice` implemented by per-dialog modules
- **IPC has three modes** — triggers (inbound, routed through dispatcher), notifications (`ipc.send()`, one-way push), dialogs (`ipc.request()`, round-trip await)
- **Per-dialog modules** — each Interact phase has its own dialog module (CreateWsDialog, OpenProjectDialog). Needed because gather phases collect data before the dialog is shown.
- **~10 use cases** — list is extensible, adding a use case = define class + register adapters in composition root
- **IPC is a provider** — modules receive IpcProvider to communicate with renderer. No centralized IPC module.
- **Pull-based queries are use cases** — simple gather-only use cases wired to IPC handlers.
- **Notify phases are non-blocking** — fire-and-forget, errors isolated
- **Flat modules** — ~50-200 LOC, single responsibility
- **ProcessKiller is standalone** — optional, platform-specific, removable
- **Config is a Provider** — stateless load/save
- **Registration order = execution order** — within each phase

## Deferred to Implementation

- UseCase base class implementation (phase slot creation, registration, dispatch)
- Exact TypeScript typing for phase declarations
- IPC channel name mapping
- Provider interface renames (`*Layer` -> `*Provider`) — incremental
- Directory renames: `src/services/` → `src/providers/`, `src/agents/` → `src/providers/agents/`
- Renderer changes (if any)

---

# Part 9: Migration Path

## Coexistence Strategy

The existing `ApiRegistry` is the migration seam. Currently:

```
IPC → ApiRegistry → CoreModule.method() → AppState → services
```

After migrating a use case:

```
IPC → ApiRegistry → dispatcher.createWorkspace(payload) → modules → providers
```

**Per-method migration:**

1. Remove `this.api.register(path, handler)` from old module (CoreModule/UiModule)
2. Create new use case class + module(s) with same logic
3. Add use case to Dispatcher interface + `createDispatcher()` factory
4. Wire IPC trigger to typed dispatcher method in bootstrap
5. Method path is still registered once, just by a different owner

ApiRegistry doesn't care who registers — a `CoreModule`, a use case trigger, or bare code. The only rule: each method path registered exactly once (throws on duplicates = safety net).

**IPC channels never change. Renderer sees no difference. Tests keep passing at every step.**

---

## Phase 0: Foundation

**Goal:** Create UseCase base class and Dispatcher type. No existing code changes.

**Create:**

- `src/main/use-cases/base.ts` — UseCase abstract base class (phase declarations, registration, dispatch)
- `src/main/use-cases/dispatcher.ts` — Dispatcher typed interface + `createDispatcher()` factory
- `src/main/use-cases/base.test.ts` — Tests for phase dispatch behavior (gather merges, execute sequential, notify fire-and-forget)

**Risk:** Zero — new files only, nothing existing touched.

---

## Phase 1: Test Balloon — Metadata Use Cases

**Goal:** Validate the entire pattern end-to-end with the smallest possible scope.

**Why metadata:** One module (`WorkspaceMetadataManager`), two use cases, ~100 LOC currently embedded in `git-worktree-provider.ts`. Pure data operations (git config read/write). No ViewManager, no agent lifecycle, no side effects.

**What gets validated:**

- UseCase base class works (phase dispatch)
- Dispatcher typed interface works (dispatcher.setWorkspaceMetadata(), dispatcher.getWorkspaceMetadata())
- Module registration works
- IPC trigger wiring through dispatcher works (SetWorkspaceMetadata)
- Query use case pattern works (GetWorkspaceMetadata)
- Coexistence with old code works (CoreModule still handles everything else)

**Create:**

- `src/main/modules/workspace-metadata-manager.ts` — Module: `set()`, `onSet()`, `gatherMetadata()`. Providers: GitProvider, IpcProvider
- `src/main/use-cases/set-workspace-metadata.ts` — Use case: set → onSet
- `src/main/use-cases/get-workspace-metadata.ts` — Query use case: gatherMetadata

**Modify:**

- `src/main/modules/core/index.ts` — Remove `workspaceSetMetadata()` + `workspaceGetMetadata()` methods and their `api.register()` calls
- `src/main/index.ts` (or bootstrap) — Create use cases + module, register IPC triggers

**These two use cases can be developed in parallel** (independent methods).

---

## Phase 2: More Query Use Cases

**Goal:** Validate pattern with different dependency shapes. All read-only.

| Use Case           | Current Location | Module                                                   |
| ------------------ | ---------------- | -------------------------------------------------------- |
| GetWorkspaceStatus | CoreModule       | ProjectRegistry (wraps AppState project/workspace state) |
| GetAgentSession    | CoreModule       | AgentStatusTracker (wraps AgentStatusManager)            |

**Modify:** CoreModule (remove 2 more methods)

**Can be developed in parallel** with each other (independent methods).

---

## Phase 3: Simple Mutation Use Cases

**Goal:** Migrate small write operations. Validates execute + notify pattern.

| Use Case           | Current Location | Module(s)                         |
| ------------------ | ---------------- | --------------------------------- |
| RestartAgentServer | CoreModule       | AgentLifecycle                    |
| EnterShortcutMode  | UiModule         | ShortcutHandler, UiModeManager    |
| ChangeViewMode     | UiModule         | UiModeManager                     |
| SwitchWorkspace    | UiModule         | WorkspaceSwitcher, ViewActivation |

**After this phase:** UiModule is empty → **delete it**.

**Parallelism:** All four use cases are independent. RestartAgentServer can run in parallel with the three UI use cases.

---

## Phase 4: Core Operations

**Goal:** Migrate the two most complex use cases that decompose CoreModule.

**4a: CreateWorkspace** — The most complex use case.

- Extracts: WorkspaceManager, KeepfilesManager, WorkspaceFileGen, WorkspaceMetadataManager (finalize), ViewLifecycle, AgentLifecycle (onCreated), ProjectRegistry (onFinalized), TelemetryTracker
- Currently ~50 LOC in CoreModule + orchestration spread across AppState

**4b: DeleteWorkspace** — Second most complex.

- Extracts: ProcessKiller, WorkspaceManager (delete), ViewLifecycle (prepare), AgentLifecycle (prepare), ProjectRegistry (onDeleted), TelemetryTracker
- Currently ~300 LOC `executeDeletion()` in CoreModule with progress reporting
- Calls `dispatcher.switchWorkspace()` for transition — SwitchWorkspace already migrated in Phase 3

**4c: OpenProject / CloseProject**

- Extracts: ProjectManager, ProjectRegistry, ProjectPersistence, OrphanedWorkspaceCleaner, BranchPreferenceCache, TelemetryTracker

**After this phase:** CoreModule is empty → **delete it**.

**Parallelism:** 4a and 4b can run in parallel. 4c is independent of both.

---

## Phase 5: AppLifecycle + Composition Root

**Goal:** Replace `startServices()` / shutdown with AppLifecycle use case. Extract composition root from index.ts.

**5a: AppLifecycle use case**

- Phases: gatherState, setup, onStart, shutdown
- Modules register for onStart (CodeServerRunner, PluginBridge, McpServer, AgentLifecycle, WindowSetup, ProjectPersistence, AutoUpdater) and shutdown (reverse order)
- Replaces the 400-line `startServices()` function and shutdown sequence in index.ts

**5b: Composition Root**

- Create `src/main/composition-root.ts`
- Move all provider creation, use case creation, module creation, registration from index.ts
- index.ts becomes thin: `app.whenReady().then(compositionRoot.boot)`

**5c: AppState Decomposition**

- AppState responsibilities split into modules that are already extracted:
  - ProjectRegistry (project/workspace state) — already a module from Phase 2-4
  - AgentLifecycle + AgentStatusTracker — already modules from Phase 3-4
  - Remaining AppState logic absorbed into composition root or small focused services
- **Delete `app-state.ts`**

**After this phase:** index.ts is ~100 LOC. AppState is gone. startServices() is gone.

---

## Phase 6: Lifecycle Module + Final Cleanup

**Goal:** Migrate the two-phase bootstrap (LifecycleModule) and clean up.

- LifecycleModule stays longest because it manages the setup flow (preflight, agent selection) that runs before other modules
- Migrate setup/startServices to AppLifecycle `setup` phase
- AgentStatusChanged use case (wired via callback from AgentStatusTracker)
- Remove ApiRegistry module system (`IApiModule` interface) — use cases handle everything
- Rename `src/services/` → `src/providers/`, move `src/agents/` → `src/providers/agents/`
- Provider interface renames (`*Layer` → `*Provider`) — incremental, no behavior change

---

## Monolith Decomposition Timeline

| Monolith                | Shrinks During                                   | Deleted After                  |
| ----------------------- | ------------------------------------------------ | ------------------------------ |
| CoreModule (1,059 LOC)  | Phase 1-4 (methods extracted one by one)         | Phase 4                        |
| UiModule (170 LOC)      | Phase 3 (all methods extracted)                  | Phase 3                        |
| AppState (738 LOC)      | Phase 2-5 (responsibilities absorbed by modules) | Phase 5                        |
| index.ts (1,226 LOC)    | Phase 5 (composition root extracted)             | Stays as thin entry (~100 LOC) |
| ViewManager (1,054 LOC) | Not in this migration (it's a provider)          | Future refactor                |

## Parallel Work Summary

```
Phase 0  ─────────────────────────────────────────────  (foundation, sequential)
Phase 1  ──┬── SetWorkspaceMetadata                     (test balloon)
            └── GetWorkspaceMetadata
Phase 2  ──┬── GetWorkspaceStatus                       (queries)
            └── GetAgentSession
Phase 3  ──┬── RestartAgentServer ──┐                   (simple mutations)
            ├── EnterShortcutMode   ├── delete UiModule
            ├── ChangeViewMode     ─┘
            └── SwitchWorkspace
Phase 4  ──┬── CreateWorkspace ─────┐                   (core operations)
            ├── DeleteWorkspace     ├── delete CoreModule
            └── OpenProject/Close ──┘
Phase 5  ──── AppLifecycle → Composition Root → delete AppState
Phase 6  ──── LifecycleModule migration → final cleanup
```

Phases 1-3 are small, safe, and fast. Phase 4 is the heavy lift. Phase 5-6 is structural cleanup.

---

## Post-Migration src/ Layout

```
src/
├── main/
│   ├── index.ts                          # Thin entry: app.whenReady → compositionRoot.boot (~100 LOC)
│   ├── composition-root.ts               # Creates providers, use cases, dispatcher, modules. Wires everything.
│   │
│   ├── use-cases/
│   │   ├── base.ts                       # UseCase abstract base class (phase declarations, registration, dispatch)
│   │   ├── base.test.ts                  # Phase dispatch behavior tests
│   │   ├── dispatcher.ts                 # Dispatcher typed interface + createDispatcher() factory
│   │   ├── create-workspace.ts           # CreateWorkspace use case
│   │   ├── delete-workspace.ts           # DeleteWorkspace use case
│   │   ├── switch-workspace.ts           # SwitchWorkspace use case
│   │   ├── open-project.ts              # OpenProject use case
│   │   ├── close-project.ts             # CloseProject use case
│   │   ├── set-workspace-metadata.ts    # SetWorkspaceMetadata use case
│   │   ├── get-workspace-metadata.ts    # GetWorkspaceMetadata query use case
│   │   ├── get-workspace-status.ts      # GetWorkspaceStatus query use case
│   │   ├── get-agent-session.ts         # GetAgentSession query use case
│   │   ├── restart-agent-server.ts      # RestartAgentServer use case
│   │   ├── enter-shortcut-mode.ts       # EnterShortcutMode use case
│   │   ├── change-view-mode.ts          # ChangeViewMode use case
│   │   ├── agent-status-changed.ts      # AgentStatusChanged use case
│   │   └── app-lifecycle.ts             # AppLifecycle use case
│   │
│   ├── modules/
│   │   ├── workspace-manager.ts          # create, createFailed, delete
│   │   ├── workspace-switcher.ts         # switch
│   │   ├── workspace-metadata-manager.ts # set, onSet, gatherMetadata, finalize(create)
│   │   ├── workspace-file-gen.ts         # finalize(create)
│   │   ├── workspace-loading-tracker.ts  # onCreated, onFinalized
│   │   ├── project-manager.ts            # open, openFailed, close
│   │   ├── project-registry.ts           # onFinalized, onDeleted, onOpened, onClosed, gatherState, gatherStatus
│   │   ├── project-persistence.ts        # onStart, shutdown
│   │   ├── agent-lifecycle.ts            # setup, onStart, shutdown, gatherOptions, onCreated, prepare, restart, onRestarted
│   │   ├── agent-status-tracker.ts       # gatherState, onStatusChanged, gatherSession
│   │   ├── window-setup.ts              # onStart, shutdown
│   │   ├── window-title-updater.ts      # onSwitched
│   │   ├── view-lifecycle.ts            # onCreated(create), prepare(delete)
│   │   ├── view-activation.ts           # onSwitched
│   │   ├── session-configurator.ts      # onCreated(create)
│   │   ├── shortcut-handler.ts          # onStart, enter
│   │   ├── ui-mode-manager.ts           # enter(shortcut), change(viewMode)
│   │   ├── create-ws-dialog.ts          # gatherUserChoice(create)
│   │   ├── open-project-dialog.ts       # gatherUserChoice(open)
│   │   ├── code-server-runner.ts        # onStart, shutdown, gatherConfig
│   │   ├── plugin-bridge.ts             # onStart, shutdown, gatherConfig
│   │   ├── mcp-server.ts               # onStart, shutdown, gatherConfig
│   │   ├── keepfiles-manager.ts         # gatherOptions, finalize(create)
│   │   ├── process-killer.ts            # prepare(delete)
│   │   ├── badge-updater.ts             # onStatusChanged
│   │   ├── telemetry-tracker.ts         # onFinalized, onDeleted, onOpened, onClosed
│   │   ├── branch-preference-cache.ts   # onFinalized(create), onOpened
│   │   ├── orphaned-workspace-cleaner.ts # onOpened
│   │   └── auto-updater.ts             # onStart
│   │
│   ├── api/                              # UNCHANGED — ApiRegistry stays as IPC routing layer
│   │   ├── registry.ts
│   │   ├── registry-types.ts
│   │   ├── wire-plugin-api.ts
│   │   ├── workspace-conversion.ts
│   │   └── id-utils.ts
│   │
│   ├── utils/                            # UNCHANGED
│   │   └── external-url.ts
│   │
│   └── build-info.ts                     # ElectronBuildInfo — provider impl (interface in providers/platform/)
│
├── providers/                            # RENAMED from services/ + agents/
│   ├── platform/                         # Platform providers (fs, process, network, ipc, ...)
│   ├── shell/                            # Shell providers (window, view, session)
│   ├── git/                              # Git provider
│   ├── config/                           # Config provider
│   ├── agents/                           # MOVED from src/agents/ — agent providers
│   │   ├── index.ts                      # Factory: createAgentServerManager(), createAgentProvider()
│   │   ├── types.ts                      # AgentProvider, AgentServerManager, AgentSetupInfo interfaces
│   │   ├── status-manager.ts             # AgentStatusManager (aggregates status across workspaces)
│   │   ├── opencode/                     # OpenCode agent implementation
│   │   │   ├── provider.ts              # OpenCodeProvider (AgentProvider impl)
│   │   │   ├── server-manager.ts        # OpenCodeServerManager (AgentServerManager impl)
│   │   │   ├── client.ts               # SDK client wrapper
│   │   │   ├── setup-info.ts            # Download URLs, config generation
│   │   │   └── ...                      # wrapper, session-utils, types, state-mock
│   │   └── claude/                       # Claude Code agent implementation
│   │       ├── provider.ts              # ClaudeCodeProvider (AgentProvider impl)
│   │       ├── server-manager.ts        # ClaudeCodeServerManager (AgentServerManager impl)
│   │       └── ...                      # wrapper, setup-info, types
│   ├── code-server/                      # → used by CodeServerRunner module
│   ├── plugin-server/                    # → used by PluginBridge module
│   ├── mcp-server/                       # → used by McpServer module
│   ├── keepfiles/                        # → used by KeepfilesManager module
│   ├── project/                          # → used by ProjectManager/ProjectRegistry modules
│   ├── binary-download/                  # Download provider
│   ├── binary-resolution/                # → used during setup
│   ├── vscode-setup/                     # → used during setup
│   ├── vscode-workspace/                 # → used by WorkspaceFileGen module
│   ├── telemetry/                        # → used by TelemetryTracker module
│   ├── logging/                          # Logging provider
│   └── auto-updater.ts                   # → used by AutoUpdater module
├── preload/                              # UNCHANGED
├── renderer/                             # UNCHANGED
├── shared/                               # UNCHANGED
└── test/                                 # UNCHANGED
```

**Deleted files** (absorbed into modules/use-cases):

- `src/main/app-state.ts` — split into ProjectRegistry, AgentLifecycle, AgentStatusTracker modules
- `src/main/modules/core/index.ts` — split into ~15 modules + use cases
- `src/main/modules/ui/index.ts` — split into ShortcutHandler, UiModeManager, WorkspaceSwitcher, ViewActivation modules
- `src/main/modules/lifecycle/index.ts` — absorbed into AppLifecycle use case
- `src/main/bootstrap.ts` — absorbed into composition-root.ts
- `src/main/shortcut-controller.ts` — becomes ShortcutHandler module
- `src/main/ipc/api-handlers.ts` — trigger wiring moves to composition-root.ts
- `src/main/managers/badge-manager.ts` — becomes BadgeUpdater module
- `src/main/managers/view-manager.ts` — becomes ViewLifecycle + ViewActivation + SessionConfigurator modules (ViewLayer provider stays in services/shell/)
- `src/main/managers/window-manager.ts` — becomes WindowSetup + WindowTitleUpdater modules (WindowLayer provider stays in services/shell/)

**Key structural changes:**

- `src/services/` renamed to `src/providers/` — matches architecture terminology
- `src/agents/` moved to `src/providers/agents/` — agent abstractions are providers
- `src/main/modules/` changes from 3 monolith dirs (core/, ui/, lifecycle/) to ~30 flat module files
- `src/main/use-cases/` is new — ~15 use case files + base class + dispatcher
- `src/main/composition-root.ts` is new — extracted from index.ts + bootstrap.ts
- `src/main/index.ts` shrinks from ~1,226 LOC to ~100 LOC
- `src/main/managers/` is deleted — logic moves to modules, provider interfaces stay in providers/shell/
