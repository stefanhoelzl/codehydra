# Intent dispatcher

Every operation runs through the intent dispatcher: operations, hook modules, domain events. Full reference: `docs/INTENTS.md` (Writing a module, Capability-Based Hook Ordering, Idempotency, Operations Reference, Domain Events).

## Composition root

- `src/main.ts` constructs every service and module, registers operations and modules with the dispatcher, then dispatches `app:start`.
- A new operation needs an entry in the `Operations` table in `declarations.ts`.

## Writing a module

- Declare handlers with `defineHooks` / `defineEvents` (`declarations.ts`). Hook contexts (intent included) and results are typed from the operation's schemas, event handlers from the event type: no `ctx as XHookInput` / `event as XEvent` casts.
- Order handlers by capability: `requires` / `provides` (`lib/operation.ts`; `ANY_VALUE` matches any provided value).

## Idempotency

`createIdempotencyModule(rules)` (`lib/idempotency-module.ts`) builds one `IntentModule` (one interceptor plus reset-event handlers) from rules in three modes:

- singleton (`app:shutdown`, `app:ready`)
- singleton with reset (`app:setup`, `app:resume`)
- per-key (`workspace:delete`, `workspace:hibernate`, `workspace:wake`)

A per-key rule with `wait` holds a duplicate until the key is released instead of blocking it. `project:open` uses it, because a blocked dispatch resolves to `undefined`. The rules live in `src/main.ts`.

## Workspace operations

- `workspace:open` creates a worktree, or with `existingWorkspace` activates a discovered one without creating it.
- `project:open` emits `project:opened` right after discovery, before any workspace is open (so the sidebar lists them loading), then opens the awake ones one at a time, the active one first.
- Hook modules on `workspace:open` must handle both paths. The operation decides once and puts `fresh` (true = new worktree, false = reopen) and the resolved `workspaceName` on every hook context. Branch on those, never on `payload.existingWorkspace`. `workspace:created` carries `fresh` too.
- `workspace:delete` takes `removeWorktree`: `true` = full deletion, `false` = runtime-only teardown (skips the `release` and `delete` hook points). `project:close` uses `false` unless the close confirmed `removeAll` (`removeLocalRepo` implies it).
- `workspace:open`, `workspace:delete`, `workspace:hibernate`, `project:open` and `project:close` dispatch `workspace:switch` when the active workspace changes.
- `agent:update-status` has no hooks; it emits `agent:status-updated`, which the presenter (folded into the `UiState` snapshot), badge, OS-notification, power and other modules consume.

## app:start

`Config.load()` (sync) runs before `app:start` is dispatched. Hook points, in order:

1. `before-ready`: script declarations, Electron flags, data paths.
2. `init`: logging, shell, scripts. `electron-lifecycle-module` provides the `"app-ready"` capability after `whenReady()`; handlers that need Electron declare `requires: { "app-ready": ANY_VALUE }`.
3. `show-ui`: starting screen.
4. `migrations`: bring on-disk data in line before anything reads it (e.g. a requested workspaces-root move). May block on the starting screen or quit.
5. `register-agents` / `agent-selection` / `save-agent`: first run only (no `config.json` yet), the agent picker. Must precede `check-deps`, which is agent-specific.
6. `check-deps`: binary and extension checks. When they report setup is needed, `app:setup` is dispatched; on failure `await-retry` blocks until the user retries, then the checks rerun.
7. `start`: servers, wiring.

A fatal failure runs the `error` hook point before rethrowing.

## app:shutdown

- `stop`: best-effort disposal. The dispatcher's `collect()` runs every handler even when one throws and logs the failure as a `hook error` warning, so a handler needs no try/catch of its own, only around steps that must not stop the rest of its own disposal.
- `handoff`: what outlives the process (the update installer).
- `quit`.

A singleton idempotency rule lets only one shutdown run.
