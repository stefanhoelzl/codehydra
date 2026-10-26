# Agent System Documentation

This document describes the agent integration layer, provider interfaces, and how to implement new agent types.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
  - [AgentModuleProvider](#agentmoduleprovider)
  - [AgentModuleSpec and the core factory](#agentmodulespec-and-the-core-factory)
  - [AgentServerManager](#agentservermanager)
  - [AgentProvider](#agentprovider)
- [Status Flow](#status-flow)
- [MCP Integration](#mcp-integration)
- [OpenCode Implementation](#opencode-implementation)
- [Claude Code Implementation](#claude-code-implementation)
- [Implementing a New Agent](#implementing-a-new-agent)
- [Testing](#testing)

---

## Overview

CodeHydra uses an abstraction layer to support multiple AI coding agents. Everything lives under `src/modules/agent-module/`:

| Component                   | Purpose                                                               | Scope                    |
| --------------------------- | --------------------------------------------------------------------- | ------------------------ |
| `createAgentModule`         | Generic intent module; delegates every hook to an AgentModuleProvider | One per agent type       |
| `AgentModuleProvider`       | Unified per-agent surface (binary, lifecycle, status, sessions)       | One per agent type       |
| `createAgentModuleProvider` | Generic provider-tracking core, parameterized by an `AgentModuleSpec` | One per agent type       |
| `AgentServerManager`        | Server lifecycle (start, stop, restart)                               | Shared across workspaces |
| `AgentProvider`             | Connection and status tracking                                        | One per workspace        |

**Existing implementations:**

- **OpenCode** (`src/modules/agent-module/opencode/`) - SSE client over a dual-stack wire (1.x and 2.x server APIs), one server per workspace
- **Claude Code** (`src/modules/agent-module/claude/`) - HTTP hook server, shared across all workspaces

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│                                                                  │
│  AgentServerManager ──► spawns/tracks agent server(s)            │
│         │                      port stored in memory             │
│         │ onServerStarted(ref, port, ...)                        │
│         ▼                                                        │
│  module-provider core ◄── AgentProvider (status events)          │
│  (registry + status cache)                                       │
│         │                                                        │
│         │ onStatusChange callback (wired by createAgentModule)   │
│         ▼                                                        │
│  Dispatcher.dispatch(agent:update-status intent)                 │
│         │                                                        │
│         │ UpdateAgentStatusOperation emits domain event          │
│         ▼                                                        │
│  agent:status-updated domain event                               │
│         │                                                        │
│         ├──► Presenter (createWorkspaceStatusCache)              │
│         │      folds status into the UiState row, pushes         │
│         │      api:ui:state                                      │
│         │                                                        │
│         └──► Badge / OS-notification modules                     │
│                (createWorkspaceStatusCache(onChange(ref,         │
│                previous, next))): badge, idle notifications      │
│                                                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
═══════════════════════════╪══════════════════════════════════════
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                    RENDERER PROCESS                              │
│                          │                                       │
│  api.onState(UiState) ──► App.svelte (snapshot, props down)      │
│                                            │                     │
│                                            ▼                     │
│  Sidebar.svelte ◄── AgentStatusIndicator (visual indicator)      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Generic agent module

`createAgentModule(provider, deps)` (`src/modules/agent-module/agent-module.ts`) returns an `IntentModule` that is a thin adapter: every hook handler delegates to the `AgentModuleProvider`. One module instance is registered per agent type in the composition root (`src/main.ts`).

| Operation              | Hook Points                               | Responsibility                                             |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `app:start`            | `before-ready`, `check-deps`, `start`     | Script declarations, binary preflight, MCP port capture    |
| `app:ready`            | `available-agents`                        | Report agent availability for the picker                   |
| `app:shutdown`         | `stop`                                    | Dispose provider, cleanup status subscription              |
| `setup`                | `register-agents`, `save-agent`, `binary` | Agent selection UI, config persistence, binary download    |
| `open-workspace`       | `setup`                                   | Start server, wait for provider, prompt plumbing, env vars |
| `delete-workspace`     | `shutdown`                                | Stop server, clear per-workspace tracking                  |
| `hibernate-workspace`  | `shutdown`                                | Best-effort server stop (errors not propagated)            |
| `get-workspace-status` | `get`                                     | Return agent status                                        |
| `get-agent-session`    | `get`                                     | Return session info                                        |
| `restart-agent`        | `restart`                                 | Restart agent server                                       |
| `agent-lifecycle`      | `lifecycle`                               | Terminal open/close transitions (reported by the sidekick) |
| `vscode-modal-changed` | `modal`                                   | Park the workspace on idle while a question is open        |

Provider initialization is lazy: it happens on the first `open-workspace` for the configured agent, using the MCP port captured during `app:start`.

The whole agent runtime — module, module-provider core, server managers, providers — names a workspace by its `WorkspaceRef`, which is also every map key. The path is handed over once, to `startWorkspace`, for what has to run in the workspace's directory (OpenCode's server, its session matching); Claude needs none (its generated files are named after the ref).

### File Structure

```
src/modules/agent-module/
  types.ts                  # Shared interfaces (AgentServerManager, AgentProvider, McpConfig, ...)
  agent-module.ts           # createAgentModule (generic intent adapter)
  agent-module-provider.ts  # AgentModuleProvider interface
  module-provider.ts        # createAgentModuleProvider core + AgentModuleSpec
  status-utils.ts           # Pure status conversion helpers
  opencode/
    setup-info.ts           # Download coordinates (1.x GitHub, 2.x npm) + wire helpers
    server-manager.ts       # OpenCodeServerManager (one server per workspace)
    provider.ts             # OpenCodeProvider (client wrapper + status aggregation)
    client.ts               # OpenCodeClient (wire-agnostic facade)
    wire.ts                 # WireClient seam (calls + normalized events)
    wire-v1.ts              # 1.x wire (@opencode-ai/sdk endpoints)
    wire-v2.ts              # 2.x wire (@opencode/client, /api/*, Basic auth)
    module-provider.ts      # createOpenCodeModuleProvider (spec definition)
    wrapper.ts              # CLI wrapper (redirects to `opencode attach` / `--server`)
  claude/
    setup-info.ts           # Version/URL/sub-path helper functions
    server-manager.ts       # ClaudeCodeServerManager (shared HTTP hook server)
    provider.ts             # ClaudeCodeProvider (env vars + hook subscription)
    module-provider.ts      # createClaudeModuleProvider (spec definition)
    hook-status.ts          # deriveStatus: the hook → status rules, as a pure reducer
    hook-handler.ts         # Hook POST script run by the Claude CLI
    wrapper.ts              # CLI wrapper (session resume, initial prompt)
```

---

## Core Components

### AgentModuleProvider

The unified per-agent surface consumed by the generic module (`agent-module-provider.ts`). Covers identity constants (`type`, `displayName`, `icon`, `scripts`, ...), binary management (`preflight`, `downloadBinary`), lifecycle (`initialize`, `dispose`), per-workspace operations (`startWorkspace`, `stopWorkspace`, `restartWorkspace`, `applyTerminalLifecycle`, `setModalOpen`), queries (`getStatus`, `getSession`), `sendMessage` (deliver a message into the running agent), the cross-workspace `onStatusChange` event, and `clearWorkspaceTracking`.

### AgentModuleSpec and the core factory

`createAgentModuleProvider(spec, deps)` (`module-provider.ts`) implements `AgentModuleProvider` once. It owns the shared machinery:

- per-workspace provider registry and status cache (with change deduplication)
- the open-modal overlay (see [Open Modal Override](#open-modal-override))
- `onServerStarted`/`onServerStopped` wiring, including the restart path (disconnect → reconnect)
- binary preflight/download, delegated to the spec's `AgentBinaryResolver` (`binary-resolver.ts`: pin → system install → latest download; see ARCHITECTURE.md › Binary Distribution), and the per-workspace binary snapshot passed to `startServer` and merged into the terminal env via `binaryEnv`
- disposal

Per-agent behavior is supplied via `AgentModuleSpec<P>` (generic over the concrete provider class):

| Spec member              | Claude                                                              | OpenCode                                                 |
| ------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------- |
| `binary` / `binaryEnv`   | resolver; `_CH_CLAUDE_BIN` (+ `DISABLE_AUTOUPDATER` for a download) | resolver; `_CH_OPENCODE_BIN`                             |
| `createProvider`         | `new ClaudeCodeProvider({serverManager, workspaceRef, logger})`     | `new OpenCodeProvider(ref, path, logger, wireInfo)`      |
| `connectProvider`        | `connect(port)`                                                     | `connect(port)` + `fetchStatus()`                        |
| `initialStatus`          | always `"none"` (status arrives via hooks)                          | derived from `getEffectiveCounts()`                      |
| `onProviderRegistered`   | —                                                                   | queues the pending initial prompt on the primary session |
| `startServer`            | `startServer(ref)`                                                  | `startServer(ref, path, {initialPrompt, ...})`           |
| `afterProviderReady`     | writes prompt file + no-session marker                              | reports the prompt delivered (if accepted)               |
| `applyTerminalLifecycle` | WrapperStart/WrapperEnd via server manager                          | `triggerWrapperStart` / TUI detach                       |
| `wireExtraCallbacks`     | —                                                                   | `setMarkActiveHandler` (TUI-attached tracking)           |
| `clearWorkspaceTracking` | — (no per-workspace tracking)                                       | clears the TUI-attached entry                            |

The initial prompt reaches the agent in memory (Claude: a one-shot temp file named only in the server manager's state), so the agent module also keeps the workspace's `AgentSpec` in the internal `agent.pending-prompt` metadata key until the agent has taken it over — `onInitialPromptDelivered` in `WorkspaceStartOptions`: Claude's first `SessionStart` after the prompt file was written, OpenCode's `afterProviderReady` once the server has accepted the queued prompt. OpenCode queues the prompt (`promptAsync`) on the workspace's primary session — the one the TUI attaches to, so the turn it starts is the one the user watches — and a `workspace:open` never waits for that turn; a refused or failed queue leaves the key in place, so the next open delivers the prompt again. A reopen (startup, wake) that finds the key starts the agent with that prompt as a new workspace (no-session marker included); an unreadable key, or one for another agent, is dropped.

### AgentServerManager

Manages server lifecycle (`types.ts`). One manager handles all workspaces.

```typescript
interface AgentServerManager {
  startServer(workspaceRef: WorkspaceRef, workspacePath: Path): Promise<number>;
  stopServer(workspaceRef: WorkspaceRef): Promise<StopServerResult>;
  restartServer(workspaceRef: WorkspaceRef): Promise<RestartServerResult>;
  onServerStarted(
    cb: (workspaceRef: WorkspaceRef, port: number, ...args: unknown[]) => void
  ): () => void;
  onServerStopped(cb: (workspaceRef: WorkspaceRef, ...args: unknown[]) => void): () => void;
  setMarkActiveHandler(handler: (workspaceRef: WorkspaceRef) => void): void;
  setInitialPrompt?(workspaceRef: WorkspaceRef, config: AgentPromptConfig): Promise<void>; // Claude only
  setNoSessionMarker?(workspaceRef: WorkspaceRef): Promise<void>; // Claude only
  setMcpConfig(config: McpConfig): void;
  dispose(): Promise<void>;
}
```

**Server architecture patterns:**

| Pattern       | Description                                     | Example     |
| ------------- | ----------------------------------------------- | ----------- |
| Per-workspace | Spawn one server process per workspace          | OpenCode    |
| Shared        | Single HTTP server routes requests by workspace | Claude Code |

**Implementation notes:**

- Use `PortManager` to allocate ports
- Implement health checks before firing `onServerStarted`
- Preserve port across restarts when possible
- Handle graceful shutdown with timeouts

### AgentProvider

Per-workspace connection and status tracking (`types.ts`).

```typescript
interface AgentProvider {
  connect(port: number): Promise<void>;
  disconnect(): void; // for restart, preserves session info
  reconnect(): Promise<void>;
  onStatusChange(callback: (status: AgentActivity) => void): () => void;
  getSession(): AgentSessionInfo | null;
  getEnvironmentVariables(): Record<string, string>;
  markActive(): void;
  sendMessage(message: AgentMessage, options: AgentMessageOptions): Promise<void>;
  detachTui?(): void; // only providers with a TUI-attached status gate (OpenCode)
  dispose(): void;
}
```

**Implementation notes:**

- `disconnect()` preserves state for reconnection; `dispose()` is final cleanup
- Status changes should be emitted as soon as they occur
- `getEnvironmentVariables()` provides env vars the sidekick sets for all new terminals
- `sendMessage()` puts `{ text, from }` into the running agent's conversation and resolves
  once the agent took it (sent, not read). It rejects when no agent is reachable within
  `options.waitMs` (0 = now). Claude writes to the session inbox its SessionStart hook
  forwarded (`claude/inbox-message.ts` has the wire format). OpenCode queues it with
  `promptAsync` once the TUI is attached. The `agent:send-message` intent (`agent.message`
  in the registry) drives it, and waking or reopening the agent terminal first is its job.

---

## Status Flow

```
none → idle → busy → idle → ...
 ↑      ↑       ↑      ↑
 │      │       │      └── Work completed
 │      │       └── User submitted prompt
 │      └── Session started, waiting for input
 └── No active session
```

### Status Types

```typescript
/** What a single workspace's agent is doing (aggregated into `AgentStatus` for the app) */
type AgentActivity = "none" | "idle" | "busy";

/** Session info for TUI attachment */
interface AgentSessionInfo {
  readonly port: number;
  readonly sessionId: string;
}
```

### Pending Request Override

For agents like OpenCode, sessions waiting on the user are displayed as "idle" (green indicator) rather than "busy", though OpenCode itself still reports them busy. A session waits on the user for a permission prompt or for a question the user must answer (1.x's `question` tool, 2.x's forms); `OpenCodeClient` normalizes both into `UserRequestEvent`s (`asked` / `resolved`, with a `kind`). The provider tracks `pendingRequests: Map<sessionId, Set<requestId>>`; any pending request makes `getEffectiveCounts()` report idle.

**Event handling (after wire normalization):**

- `permission.asked`, a question/form asked: Adds the request to `pendingRequests`
- `permission.replied`, a question/form answered or dismissed: Removes it from `pendingRequests`
- `session.deleted`: Clears pending requests for that session
- Disconnect: Clears all pending requests (reconnection safety)

The permission names go back to OpenCode 1.1.1 (the older `permission.updated` is ignored). Event normalization — where the two wires' payloads become the same shapes — lives in `wire-v1.ts` / `wire-v2.ts` and is unit-tested there (`normalizeSdkEvent` / `normalizeV2Event`).

### Open Modal Override

A question put to the user blocks the workspace on them, so it reads **idle** while one is open, whatever the agent is doing and even with no agent session. Two sources:

- **`editor`**: a modal in the workspace's editor — an ask dialog, quick pick, input box or file dialog raised through `vscode:show-message` (`ch ws ask|select|input|pick-file`, MCP `ui_ask`…, plugins). A toast (`info`/`warning`/`error`) is not a modal. The sidekick acks every modal only when it is dismissed; the API server counts open modals per workspace from emit until that ack or a socket disconnect, independent of the caller's wait: a call's `timeout` or cancel ends the wait and closes a quick pick or input box (`ui:cancel`), but a dialog or file dialog cannot be closed from code, so it stays counted until dismissed.
- **`sidebar`**: a `notification:show` card attached to the workspace that waits for an answer (`ch ws ask --sidebar`), counted by the presenter's notification hooks until it is answered, dismissed or released.

- **Edges**: each source dispatches its 0↔1 transitions as `vscode:modal-changed { source }` (`createModalEdges`, serialized per workspace), resolved to the workspace's agent module like `agent:lifecycle`, which calls `setModalOpen(ref, source, open)`. Terminal focus is held back only by an `editor` modal.
- **Overlay**: the module-provider core keeps the agent's own status in its cache and reports `idle` while any source has a question open; agent changes made meanwhile are recorded but not reported. Each edge re-reports the effective status unconditionally, so an `agent.status.set` nudge (which bypasses the core) is corrected on the next edge. `getStatus` returns the effective status.
- Parking is ordinary idle: the badge, chime and OS notification follow their usual idle-count rules.

### Background Tasks: Sub-agents and Shells (Claude Code)

The `Stop` hook payload carries `background_tasks` — the live snapshot of still-running
background work, each entry tagged `type: "shell"` or `type: "subagent"`. On every `Stop`
the bridge evaluates it (`taskKeepsBusy`) and, when any qualifies, keeps the workspace
busy instead of going idle:

- A running **sub-agent** (`type: "subagent"`, from an `Agent` tool call with
  `run_in_background`) keeps the workspace busy, unless its `description` starts with
  `[bg]` (`isBackgroundAgentLabel`, `status-utils.ts`). A Stop that goes idle beside `[bg]`
  sub-agents sets `idleBesideBackgroundAgents`, and their hooks (which carry an `agent_id`)
  are ignored until the main agent's next turn, so their tool calls cannot flip it back to
  busy. OpenCode reads the same marker from a child session's title (the task
  description) and keeps the workspace busy while an unmarked child runs; a `[bg]`
  child's descendants are opted out with it.
- A running **shell** (`type: "shell"`, Bash with `run_in_background`) keeps it busy,
  unless its command runs through `ch bg`/`ch-bg` (`isBackgroundWrapped`) or a `[bg]`
  sub-agent started it. The entry names no owner, and the sub-agent has often finished
  before the main agent's `Stop` (which then lists the shell alone), so ownership is
  learned as it happens (`trackBackgroundOwners`, `hook-status.ts`, run before the
  reducer since it learns from sub-agent hooks the reducer ignores): the main agent's
  `PostToolUse` for a background `Agent` call answers `tool_response.agentId`, a `[bg]`
  description opting it out; that sub-agent's `PostToolUse` for a background `Bash` call
  answers `tool_response.backgroundTaskId`, the shell's `background_tasks[].id` (checked
  on 2.1.310). A shell the main agent's `Stop` no longer lists is forgotten. A Stop that
  goes idle beside such a shell also sets `idleBesideBackgroundAgents`: the sub-agent
  resumes when its shell exits.

The decision is stashed to also suppress the `idle_prompt` notification that fires ~60s
after Stop, and cleared when the agent is re-invoked (`UserPromptSubmit`, which fires
automatically when a task finishes) or the session ends. Because the snapshot is re-read
from ground truth on every Stop, no per-sub-agent bookkeeping is needed beyond the shell
owners above — `SubagentStart`/`SubagentStop` are subscribed for logging only and don't
drive status,
and a sub-agent that crashes without reporting completion can't leak (the next empty Stop
is authoritative). `StopFailure` carries no `background_tasks` (it's an API error — rate
limit, auth, max-tokens), so it always transitions to idle to surface the stuck main agent
regardless of background work. `PermissionRequest` → idle is never suppressed.

A `Stop`/`StopFailure` that carries an `agent_id` is a **sub-agent's** turn end (the main
agent's `Stop` has none) and is ignored for the workspace status entirely.

So is a `PreToolUse` that carries an `agent_id`. Besides sub-agents, it comes from the
**prompt-suggestion fork**: after every interactive turn Claude forks a hidden agent to
guess the user's next prompt, and the fork runs the session's hooks, writes no transcript,
and denies every tool it tries — after `PreToolUse`, with nothing following. Taken as the
main agent's, its `AskUserQuestion` parked the workspace idle while background sub-agents
were still working (the park then swallowing their busy signals until the next prompt),
and any tool it tried after an idle `Stop` would trip the `PreToolUse`-while-idle rule with
no `Stop` to follow. Only the main agent's `PreToolUse(AskUserQuestion)` parks, and only its
`PostToolUse`/`PostToolUseFailure(AskUserQuestion)` or its turn-ending `Stop` unparks;
sub-agent tool activity still reaches the status through `PostToolUse`. The `Stop` covers a
question Claude drops without a `PostToolUse` (a message arriving mid-tool can start a second
turn branch that asks it, and the first branch then ends the turn): no question can outlive
the turn, and a `Stop` that lifts a park while background tasks keep the workspace busy goes
busy instead of leaving it parked idle. Pinned against a real TUI by the `suggestionfork`
scenario in `claude/server-manager.boundary.test.ts`.

### Busy→Idle Edge for Untracked Turns (Claude Code)

Bash-mode turns (`!cmd`) emit **only** a `Stop` — no `UserPromptSubmit` and no
`PreToolUse` — so a text-only reply never flips the workspace to busy, and the closing
`Stop` lands on an already-idle workspace with no transition (so the "agent finished"
signal/chime never fires). To surface that a turn happened, a main-agent `Stop` that
arrives while the workspace is already `idle` emits a **synthetic busy→idle edge**: it
sets busy then immediately idle. The status-cache dedup (`module-provider`) treats each
emission as a distinct edge, so both propagate and the finished-signal fires — no timer or
dwell time; the transition is what matters, not how long it stays red. Final status is
idle, so a following real turn proceeds normally. A tool-using bash-mode turn still flips
to busy for real via the `PreToolUse`-while-idle rule.

---

## MCP Integration

Agent servers are configured to connect to CodeHydra's MCP server for workspace API access. The MCP port is captured during `app:start` and passed to the provider via `initialize()`.

### OpenCode MCP Configuration

OpenCode servers receive the MCP config inline via the `OPENCODE_CONFIG_CONTENT` environment variable at spawn time — a local (stdio) server, so `ch mcp` is spawned with everything it needs passed explicitly. 1.x nests servers at the top level of `mcp` with an `enabled` flag; 2.x groups them under `mcp.servers` (its inverse `disabled` defaults to false) and sets `codemode: false` — 2.x otherwise puts an MCP server in Code Mode, where the model gets no `codehydra_*` tools, only a catalog inside its JavaScript `execute` tool:

```jsonc
// 1.x
{
  "mcp": { "codehydra": { "type": "local", "command": ["…", "ch.cjs", "mcp"], "environment": { "…": "…" }, "enabled": true } }
}
// 2.x
{
  "mcp": { "servers": { "codehydra": { "type": "local", "command": ["…", "ch.cjs", "mcp"], "environment": { "…": "…" }, "codemode": false } } }
}
```

The same env var carries the system prompt (`instructions`) and the update policy (`autoupdate: false` in 1.x, `update: "disable"` in 2.x — downloads only; a system install is the user's to manage). `instructions` unions across config sources in both, so a user's own entries survive (pinned by `server-manager.boundary.test.ts` against the real binaries).

### Claude Code MCP Configuration

The server manager generates per-workspace config files (`codehydra-hooks.json`, `codehydra-mcp.json`) from JSON templates with `${VARIABLE}` substitution, stored under `<temp>/claude/configs/<workspace-name>-<ref-hash>/`. The provider exposes their paths via environment variables (`_CH_CLAUDE_SETTINGS`, `_CH_CLAUDE_MCP_CONFIG`).

### CodeHydra System Prompt

Every agent session is given a shipped description of the environment it runs in: busy/idle semantics, worktree lifecycle ownership, where to get help (`ch --help`, `ch guide`, `code <path>`), and operator-driven workspace creation. It is not generated per workspace — `getSystemPromptPath()` on each server manager resolves it from the runtime dir (`runtimePath("bin/...")`, outside the ASAR) exactly like the hook handler.

**Composition.** Sources live in `resources/prompts/`: `shared.md` plus a per-agent appendix. A plugin in `vite.config.bin.ts` concatenates them into `dist/bin/codehydra-prompt-claude.md` and `codehydra-prompt-opencode.md`, alongside the compiled wrappers, and the main build copies `dist/bin` into `assets/bin`. It runs with the wrappers rather than in the main build so that `pnpm build:wrappers` produces it — CI runs that before `pnpm test`, which is what lets a boundary test assert on the shipped artifacts. Composition happens at build rather than launch because Claude accepts exactly one prompt source: `--append-system-prompt-file` is last-wins, and combining it with `--append-system-prompt` is rejected outright. Only Claude gets the `ch-bg` appendix — that wrapper is detectable only in Claude's `background_tasks`; on OpenCode's PATH it just runs the command.

**Delivery.** Claude: the provider passes `_CH_CLAUDE_SYSTEM_PROMPT` and `ch-claude` turns it into `--append-system-prompt-file`. The wrapper treats it as required — a missing variable fails startup like a missing settings path, because a session without it is a broken setup rather than a session with less context. OpenCode: the server manager puts the path in the `instructions` array of `OPENCODE_CONFIG_CONTENT`, which opencode merges last and renders into the system prompt as `Instructions from: <path>`. Opencode unions `instructions` across config sources (since 1.1.1), so a user's own entries survive alongside it; `server-manager.boundary.test.ts` pins that against the real binary.

It is the counterpart of the MCP `SERVER_INSTRUCTIONS`: the system prompt carries what is always true about the environment, the MCP instructions carry cross-tool facts no single tool schema can express. Mechanics documented in a tool's own description are not repeated in either.

### MCP Tools Available to Agents

The MCP server exposes workspace management tools (`workspace.getStatus`, `workspace.getMetadata`, `workspace.setMetadata`, `workspace.delete`, `workspace.create`, `workspace.executeCommand`, ...). See docs/API.md.

### Port Discovery for CLI

The sidekick extension applies the env vars from `getEnvironmentVariables()` to all new terminals:

| Variable                  | Purpose                               |
| ------------------------- | ------------------------------------- |
| `_CH_OPENCODE_PORT`       | OpenCode server port                  |
| `_CH_OPENCODE_SESSION_ID` | OpenCode session ID for attachment    |
| `_CH_OPENCODE_MAJOR`      | Which wire the server speaks (1 or 2) |
| `_CH_OPENCODE_PASSWORD`   | 2.x only: the server's password       |
| `_CH_BRIDGE_PORT`         | Claude hook bridge port               |
| `_CH_WORKSPACE`           | Workspace ref (both agents)           |

The OpenCode wrapper script reads these to redirect `opencode` invocations to the workspace's server — `opencode attach http://127.0.0.1:$PORT --session $SESSION_ID` on 1.x, `opencode --server http://127.0.0.1:$PORT --session $SESSION_ID` on 2.x. The wrapper hands the password to the spawned opencode as `OPENCODE_PASSWORD`, the name the TUI reads. It keeps other local processes off the server; it is no secret from the agent — the agent terminal holds `_CH_OPENCODE_PASSWORD`, and `opencode serve`'s own tool commands inherit `OPENCODE_PASSWORD`.

---

## OpenCode Implementation

OpenCode uses SSE (Server-Sent Events) for real-time status updates. CodeHydra speaks both server APIs — 1.x and 2.x are different contracts (see the [wire seam](#the-wire-seam-1x-vs-2x)) — selected by the resolved binary's major version.

### Server Startup Flow

```
1. startServer(workspaceRef, workspacePath, options) called
2. Allocate port via PortManager
3. Spawn `opencode serve --port N` (cwd = workspace)
   2.x only: a generated per-workspace password is given via OPENCODE_PASSWORD
4. Health check — 1.x: HTTP probe to `/path`; 2.x: authenticated `GET /api/info`
5. Fire onServerStarted(ref, port, pendingPrompt)
6. Provider.connect(port) finds/creates a session and connects the event stream
```

The server manager exposes the result as `getWireInfo(ref)` — `{major, password}` — which the provider reads at `connect()` (to build the client and the terminal environment) and the wrapper reads through `_CH_OPENCODE_MAJOR`/`_CH_OPENCODE_PASSWORD` (to choose its arguments and authenticate). A restart keeps the port and the password: the attached terminal's environment holds both.

### The wire seam (1.x vs 2.x)

All version differences live behind the `WireClient` interface (`opencode/wire.ts`), picked in the client's constructor by the resolved major:

|                 | 1.x (`wire-v1.ts`)                                            | 2.x (`wire-v2.ts`)                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client          | `@opencode-ai/sdk` (its `/v2` subpath is still 1.x wire)      | `@opencode/client`, `/api/*` routes                                                                                                                                                                                                                                                                                                                         |
| Auth            | none                                                          | HTTP Basic, user `opencode`, the per-workspace password                                                                                                                                                                                                                                                                                                     |
| Sessions        | `session.list/status/create/prompt/promptAsync`               | directory-scoped `session.list`, `location`-carrying `session.create`, `session.active`                                                                                                                                                                                                                                                                     |
| Turn completion | `session.prompt` resolves when the turn ends                  | prompt resolves on admission; the wire adds `session.wait` (and `switchAgent`/`switchModel` for a prompt's agent/model, which then stays the session's)                                                                                                                                                                                                     |
| Queued prompts  | `promptAsync`                                                 | `prompt` with `delivery: "queue"`                                                                                                                                                                                                                                                                                                                           |
| MCP readiness   | servers connected at start                                    | servers connect asynchronously, and a session created before one connected misses its tools for ~100 ms after `connected` (measured on 2.1.4). `createSession` and both prompt calls first poll `mcp.list` until `codehydra` leaves `pending` (capped at 15 s): the primary session is created after it, so the initial prompt's turn has CodeHydra's tools |
| Status signal   | `session.status` / `session.idle` events                      | the execution lifecycle: `session.execution.started` → busy, `succeeded`/`failed`/`interrupted` → idle, `retry.scheduled` → busy (verified against a real 2.1.x: a turn emits no `session.status`)                                                                                                                                                          |
| User requests   | `permission.asked/replied`, `question.asked/replied/rejected` | `permission.asked/replied`, and `form.created/replied/cancelled` — what the `question` tool became                                                                                                                                                                                                                                                          |

Both wires normalize to the same `WireEvent` shapes (`normalizeSdkEvent` / `normalizeV2Event`), so `OpenCodeClient`'s session tracking (roots vs subagents), status aggregation and listener surface are version-free. `retry` maps to `busy`; a subagent session's status never flips the workspace — only its user requests surface, correlated through the child→root mapping.

### Event stream

OpenCode sends **unnamed SSE events** (no `event:` prefix) with the event type embedded in the JSON payload. 1.x nests it under `properties`; 2.x under `data`:

```
data: {"type":"session.status","properties":{"sessionID":"...","status":{"type":"busy"}}}   # 1.x
data: {"type":"session.execution.started","data":{"sessionID":"..."}}                       # 2.x
```

**Event types handled (per wire, before normalization):**

| 1.x Event                                | 2.x Event                         | Meaning                             |
| ---------------------------------------- | --------------------------------- | ----------------------------------- |
| `session.status`                         | `session.status` (rare)           | Status changes (idle/busy/retry)    |
| —                                        | `session.execution.started`       | Turn started → busy                 |
| —                                        | `session.execution.*` outcomes    | Turn ended → idle                   |
| —                                        | `session.retry.scheduled`         | Retrying → busy                     |
| `session.created`                        | `session.created`                 | New session (root or subagent)      |
| `session.idle`                           | —                                 | Explicit idle notification          |
| `session.deleted`                        | `session.deleted`                 | Session cleanup                     |
| `permission.asked`                       | `permission.asked`                | Permission request added            |
| `permission.replied`                     | `permission.replied`              | Permission response received        |
| `question.asked`                         | `form.created`                    | A question/form waiting on the user |
| `question.replied` / `question.rejected` | `form.replied` / `form.cancelled` | Answered / dismissed                |

### OpenCode Client Integration

`OpenCodeClient` is wire-agnostic; the wires are injected through a factory for testing:

```typescript
import { wireFactoryMock, createWireClientMock } from "./opencode/wire-client.state-mock";

const client = new OpenCodeClient(
  8080,
  logger,
  { major: 2, password: "…", directory: workspacePath },
  wireFactoryMock(createWireClientMock())
);
```

The real wires are constructed by the default factory (`OpenCodeWireV1` / `OpenCodeWireV2`); their behavior is pinned against real servers in `opencode/client.boundary.test.ts` (1.x lane) and `opencode/client-v2.boundary.test.ts` (2.x lane).

### TUI-Attached Gate

OpenCode status reports `"none"` until the TUI attaches (first MCP request or terminal open). The module provider keeps a `tuiAttachedWorkspaces` set that survives provider recreation across server restarts; terminal close detaches the TUI (`detachTui()`) without stopping the server.

---

## Claude Code Implementation

Claude Code uses a shared HTTP server with a hook-based integration model.

### Architecture

Unlike OpenCode (one server per workspace), Claude Code uses a single HTTP bridge server that handles hook notifications for all workspaces. The workspace is identified by the `workspaceRef` field in the hook payload (the hook handler adds it from `_CH_WORKSPACE`), which is the key the server manager tracks the workspace by.

```
POST /hook/<HookName>
Content-Type: application/json

{ "workspaceRef": "ch::local::/path/to/project::feature-x", "session_id": "..." }
```

### Status Derivation

Status is driven by the Claude CLI's hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, ...) routed through a per-workspace state machine: `deriveStatus()` in `claude/hook-status.ts` is a pure reducer from (flags, current status, hook, payload) to (next status, next flags, effects), and the server manager only applies its result — status callbacks, the startup timer, logging (see `claude/types.ts` for the base hook → status mapping). It also handles compaction, background tasks (sub-agents and shells via the `Stop` payload's `background_tasks`), AskUserQuestion parking, and permission-resolution edge cases. `WrapperStart`/`WrapperEnd` are not accepted over HTTP — they are driven by the sidekick via the `agent:lifecycle` intent (`triggerWrapperLifecycle`). With a non-empty initial prompt, `WrapperStart` reads busy; if no `SessionStart` follows within `STARTUP_BUSY_TIMEOUT_MS` (60s) the workspace goes idle, since Claude fires no hook while a dialog blocks its start (folder trust), and the pending `SessionStart` turns it busy again.

### Session Resumption

The Claude wrapper automatically attempts to resume previous sessions using the `--continue` flag:

1. On launch, checks if user passed `--continue`, `-c`, or `--resume` flags
2. If not, prepends `--continue` to attempt resuming the most recent session for this directory (unless the no-session marker for a brand-new workspace is present)
3. If continuation fails (no session exists), automatically retries without `--continue`
4. This enables seamless session continuity across CodeHydra restarts

**Flag precedence**: If user passes `--resume <session-id>`, it takes precedence over `--continue`. The wrapper detects this and skips adding `--continue` to avoid conflicts.

---

## Implementing a New Agent

### 1. Create setup-info helpers

```typescript
// src/modules/agent-module/my-agent/setup-info.ts
export function getMyAgentUrlForVersion(version, platform, arch): string { ... }
export function getMyAgentBundleDir(pathProvider, version): Path { ... }
```

### 2. Create the server manager and provider

Implement `AgentServerManager` (server lifecycle) and `AgentProvider` (per-workspace connection + status), following the per-workspace (OpenCode) or shared (Claude) pattern.

### 3. Define the module provider spec

```typescript
// src/modules/agent-module/my-agent/module-provider.ts
export function createMyAgentModuleProvider(deps: MyAgentModuleProviderDeps): AgentModuleProvider {
  return createAgentModuleProvider<MyAgentProvider>(
    {
      type: "my-agent",
      configKey: "version.my-agent",
      displayName: "My Agent",
      icon: "rocket",
      serverName: "My Agent",
      scripts: ["ch-my-agent"],
      serverManager: deps.serverManager,
      binary: deps.binary, // createAgentBinaryResolver({ descriptor, ... }) in main.ts
      binaryEnv: (resolved) => ({ _CH_MY_AGENT_BIN: resolved.path }),
      createProvider: (ref) => new MyAgentProvider(ref, deps.logger),
      connectProvider: (provider, port) => provider.connect(port),
      initialStatus: () => "none",
      startServer: (ref, path) => deps.serverManager.startServer(ref, path).then(() => undefined),
      applyTerminalLifecycle: (ref, event, ctx) => { ... },
    },
    { logger: deps.logger, binaryName: "my-agent" }
  );
}
```

### 4. Register in the composition root

In `src/main.ts`, construct the module provider and register a module:

```typescript
const myAgentProvider = createMyAgentModuleProvider({ ... });
dispatcher.registerModule(createAgentModule(myAgentProvider, { dispatcher, logger, agentConfig }));
```

Also extend the `AgentType` union (`src/shared/api-protocol`) — this is an interface change requiring approval (see AGENTS.md, API/IPC Interface Changes).

---

## Testing

### Integration Test Coverage

The primary suites are `claude/module-provider.integration.test.ts` and `opencode/module-provider.integration.test.ts`. They exercise the full `AgentModuleProvider` surface against a stubbed server manager and a `vi.mock`ed provider class, covering:

1. **Identity constants and binary management** (preflight/download)
2. **Server started/stopped callbacks** (first start, restart-reconnect, full stop)
3. **Status change propagation and deduplication**
4. **Session retrieval and environment variables**
5. **Prompt plumbing** (Claude prompt file / OpenCode pending prompt)
6. **Disposal cleanup**

### Testing the OpenCode Client

```typescript
const mockWire = createWireClientMock({
  sessions: [createTestSession({ id: "ses-1", directory: "/test" })],
});
const client = new OpenCodeClient(
  8080,
  SILENT_LOGGER,
  { major: 1, directory: "/test" },
  wireFactoryMock(mockWire)
);
```

See `opencode/wire-client.state-mock.ts` and docs/TESTING.md for conventions. The wires themselves run against real servers in the boundary suites (`client.boundary.test.ts` for 1.x, `client-v2.boundary.test.ts` for 2.x).
