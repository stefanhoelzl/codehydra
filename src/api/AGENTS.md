# Operation registry (`src/api/`)

Single source of truth for every operation the outside world can reach: MCP (`ch mcp`), the API server wire (sidekick, extensions, `ch`), the CLI and plugin automation actions. Full surface: [docs/API.md](../../docs/API.md).

## Entries (`entries/*.ts`, `types.ts`)

- Pure domain, declared with `defineEntry`: `name` (from `OPERATION_NAMES` in `names.ts`), `kind`, `description`, `instructions`, zod `input`, `requiresWorkspace`, `handler(ctx, input)`. They know nothing about MCP, the wire or the CLI.
- `kind` is semantic, not transport: a `command` is an instruction (may return nothing); an `event` reports an occurrence the sender witnessed. `agent.lifecycle` is the only event and is sidekick-only (`api:workspace:agentLifecycle`, `null` in every other map) because only the sidekick witnesses the terminal opening/closing.
- `requiresWorkspace: true` + no caller workspace + no target → fails before dispatch (`no-workspace`, CLI exit 4).
- Fail with `ApiError(category, message)` (`errors.ts`); the category travels as `ApiResult.category` and picks the CLI exit code.

## Adapters (`adapters/`)

- Each owns an exhaustive `Readonly<Record<OperationName, Mapping | null>>`: `api-server-map.ts`, `mcp-map.ts`, `cli-map.ts`, `plugin-actions-map.ts`. A new operation fails to compile until every adapter says what it does with it; deliberate absence is an explicit `null`.
- API server channel names are historical, a published contract — never derived from operation names. `ch` and `ch mcp` call `api:operation:<name>` instead.
- Adapters go through `OperationRegistry.invoke` (`registry.ts`), which applies input shaping, validation and `requiresWorkspace`. Per-surface differences are `defaults` only (`InputShaping`), e.g. MCP `lock_take` → `noWait: true`.

## Caller vs target

- `OperationContext` (`types.ts`) carries who calls, never what the call acts on: `workspaceRef` (the cwd's workspace for a shell, the presented one for MCP and extensions; `null` outside every worktree), `cwd`, `signal` (aborted when the caller's connection closes — what `lock.hold` ties its lock to), `onTarget`.
- Every operation that can target another workspace spreads `targetFields` (`workspace` + `project`, `entries/target.ts`) and resolves with `createTargetResolver`: a name is looked up in the caller's project first (`resolveWorkspaceReference`, `workspace-lookup.ts`), `project` scopes it. Every surface passes these fields through unchanged.
- A project that is not open is opened first, and a git URL is cloned — inside `workspace:open`, so every surface gets it.

## Progress events (`events.ts`)

Domain events reach CLI/MCP clients on `api:event`, opt-in per event (`FORWARDED_EVENTS`), scoped per connection by `ApiServerConnection.concerns`: events about a call's resolved target (reported via `ctx.onTarget`), events naming no workspace, and everything while a call with no target yet (`ws create`, `project open`) is in flight.
