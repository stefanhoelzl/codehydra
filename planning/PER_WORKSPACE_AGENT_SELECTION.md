# Per-Workspace Agent Selection

## Goal

Allow each workspace to use its own agent (claude / opencode), while keeping a
single global default agent chosen at first startup.

## User-Facing Behavior

- First-startup picker stays as-is. Picks the **global default agent**;
  downloads only that binary.
- Create-workspace dialog: inside the existing collapsed "Advanced" section, a
  dropdown lists agents whose binaries are currently present (initially: just
  the default). Pre-selected value = global default.
- Agent choice is **fixed at workspace creation**. No post-create switching.
- Discovered/existing workspaces with no per-workspace agent metadata fall back
  to the global default at runtime.
- Additional agents are installed via a future settings UI (out of scope here).
  Restart required to pick up newly installed agents.
- No new badge/icon in the workspace list.

## Storage

- Per-workspace agent persisted via the existing **metadata-module** (git
  worktree config), key `agent`.
- Only written when the chosen agent **differs from `config.agent`**. Absent
  key ⇒ fall back to `config.agent`.

## Intent System Integration

### New: workspace-agent-resolver module

A small module that, for each workspace-scoped operation, runs an early handler
that:

1. Reads `agent` from workspace metadata; falls back to `config.agent`.
2. For `workspace:create` only: if the intent payload's `agent` differs from
   `config.agent`, writes it to metadata first.
3. Emits an `agent` capability with the resolved value.

Agent modules `requires: { agent: provider.type }` on the six
workspace-scoped hooks — the dispatcher routes only the matching module.

Operations it runs in:

- `workspace:open` (setup)
- `workspace:delete` (shutdown)
- `workspace:hibernate` (shutdown)
- `workspace:get-status` (get)
- `workspace:get-agent-session` (get)
- `workspace:restart-agent` (restart)

### Changes in `src/modules/agent-module/agent-module.ts`

- Remove `isActive()` and all six gates that use it (lines 166, 266, 291, 308,
  319, 331, 343 in current file).
- Each of the six workspace-scoped hooks declares
  `requires: { agent: provider.type }`. Dispatcher handles routing.
- `app:start` `start` hook: **no longer initializes** the provider. It only
  stashes `mcpPort` into closure (still `requires: { mcpPort }`). No status
  subscription here either.
- `workspace:open` setup hook: **lazy init**. On first invocation for this
  module:
  - Call `provider.initialize(mcpPort)`.
  - Subscribe to `provider.onStatusChange` and dispatch
    `agent:update-status` intents.
  - Set `initialized = true`.
  - Then call `provider.startWorkspace(...)` as today.
- `app:shutdown` stop hook: unchanged — still disposes the provider; safe even
  when `initialized` is false.
- `check-deps` (line 149) and setup `binary` (line 224) hooks: **unchanged**.
  They still serve the first-run download of the default agent.

### Intent payload changes

- `OpenWorkspacePayload` gains optional field: `agent?: AgentType`.
- `api:workspace:create` IPC payload gains optional `agent?: AgentType`.
- Preload signature: `workspaces.create(projectPath, name, base, options?)`
  options gains `agent?`.

## IPC / Bootstrap

Extend `api:lifecycle:ready` (currently returns `void`) to return:

```ts
{
  defaultAgent: AgentType | null;
  availableAgents: ReadonlyArray<{ type: AgentType; label: string; icon: string }>;
}
```

- `defaultAgent` = `config.agent`.
- `availableAgents` = registered agents filtered by `provider.preflight()`
  reporting the binary as present. Computed once at startup; not re-queried.

Scope deliberately tight: don't fold in other bootstrap data in this change.

## Renderer Changes

### Bootstrap

- Store `{ defaultAgent, availableAgents }` returned from `lifecycle.ready()`
  in a renderer store.

### CreateWorkspaceDialog.svelte

- In the existing collapsed "Advanced" section, add an agent dropdown:
  - Options: `availableAgents` from the bootstrap store.
  - Initial value: `defaultAgent`.
  - If only one agent is available, the dropdown may still render (read-only
    indicator) — finalize during implementation.
- On submit, pass `agent` in the `options` argument **only when it differs
  from `defaultAgent`**, so default-case calls stay identical to today.

## Migration / Compatibility

- No metadata migration. Workspaces created before this change have no `agent`
  metadata key → resolver returns `config.agent` (= today's behavior).
- IPC payload changes are additive (optional field). Backwards compatible.

## Testing

| Area                          | Test                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Resolver module               | Integration: emits capability from metadata; falls back to config; writes metadata only when create payload's agent differs from default |
| Agent module routing          | Integration: with two agent modules registered, only the one matching `agent` capability runs each workspace hook                        |
| Lazy init                     | Integration: provider not initialized at `app:start`; initialized on first `workspace:open`; not re-initialized on subsequent opens      |
| Status subscription           | Integration: status events emitted by a lazily-initialized provider reach the dispatcher                                                 |
| Create dialog                 | Integration: dropdown reflects `availableAgents`; defaults to `defaultAgent`; submits agent only when non-default                        |
| `lifecycle:ready` IPC         | Boundary: returns bootstrap payload with defaultAgent + filtered availableAgents                                                         |
| Existing workspaces fall back | Integration: workspace with no `agent` metadata resolves to config.agent end-to-end                                                      |

## Out of Scope

- Settings UI to install additional agent binaries (separate work).
- Changing a workspace's agent after creation.
- Workspace-list agent badge/icon.
- Per-agent capability divergence (e.g. agents that don't support plan mode).

## Implementation Order

1. Add `agent?: AgentType` to `OpenWorkspacePayload` and IPC types.
2. Add workspace-agent-resolver module; register it ahead of agent modules.
3. Change agent module hooks: lazy init in `workspace:open`; remove
   `isActive()` gates in workspace-scoped hooks and add capability requires.
4. Extend `api:lifecycle:ready` response + renderer store.
5. Update CreateWorkspaceDialog to show the dropdown and pass `agent`.
6. Tests at each step; `pnpm validate:fix` at the end.
