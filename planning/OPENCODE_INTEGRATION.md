---
status: CLEANUP
last_updated: 2024-12-08
reviewers:
  - review-typescript
  - review-electron
  - review-arch
  - review-senior
  - review-testing
  - review-docs
  - review-ui
---

# OPENCODE_INTEGRATION

## Overview

- **Problem**: Users need to see real-time status of OpenCode AI agents running in each workspace. Currently there's no visibility into whether agents are idle, busy, or not running at all.

- **Solution**: Integrate OpenCode agent status monitoring by discovering running OpenCode instances, connecting to their SSE streams, and displaying status indicators in the sidebar.

- **Risks**:
  | Risk | Mitigation |
  |------|------------|
  | Port scanning performance | Filter by process ancestry, cache non-OpenCode ports |
  | SSE connection failures | Auto-reconnect with exponential backoff (1s, 2s, 4s... max 30s) |
  | Multiple OpenCode instances per workspace | Support N instances (N >= 0) per workspace |
  | Code-server not running | Skip scanning when PID is null |
  | Race conditions in scan loop | Prevent overlapping scans with mutex flag |
  | Memory leaks | IDisposable pattern for all resources |

- **Alternatives Considered**:
  | Alternative | Why Rejected |
  |-------------|--------------|
  | Poll HTTP endpoint instead of SSE | Higher latency, more network overhead |
  | Scan all ports without ancestry filter | Too noisy, probes unrelated processes |
  | Use file-based IPC | More complex, SSE already available |
  | Singleton pattern for DiscoveryService | Violates testability and DI principles |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MAIN PROCESS                                       │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                           AppState                                      │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │  - discoveryService: DiscoveryService    (owned, injected)              │   │
│  │  - agentStatusManager: AgentStatusManager (owned, injected)             │   │
│  │  - codeServerManager: CodeServerManager  (existing)                     │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│           │                                                                     │
│           │ owns + injects                                                      │
│           ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                      Main Process Orchestration                         │   │
│  │  ─────────────────────────────────────────────────────────────────────  │   │
│  │  - Polling loop (1s): calls discoveryService.scan()                     │   │
│  │  - Event listener: codeServerManager.onPidChanged → discovery.setPid()  │   │
│  │  - Event listener: agentStatusManager.onStatusChanged → IPC emit        │   │
│  │  - Cleanup: app.on('before-quit') → dispose all services                │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│           │                                                                     │
│           ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │              OpenCode Integration (src/services/opencode/)              │   │
│  │                                                                         │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │  │    DiscoveryService (regular class, NOT singleton)              │   │   │
│  │  │    ─────────────────────────────────────────────────────────    │   │   │
│  │  │    Constructor: (portScanner, processTree, instanceProbe)       │   │   │
│  │  │                                                                 │   │   │
│  │  │    State:                                                       │   │   │
│  │  │    - codeServerPid: number | null                               │   │   │
│  │  │    - activeInstances: Map<WorkspacePath, Set<Port>>             │   │   │
│  │  │    - knownPorts: Map<Port, WorkspacePath>                       │   │   │
│  │  │    - nonOpenCodePorts: Map<Port, {pid: number, timestamp: number}> │  │   │
│  │  │    - scanning: boolean (mutex to prevent overlapping scans)     │   │   │
│  │  │                                                                 │   │   │
│  │  │    Methods:                                                     │   │   │
│  │  │    - setCodeServerPid(pid: number | null): void                 │   │   │
│  │  │    - scan(): Promise<Result<void, DiscoveryError>>              │   │   │
│  │  │    - getPortsForWorkspace(path: WorkspacePath): Set<Port>       │   │   │
│  │  │    - onInstancesChanged(cb): Unsubscribe                        │   │   │
│  │  │    - dispose(): void                                            │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                          │                                              │   │
│  │                          │ notifies via callback                        │   │
│  │                          ▼                                              │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │  │    OpenCodeProvider (per workspace) implements IDisposable      │   │   │
│  │  │    ─────────────────────────────────────────────────────────    │   │   │
│  │  │    - workspacePath: WorkspacePath                               │   │   │
│  │  │    - clients: Map<Port, OpenCodeClient>                         │   │   │
│  │  │                                                                 │   │   │
│  │  │    Responsibility: Manage SSE connections, emit raw events      │   │   │
│  │  │    (Does NOT own status aggregation - that's AgentStatusManager)│   │   │
│  │  │                                                                 │   │   │
│  │  │    For each port (0..N):                                        │   │   │
│  │  │    ┌───────────────────────────────────────────────────────┐   │   │   │
│  │  │    │   OpenCodeClient implements IDisposable               │   │   │   │
│  │  │    │   - Exponential backoff: 1s, 2s, 4s... max 30s        │   │   │   │
│  │  │    │   - AbortSignal support for cancellation              │   │   │   │
│  │  │    │   - Validates SSE data before emitting                │   │   │   │
│  │  │    │   GET /session/status (with timeout)                  │   │   │   │
│  │  │    │   SSE /event                                          │   │   │   │
│  │  │    └───────────────────────────────────────────────────────┘   │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                          │                                              │   │
│  │                          │ emits raw session events                     │   │
│  │                          ▼                                              │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │  │    AgentStatusManager (owns status aggregation)                 │   │   │
│  │  │    ─────────────────────────────────────────────────────────    │   │   │
│  │  │    - providers: Map<WorkspacePath, OpenCodeProvider>            │   │   │
│  │  │    - statuses: Map<WorkspacePath, AggregatedAgentStatus>        │   │   │
│  │  │    - sessionStatuses: Map<SessionId, SessionStatus>             │   │   │
│  │  │                                                                 │   │   │
│  │  │    Methods:                                                     │   │   │
│  │  │    - initWorkspace(path): Promise<Result<void, OpenCodeError>>  │   │   │
│  │  │    - removeWorkspace(path): Promise<void>                       │   │   │
│  │  │    - getStatus(path): AggregatedAgentStatus                     │   │   │
│  │  │    - getAllStatuses(): Map<WorkspacePath, AggregatedAgentStatus>│   │   │
│  │  │    - onStatusChanged(cb): Unsubscribe  ← callbacks, NOT IPC     │   │   │
│  │  │    - dispose(): Promise<void>                                   │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                          │                                                     │
│                          │ callback (NOT direct IPC emission)                  │
│                          ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │    IPC Boundary (src/main/ipc/agent-handlers.ts)                        │   │
│  │    ─────────────────────────────────────────────────────────────────    │   │
│  │    - Subscribes to agentStatusManager.onStatusChanged()                 │   │
│  │    - Emits IPC event: agent:status-changed                              │   │
│  │    - Validates payloads with Zod before sending to renderer             │   │
│  │                                                                         │   │
│  │    Commands (with Zod validation):                                      │   │
│  │    - agent:get-status (AgentGetStatusPayloadSchema)                     │   │
│  │    - agent:get-all-statuses                                             │   │
│  │    - agent:refresh (trigger immediate scan)                             │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
════════════════════════════════════╪═════════════════════════════════════════════
                                    │
┌───────────────────────────────────┼─────────────────────────────────────────────┐
│              RENDERER PROCESS     │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │       api.onAgentStatusChanged() with $effect cleanup                   │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │   agentStatus store (Svelte 5 runes)                                    │   │
│  │   ──────────────────────────────────────────────────────────────────    │   │
│  │   let statuses = $state(new Map<WorkspacePath, AggregatedAgentStatus>())│   │
│  │   let counts = $state(new Map<WorkspacePath, AgentStatusCounts>())      │   │
│  │                                                                         │   │
│  │   Access via .value (Svelte 5 pattern, no .subscribe())                 │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                   │                                             │
│                                   │ reactive binding                            │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │   Sidebar.svelte                                                        │   │
│  │   ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │   │  AgentStatusIndicator                                           │   │   │
│  │   │  - role="status" aria-live="polite"                             │   │   │
│  │   │  - aria-label="Agent status: {tooltip text}"                    │   │   │
│  │   │  - Keyboard accessible tooltip                                  │   │   │
│  │   │  - prefers-reduced-motion support                               │   │   │
│  │   └─────────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
════════════════════════════════════╪═════════════════════════════════════════════
                                    │
┌───────────────────────────────────┼─────────────────────────────────────────────┐
│       OPENCODE INSTANCES (0..N per workspace)                               │   │
│                                   │                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  HTTP API (localhost:{port}) - ONLY localhost allowed                   │   │
│  │                                                                         │   │
│  │  GET /path → { worktree: string, directory: string }                    │   │
│  │  GET /session/status → { sessions: [{ id, status }] }                   │   │
│  │  GET /event (SSE) ◀─────────────────────────────────────────────────────┼───┘
│  │    → event: session.status, session.deleted, session.idle               │
│  └─────────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Dependency Injection (NOT Singleton)

Services are regular classes with constructor injection, owned by AppState:

```typescript
// Good: DI-friendly, testable
class DiscoveryService {
  constructor(
    private readonly portScanner: PortScanner,
    private readonly processTree: ProcessTreeProvider,
    private readonly instanceProbe: InstanceProbe
  ) {}
}

// In AppState
this.discoveryService = new DiscoveryService(portScanner, processTree, probe);
this.agentStatusManager = new AgentStatusManager(this.discoveryService);
```

### Scan Loop Owned by Main Process (NOT Service)

Services are pure - polling is orchestrated by main process:

```typescript
// In main/index.ts
const scanInterval = setInterval(async () => {
  if (!scanning) {
    scanning = true;
    await discoveryService.scan();
    scanning = false;
  }
}, 1000);

app.on("before-quit", () => {
  clearInterval(scanInterval);
  discoveryService.dispose();
  agentStatusManager.dispose();
});
```

### Event-Driven PID Changes (NOT Polling)

```typescript
// CodeServerManager emits event when PID changes
codeServerManager.onPidChanged((pid) => {
  discoveryService.setCodeServerPid(pid);
});
```

### Callback Pattern for Status Updates (NOT Direct IPC)

Services emit via callbacks, IPC wired at boundary:

```typescript
// In service (pure, testable)
class AgentStatusManager {
  private listeners = new Set<StatusChangeCallback>();

  onStatusChanged(callback: StatusChangeCallback): Unsubscribe {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

// At IPC boundary (main/ipc/agent-handlers.ts)
agentStatusManager.onStatusChanged((path, status, counts) => {
  emitEvent("agent:status-changed", { workspacePath: path, status, counts });
});
```

### Process Tree Optimization

Call pidtree ONCE per scan, filter by descendant set:

```typescript
// Efficient: O(1) pidtree call per scan
const descendants = await processTree.getDescendantPids(codeServerPid);
const candidates = ports.filter((p) => descendants.has(p.pid));
```

## UI Design

### Sidebar with Agent Status Indicators

```
┌─────────────────────────────────────┐
│  PROJECTS                           │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 📁 codehydra         [+][×]│ █  │◀── Grey: No agents (idle=0, busy=0)
│  └─────────────────────────────┘    │
│     ├─ 🌿 feature-auth  (main) [×]│ █  │◀── Green: All idle (idle>0, busy=0)
│     └─ 🌿 bugfix-123    (fix)  [×]│ █  │◀── Red pulsing: All busy (idle=0, busy>0)
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 📁 other-project     [+][×]│ █  │◀── Mixed: half red/green (idle>0, busy>0)
│  └─────────────────────────────┘    │
│     └─ 🌿 experiment    (exp)  [×]│ █  │
│                                     │
│  ┌─────────────────────────────────┐│
│  │        Open Project             ││
│  └─────────────────────────────────┘│
└─────────────────────────────────────┘
```

### Indicator States

```
┌──┐
│  │  GREY (opacity: 0.4)  - "No agents running"
└──┘

┌──┐
│██│  GREEN (solid)        - "2 agents idle"
└──┘

┌──┐
│██│  RED (pulsing)        - "1 agent busy"
└──┘

┌──┐
│██│  MIXED (pulsing)      - "1 idle, 2 busy"
│░░│  (top: red via linear-gradient, bottom: green)
└──┘
```

### Accessibility Requirements

- `role="status"` and `aria-live="polite"` for live updates
- `aria-label` with full status text (e.g., "Agent status: 2 idle, 1 busy")
- Keyboard-accessible tooltip (show on focus, not just hover)
- Tooltip dismissible with Escape key
- `prefers-reduced-motion` media query for animations
- Focus ring when parent row is focused

### User Interactions

- **Hover/Focus**: Shows tooltip with count details after 500ms delay
- **Keyboard**: Tab to row, tooltip shows on focus
- **No click action**: Indicator is informational only

## Implementation Steps

### Phase 0: Dependency Approval

- [x] **Step 0.1: User approves dependencies**
  - node-netstat, eventsource, pidtree approved
  - Test: N/A

### Phase 1: Types, Interfaces, and Error Handling

- [x] **Step 1.1: Add OpenCodeError to errors.ts**
  - Add `OpenCodeError extends ServiceError` with `type = "opencode"`
  - Update `SerializedError` type union
  - Update `ServiceError.fromJSON()` deserialization
  - Files: `src/services/errors.ts`
  - Test: Write failing tests first, then implement

- [x] **Step 1.2: Add shared IPC types with branded types**
  - Add `Port` and `WorkspacePath` branded types
  - Add `AgentStatusCounts`, `AggregatedAgentStatus` (discriminated union)
  - Add `AgentStatusChangedEvent` payload type
  - Add IPC channels: `agent:status-changed`, `agent:get-status`, `agent:get-all-statuses`, `agent:refresh`
  - Files: `src/shared/ipc.ts`
  - Test: Type compilation passes

- [x] **Step 1.3: Create OpenCode service types with readonly modifiers**
  - Create types for OpenCode API responses (PathResponse, SessionStatusResponse)
  - Create types for internal service use (SessionStatus discriminated union)
  - Create `IDisposable` interface
  - Create `Result<T, E>` type for error handling
  - All properties use `readonly` modifier
  - Files: `src/services/opencode/types.ts`
  - Test: Type compilation passes

- [x] **Step 1.4: Add type declarations for node-netstat**
  - Create declaration file for untyped dependency
  - Files: `src/services/opencode/node-netstat.d.ts`
  - Test: Type compilation passes

- [x] **Step 1.5: Add Zod schemas for IPC validation**
  - Create `AgentGetStatusPayloadSchema` with `absolutePathSchema`
  - Create `AgentStatusChangedEventSchema` for SSE data validation
  - Files: `src/main/ipc/validation.ts`
  - Test: Write failing tests first, then implement

### Phase 2: Port Scanner and Process Tree

- [x] **Step 2.1: Implement PortScanner interface and NetstatPortScanner**
  - Create interface for testability
  - Implement using node-netstat
  - Return `Result<PortInfo[], ScanError>`
  - Files: `src/services/opencode/port-scanner.ts`
  - Test: Write failing tests first (happy path + error cases)

- [x] **Step 2.2: Implement ProcessTreeProvider interface and PidtreeProvider**
  - Create interface for testability
  - Implement using pidtree
  - Return `Promise<Set<number>>` of descendant PIDs
  - Single call returns all descendants (not per-port)
  - Files: `src/services/opencode/process-tree.ts`
  - Test: Write failing tests first (happy path + error cases)

### Phase 3: HTTP Utilities and Instance Probe

- [x] **Step 3.1: Extract shared HTTP utility**
  - Create `fetchWithTimeout()` utility
  - Support AbortSignal for cancellation
  - Configurable timeout (default 5000ms)
  - Files: `src/services/platform/http.ts`
  - Test: Write failing tests first (success, timeout, abort)

- [x] **Step 3.2: Implement InstanceProbe interface and HttpInstanceProbe**
  - Create interface for testability
  - HARD-CODE `localhost` restriction (security)
  - Use `fetchWithTimeout` utility
  - Add type guards to validate response structure
  - Return `Result<WorkspacePath, ProbeError>`
  - Files: `src/services/opencode/instance-probe.ts`
  - Test: Write failing tests first (success, timeout, invalid response, non-localhost rejection)

### Phase 4: Discovery Service

- [x] **Step 4.1: Implement DiscoveryService core logic**
  - Regular class with constructor DI (NOT singleton)
  - Implement caches with TTL-based cleanup (5 min for nonOpenCodePorts)
  - Implement `setCodeServerPid()` - clears caches on PID change
  - Implement `getPortsForWorkspace()`
  - Implement callback-based `onInstancesChanged()`
  - Files: `src/services/opencode/discovery-service.ts`
  - Test: Write failing tests first for cache logic

- [x] **Step 4.2: Implement DiscoveryService scan method**
  - Implement `scan(): Promise<Result<void, DiscoveryError>>`
  - Use mutex flag to prevent overlapping scans
  - Call pidtree ONCE, filter by descendant set
  - Skip nonOpenCodePorts (with PID check for port reuse)
  - Probe new ports, update caches
  - Notify listeners on changes
  - Files: `src/services/opencode/discovery-service.ts`
  - Test: Write failing tests first (filtering, caching, cleanup, concurrent scan prevention, PID change)

### Phase 5: OpenCode Client

- [x] **Step 5.1: Implement OpenCodeClient HTTP methods**
  - Implement `getSessionStatuses(): Promise<Result<SessionStatus[], OpenCodeError>>`
  - Use `fetchWithTimeout` with AbortSignal support
  - Add type guards to validate response
  - Files: `src/services/opencode/opencode-client.ts`
  - Test: Write failing tests first (success, timeout, malformed JSON, invalid structure)

- [x] **Step 5.2: Implement OpenCodeClient SSE connection**
  - Implement `connect()` / `disconnect()` lifecycle
  - Implement IDisposable with proper cleanup
  - Exponential backoff reconnection: 1s, 2s, 4s... max 30s
  - Reset backoff on successful connection
  - Stop reconnecting after `dispose()`
  - Validate SSE event data with type guards before emitting
  - Support AbortSignal for cancellation
  - Files: `src/services/opencode/opencode-client.ts`
  - Test: Write failing tests first with mock EventSource (lifecycle, reconnection, backoff, cleanup, event parsing, malformed events)

### Phase 6: OpenCode Provider

- [x] **Step 6.1: Implement OpenCodeProvider**
  - Implement constructor with DiscoveryService dependency
  - Implement IDisposable with proper client cleanup
  - Support lazy initialization (connect on first access)
  - Emit raw session events (NOT aggregated status)
  - Files: `src/services/opencode/opencode-provider.ts`
  - Test: Write failing tests first for event emission

- [x] **Step 6.2: Implement OpenCodeProvider client sync**
  - Implement `syncClients()` to match discovered ports
  - Create/dispose clients as ports appear/disappear
  - Wire up SSE event handling
  - Files: `src/services/opencode/opencode-provider.ts`
  - Test: Write failing tests first (client creation, disposal, sync logic)

### Phase 7: Agent Status Manager

- [x] **Step 7.1: Implement AgentStatusManager core**
  - Own status aggregation (single source of truth)
  - Track sessionStatuses Map
  - Implement `initWorkspace()` / `removeWorkspace()` lifecycle
  - Implement `getStatus()` / `getAllStatuses()`
  - Files: `src/services/opencode/agent-status-manager.ts`
  - Test: Write failing tests first for provider management

- [x] **Step 7.2: Implement AgentStatusManager status aggregation**
  - Aggregate counts → AggregatedAgentStatus discriminated union
  - Implement callback-based `onStatusChanged()` (NOT IPC)
  - Implement IDisposable with provider cleanup
  - Files: `src/services/opencode/agent-status-manager.ts`
  - Test: Write failing tests first (aggregation logic, callback emission)

### Phase 8: Main Process Integration

- [x] **Step 8.1: Add PID change event to CodeServerManager**
  - Add `onPidChanged(callback)` method
  - Emit event when PID changes (start/stop/restart)
  - Files: `src/services/code-server/code-server-manager.ts`
  - Test: Write failing tests first

- [x] **Step 8.2: Create IPC handlers for agent status**
  - Implement `agent:get-status` handler with Zod validation
  - Implement `agent:get-all-statuses` handler
  - Implement `agent:refresh` handler for manual scan trigger
  - Subscribe to `agentStatusManager.onStatusChanged()` → emit IPC
  - Validate payloads before sending to renderer
  - Files: `src/main/ipc/agent-handlers.ts`
  - Test: Write failing tests first

- [x] **Step 8.3: Register handlers and wire up services**
  - Initialize DiscoveryService with DI (owned by AppState)
  - Initialize AgentStatusManager with DI (owned by AppState)
  - Wire up `codeServerManager.onPidChanged()` → discovery
  - Create scan interval in main process (1s)
  - Add `app.on('before-quit')` cleanup handler
  - Register IPC handlers
  - Update workspace lifecycle: `addWorkspace` → `initWorkspace`, `removeWorkspace` → agent cleanup
  - Files: `src/main/index.ts`, `src/main/app-state.ts`
  - Test: Integration test for full flow

- [x] **Step 8.4: Add preload API**
  - Expose agent status methods and events
  - Follow `createEventSubscription()` pattern
  - Files: `src/preload/index.ts`, `src/shared/electron-api.d.ts`
  - Test: Type compilation passes

### Phase 9: Renderer Integration

- [x] **Step 9.1: Create agent status store**
  - Implement Svelte 5 runes-based store with `$state`
  - Store is pure state container (no IPC subscriptions inside)
  - Export update functions for external use
  - Files: `src/renderer/lib/stores/agent-status.svelte.ts`
  - Test: Write failing tests first for store updates

- [x] **Step 9.2: Create AgentStatusIndicator component**
  - Implement indicator with color states (6px × 16px)
  - Use linear-gradient for mixed state (top red, bottom green)
  - Implement accessible tooltip (keyboard + hover, 500ms delay)
  - Add `role="status"` and `aria-live="polite"`
  - Add `aria-label` with full status text
  - Implement pulse animation with `prefers-reduced-motion` support
  - Add focus ring when parent row focused
  - Props interface: `{ idleCount: number; busyCount: number }`
  - Files: `src/renderer/lib/components/AgentStatusIndicator.svelte`
  - Test: Write failing tests first (each state, accessibility, reduced motion)

- [x] **Step 9.3: Integrate indicator into Sidebar**
  - Add indicator to project rows (next to workspace name)
  - Add indicator to workspace rows
  - Access store values via `.value` (Svelte 5 pattern)
  - Files: `src/renderer/lib/components/Sidebar.svelte`
  - Test: Write failing tests first for indicator rendering

- [x] **Step 9.4: Wire up IPC event listener with cleanup**
  - Subscribe to `api.onAgentStatusChanged()` in App.svelte
  - Use `$effect` with cleanup return for unsubscribe
  - Call store update functions on events
  - Files: `src/renderer/App.svelte`
  - Test: Write failing tests first for cleanup

### Phase 10: Cleanup, Polish, and Documentation

- [x] **Step 10.1: Add service index exports**
  - Create clean public API for opencode services
  - Update `src/services/index.ts` to include new exports
  - Files: `src/services/opencode/index.ts`, `src/services/index.ts`
  - Test: Import works from consuming code

- [x] **Step 10.2: Extract pulse animation to global.css**
  - Move `@keyframes pulse` to shared styles
  - Files: `src/renderer/lib/styles/global.css`
  - Test: Animation still works

- [x] **Step 10.3: Update documentation**
  - Update `docs/ARCHITECTURE.md` lines 220-235:
    - Remove "not yet implemented" notice
    - Document DiscoveryService, OpenCodeProvider, OpenCodeClient, AgentStatusManager
    - Add IPC channels (agent:status-changed, agent:get-status, agent:get-all-statuses, agent:refresh)
    - Document discovery → SSE → store → UI data flow
  - Update `AGENTS.md`:
    - Add OpenCode Integration section
    - Document agent status store pattern (Svelte 5 runes)
    - Document service DI pattern
    - Document SSE connection lifecycle
  - Files: `docs/ARCHITECTURE.md`, `AGENTS.md`
  - Test: Documentation is accurate

- [x] **Step 10.4: Run full validation**
  - Run `pnpm validate:fix`
  - Fix any linting/type errors
  - Test: All checks pass

## Testing Strategy

### TDD Approach

Every implementation step follows Test-Driven Development:

1. **Write failing test(s)** for the behavior being implemented
2. **Implement minimum code** to make tests pass
3. **Refactor** while keeping tests green

Test files are co-located: `src/services/opencode/port-scanner.ts` → `src/services/opencode/port-scanner.test.ts`

### Time-Based Testing

Use `vi.useFakeTimers()` for testing:

- Scan intervals
- Reconnection backoff
- Cache TTL expiration
- Tooltip delays

### Unit Tests (vitest)

| Test Case                                          | Description                                       | File                           |
| -------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| **Port Scanner**                                   |                                                   |                                |
| NetstatPortScanner returns ports                   | Mock node-netstat, verify output                  | `port-scanner.test.ts`         |
| NetstatPortScanner handles parse errors            | Mock malformed output                             | `port-scanner.test.ts`         |
| **Process Tree**                                   |                                                   |                                |
| PidtreeProvider returns descendants                | Mock pidtree, verify output                       | `process-tree.test.ts`         |
| PidtreeProvider handles errors                     | Mock pidtree failure                              | `process-tree.test.ts`         |
| **HTTP Utility**                                   |                                                   |                                |
| fetchWithTimeout success                           | Mock fetch, verify response                       | `http.test.ts`                 |
| fetchWithTimeout timeout                           | Use fake timers, verify abort                     | `http.test.ts`                 |
| fetchWithTimeout abort signal                      | Verify cancellation                               | `http.test.ts`                 |
| **Instance Probe**                                 |                                                   |                                |
| HttpInstanceProbe success                          | Mock fetch, verify path extraction                | `instance-probe.test.ts`       |
| HttpInstanceProbe timeout                          | Mock timeout, verify error                        | `instance-probe.test.ts`       |
| HttpInstanceProbe malformed JSON                   | Mock invalid response                             | `instance-probe.test.ts`       |
| HttpInstanceProbe invalid structure                | Mock missing fields                               | `instance-probe.test.ts`       |
| HttpInstanceProbe rejects non-localhost            | Verify security                                   | `instance-probe.test.ts`       |
| **Discovery Service**                              |                                                   |                                |
| DiscoveryService filters descendants               | Mock deps, verify only descendants probed         | `discovery-service.test.ts`    |
| DiscoveryService caches non-OpenCode               | Verify ports not re-probed                        | `discovery-service.test.ts`    |
| DiscoveryService clears cache on PID change        | Verify cache cleared                              | `discovery-service.test.ts`    |
| DiscoveryService handles port reuse                | Different PID triggers re-probe                   | `discovery-service.test.ts`    |
| DiscoveryService prevents concurrent scans         | Verify mutex behavior                             | `discovery-service.test.ts`    |
| DiscoveryService handles port closing during probe | Verify graceful handling                          | `discovery-service.test.ts`    |
| DiscoveryService TTL cache cleanup                 | Verify old entries removed                        | `discovery-service.test.ts`    |
| **OpenCode Client**                                |                                                   |                                |
| OpenCodeClient parses session.status event         | Mock EventSource                                  | `opencode-client.test.ts`      |
| OpenCodeClient parses session.deleted event        | Mock EventSource                                  | `opencode-client.test.ts`      |
| OpenCodeClient parses session.idle event           | Mock EventSource                                  | `opencode-client.test.ts`      |
| OpenCodeClient ignores unknown events              | Mock unknown event type                           | `opencode-client.test.ts`      |
| OpenCodeClient handles malformed event data        | Mock invalid JSON                                 | `opencode-client.test.ts`      |
| OpenCodeClient implements exponential backoff      | Use fake timers                                   | `opencode-client.test.ts`      |
| OpenCodeClient respects max retry limit            | Verify max 30s                                    | `opencode-client.test.ts`      |
| OpenCodeClient resets backoff on success           | Verify reset                                      | `opencode-client.test.ts`      |
| OpenCodeClient stops reconnecting after dispose    | Verify cleanup                                    | `opencode-client.test.ts`      |
| OpenCodeClient closes EventSource on dispose       | Verify resource cleanup                           | `opencode-client.test.ts`      |
| OpenCodeClient removes event listeners on dispose  | Verify no leaks                                   | `opencode-client.test.ts`      |
| **OpenCode Provider**                              |                                                   |                                |
| OpenCodeProvider emits raw session events          | Verify event emission                             | `opencode-provider.test.ts`    |
| OpenCodeProvider syncs clients on port changes     | Ports added/removed                               | `opencode-provider.test.ts`    |
| OpenCodeProvider disposes all clients on cleanup   | Verify disposal                                   | `opencode-provider.test.ts`    |
| **Agent Status Manager**                           |                                                   |                                |
| AgentStatusManager aggregates counts correctly     | Various combinations                              | `agent-status-manager.test.ts` |
| AgentStatusManager emits via callbacks             | Verify callback pattern                           | `agent-status-manager.test.ts` |
| AgentStatusManager handles init/remove lifecycle   | Provider management                               | `agent-status-manager.test.ts` |
| AgentStatusManager disposes providers on shutdown  | Verify cleanup                                    | `agent-status-manager.test.ts` |
| **IPC Handlers**                                   |                                                   |                                |
| agent:get-status validates payload                 | Verify Zod validation                             | `agent-handlers.test.ts`       |
| agent:get-status rejects invalid path              | Security validation                               | `agent-handlers.test.ts`       |
| agent:refresh triggers scan                        | Verify immediate scan                             | `agent-handlers.test.ts`       |
| **Store**                                          |                                                   |                                |
| Agent status store updates on event                | Verify reactive updates                           | `agent-status.svelte.test.ts`  |
| Agent status store handles errors gracefully       | Verify error handling                             | `agent-status.svelte.test.ts`  |
| **UI Components**                                  |                                                   |                                |
| AgentStatusIndicator grey state                    | No agents, opacity 0.4                            | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator green state                   | All idle, solid green                             | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator red state                     | All busy, pulsing red                             | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator mixed state                   | Gradient, pulsing                                 | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator has ARIA attributes           | role, aria-label, aria-live                       | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator respects reduced motion       | No animation when preferred                       | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator tooltip shows correct text    | "No agents", "2 idle", "1 busy", "1 idle, 2 busy" | `AgentStatusIndicator.test.ts` |
| AgentStatusIndicator tooltip keyboard accessible   | Shows on focus                                    | `AgentStatusIndicator.test.ts` |

### Integration Tests

| Test Case                                 | Description                  | File                                    |
| ----------------------------------------- | ---------------------------- | --------------------------------------- |
| Full discovery flow                       | Port scan → probe → register | `discovery-service.integration.test.ts` |
| Multiple workspaces with different states | Verify isolation             | `agent-status.integration.test.ts`      |
| Code-server PID change triggers re-scan   | Verify event-driven update   | `agent-status.integration.test.ts`      |
| Provider cleanup when workspace removed   | Verify lifecycle             | `agent-status.integration.test.ts`      |
| Full status flow                          | SSE event → store → UI       | `agent-status.integration.test.ts`      |

### Manual Testing Checklist

- [ ] Start app with no OpenCode running → indicators show grey
- [ ] Open OpenCode in a workspace → indicator turns green
- [ ] Start an agent task → indicator turns red and pulses
- [ ] Agent completes task → indicator turns green
- [ ] Multiple agents: some idle, some busy → mixed indicator (gradient)
- [ ] Close OpenCode → indicator returns to grey
- [ ] Multiple OpenCode instances in same workspace → counts aggregate
- [ ] Restart code-server → discovery recovers (event-driven)
- [ ] Hover indicator → tooltip shows after 500ms
- [ ] Tab to workspace row → tooltip shows on focus
- [ ] Press Escape → tooltip dismisses
- [ ] Enable reduced motion in OS → pulse animation disabled
- [ ] Screen reader announces status changes

## Dependencies

| Package      | Purpose                               | Approved |
| ------------ | ------------------------------------- | -------- |
| node-netstat | Cross-platform port scanning with PID | [x]      |
| eventsource  | SSE client for Node.js                | [x]      |
| pidtree      | Get descendant PIDs of a process      | [x]      |

**All dependencies approved by user.**

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Lines 220-235: Remove "not yet implemented", document 4 services (DiscoveryService, OpenCodeProvider, OpenCodeClient, AgentStatusManager), 4 IPC channels, data flow diagram |
| `AGENTS.md`            | Add "OpenCode Integration" section: document DI pattern for services, agent status store pattern (Svelte 5 runes), SSE connection lifecycle pattern                          |

### New Documentation Required

| File   | Purpose                    |
| ------ | -------------------------- |
| (none) | Implementation is internal |

## Definition of Done

- [x] All implementation steps complete (TDD: failing tests first)
- [x] `pnpm validate:fix` passes
- [x] All unit tests pass
- [x] All integration tests pass
- [x] Manual testing checklist complete
- [x] Accessibility tested (screen reader, keyboard, reduced motion)
- [x] Documentation updated (ARCHITECTURE.md, AGENTS.md)
- [x] Changes committed
