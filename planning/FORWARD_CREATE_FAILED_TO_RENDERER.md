# Task #1 — Forward `workspace:create-failed` to the renderer

> Part of the larger effort migrating the workspace-creation view onto a declarative form framework with optimistic UX. This is the dependency-free foundational task. Authored as a plan; not yet implemented.

---

## Context

This is the **dependency-free, foundational** task (#1) of a larger effort to migrate the workspace-creation view onto a declarative form framework with an **optimistic UX** (Option 1): the create operation will emit an early placeholder for the new workspace, flip it to `ready` on success, and **roll it back on failure**.

The rollback half of that loop is implemented in a later task (**#11, renderer create-bindings**). For #11 to roll back, the renderer must learn that creation failed. Today the main process **already emits** the `workspace:create-failed` domain event (`src/intents/open-workspace.ts:217-225`), but it is only consumed in-process by `error-notification-module.ts` (user notification) and `view-module.ts` (closes the loading dialog). **It is never forwarded to the renderer.**

This task does exactly one thing: deliver the existing `workspace:create-failed` event to the renderer over a **new additive IPC channel**, mirroring how `workspace:created` is already forwarded (`src/modules/ui-ipc-module.ts:171-187` → channel `api:workspace:created`). It adds a **no-op renderer handler stub** as the seam #11 will fill. It does **not** implement #11's rollback, the `Workspace.status` change, the B2 pending model, or any placeholder logic.

---

## Scope summary

| In scope                                                     | Out of scope (later tasks / separate approval)                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| New additive IPC channel `api:workspace:create-failed`       | #11 rollback logic / removing the placeholder                                 |
| Additive `ApiEvents` entry for renderer typing               | `Workspace.status` (`creating`/`ready`) change (B2)                           |
| Forwarder in `ui-ipc-module.ts` (mirror `workspace:created`) | Deleting the `pending-workspaces` store                                       |
| No-op renderer handler **stub** (seam for #11)               | Modifying the domain `WorkspaceCreateFailedPayload` (e.g. adding `projectId`) |
| Boundary/integration tests for delivery                      | Anything touching `NewWorkspaceView.svelte` / form framework                  |

---

## Grounded facts (verified by reading the code)

- **Domain payload** `WorkspaceCreateFailedPayload` — `src/intents/open-workspace.ts:125-131`:

  ```ts
  export interface WorkspaceCreateFailedPayload {
    readonly workspaceName: string;
    readonly projectPath: string; // the PROJECT root path, not a workspace path
    readonly error: string;
    readonly source?: WorkspaceOpenSource; // internal routing only
  }
  ```

  Constants/event type: `EVENT_WORKSPACE_CREATE_FAILED = "workspace:create-failed"` (`:138`), `WorkspaceCreateFailedEvent` (`:133-136`).
  **No `projectId` / `workspacePath`** — the event is emitted in the `catch` of `execute()` (`:217-225`), _before_ `INTENT_RESOLVE_PROJECT` runs (`:235-239`). Including `projectId` would require resolving earlier **and** changing the domain payload (out of scope / separate approval).

- **Existing forwarder to mirror** — `src/modules/ui-ipc-module.ts:171-187` (`[EVENT_WORKSPACE_CREATED]`): maps domain payload → IPC payload via `deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_CREATED, {...})` and **omits `source`**.

- **Channel constants** — `src/shared/ipc.ts:155-204`, `ApiIpcChannels` `as const satisfies Record<string,string>`; events block at `:187-203` (e.g. `WORKSPACE_CREATED: "api:workspace:created"` at `:191`).

- **Renderer event-type contract** — `src/shared/api/interfaces.ts:32-58`, the `ApiEvents` interface. The renderer's typed subscription `DomainEventApi.on<E extends keyof ApiEvents>` (`src/renderer/lib/utils/domain-events.ts:29-31`) is keyed on `ApiEvents`, so a typed `api.on("workspace:create-failed", …)` **requires** the event to exist in `ApiEvents`.

- **Preload needs NO change** — `src/preload/index.ts:125-130` exposes a generic `on<T>(event, cb)` that builds channel `api:${event}` and subscribes. Every forwarded domain event (created/removed/switched/…) uses this generic `on`; only `onModeChange`/`onShortcut`/`onTheme` are dedicated methods. The new `api:workspace:create-failed` channel works through the existing generic `on` unchanged. `electron-api.d.ts` also needs no change (its `on<T>` is generic; renderer typing comes from `ApiEvents`).

- **Multi-module fan-out is supported** — the dispatcher registers each module's `events` entries as independent handlers (`src/intents/lib/dispatcher.ts:192-205`). `workspace:create-failed` already has two subscribers (`error-notification-module.ts:22`, `view-module.ts:737`); adding `ui-ipc-module` as a third is the same pattern, with no ordering/shared-state coupling.

- **Why the 3-field payload is enough for #11** — the renderer holds each project with both `.id` and `.path`; the existing placeholder store is keyed by `projectPath + name` (`findPendingByName(projectPath, workspaceName)` in `pending-workspaces.svelte.ts`). So `{ projectPath, workspaceName }` uniquely identifies the placeholder, and `projectId` (if ever needed) is derivable locally from the loaded project. **No domain change required.**

---

## Implementation (file-by-file, diffs-in-prose)

Apply edits in this order (typing dependency: `interfaces.ts` and `ipc.ts` must exist before the module/renderer/test edits compile).

### 1. `src/shared/ipc.ts` — add the channel constant ⚠️ APPROVAL-NEEDED

In the `// Events (main → renderer)` block of `ApiIpcChannels` (after `WORKSPACE_CREATED: "api:workspace:created"`, `:191`), add:

```ts
WORKSPACE_CREATE_FAILED: "api:workspace:create-failed",
```

Purely additive; the `as const satisfies Record<string,string>` constraint is unaffected.

### 2. `src/shared/api/interfaces.ts` — add the event type ⚠️ APPROVAL-NEEDED

In the `ApiEvents` interface (`:32-58`), add a member alongside `"workspace:created"`. Mirror the domain payload's available fields; **omit `source`** (matching how the `created` forwarder omits it):

```ts
"workspace:create-failed": (event: {
  readonly workspaceName: string;
  readonly projectPath: string;
  readonly error: string;
}) => void;
```

Additive interface member — no existing subscription type-breaks.

### 3. `src/modules/ui-ipc-module.ts` — register the forwarder (no approval)

- Extend the existing open-workspace import (`:39-40`) to also pull in the create-failed symbols:
  ```ts
  import type {
    WorkspaceCreatedEvent,
    WorkspaceCreateFailedEvent,
  } from "../intents/open-workspace";
  import {
    EVENT_WORKSPACE_CREATED,
    EVENT_WORKSPACE_CREATE_FAILED,
    INTENT_OPEN_WORKSPACE,
  } from "../intents/open-workspace";
  ```
- In the `events: EventDeclarations` object, add a declaration next to `[EVENT_WORKSPACE_CREATED]` (`:171-187`):
  ```ts
  [EVENT_WORKSPACE_CREATE_FAILED]: {
    handler: async (event: DomainEvent): Promise<void> => {
      const p = (event as WorkspaceCreateFailedEvent).payload;
      deps.viewManager.sendToUI(ApiIpcChannels.WORKSPACE_CREATE_FAILED, {
        workspaceName: p.workspaceName,
        projectPath: p.projectPath,
        error: p.error,
      });
    },
  },
  ```
  Forward unconditionally for all sources (mirrors `created`; the renderer stub is a no-op, and #11's lookup self-gates — non-UI sources have no placeholder, so rollback is a no-op).

### 4. `src/renderer/lib/utils/domain-events.ts` — no-op handler STUB (no approval)

In `setupDomainEvents()`, after the `workspace:metadata-changed` subscription (`:160-165`), add the delivery seam **with no store mutation** (this is the stub #11 fills):

```ts
// Workspace create-failed event — delivery seam only.
// Task #11 will consume this to roll back the optimistic placeholder
// (resolve project by projectPath, remove the placeholder by workspaceName).
// Intentionally a no-op for now.
unsubscribes.push(
  api.on("workspace:create-failed", () => {
    /* #11: roll back optimistic placeholder */
  })
);
```

**Lint note (ESLint `--max-warnings 0`, `@typescript-eslint/no-unused-vars` is an error here):** **drop the unused `event` parameter** as shown. Do **not** write `(event) => {}` (unused-arg error) and do **not** rely on `_event` (the `argsIgnorePattern: "^_"` override only applies to `extensions/**`, `*.test-utils.ts`, `*.state-mock.ts` — not `src/renderer/**`). The non-empty comment body keeps it clear; empty arrow bodies are already tolerated in the codebase (e.g. `initialize-app.ts:81`).

No change to `setup-domain-event-bindings.ts` (no new `DomainStores` method — the stub touches no store).

---

## Tests (all <50ms)

### A. Integration — forwarder delivers to the renderer channel

**File:** `src/modules/ui-ipc-module.integration.test.ts`

Use the **direct-handler-invocation** style already used by the `bases:updated` (`:344-351`) and `shortcut:key` (`:494`) tests — lowest friction, trivially <50ms, no operation/dispatcher wiring needed:

```ts
it("forwards workspace:create-failed to the UI", async () => {
  const deps = createBridgeDeps();
  const uiIpcModule = createUiIpcModule(deps);
  await uiIpcModule.events![EVENT_WORKSPACE_CREATE_FAILED]!.handler({
    type: EVENT_WORKSPACE_CREATE_FAILED,
    payload: {
      workspaceName: "feature-branch",
      projectPath: "/projects/test",
      error: "boom",
    },
  } as WorkspaceCreateFailedEvent);

  expect(deps.sendToUI).toHaveBeenCalledWith(ApiIpcChannels.WORKSPACE_CREATE_FAILED, {
    workspaceName: "feature-branch",
    projectPath: "/projects/test",
    error: "boom",
  });
});
```

Add imports for `EVENT_WORKSPACE_CREATE_FAILED` / `WorkspaceCreateFailedEvent` from `../intents/open-workspace`.
_(Optional, higher-fidelity alternative: a `MinimalFailingCreateOperation` mirroring `MinimalDeleteOperation` (`:72-95`) that `ctx.emit`s the failed event through the dispatcher and asserts forwarding end-to-end. The direct-handler test is sufficient and preferred for speed.)_

### B. Renderer — stub is wired and is a no-op

**File:** `src/renderer/lib/utils/domain-events.test.ts`

Using the existing `createMockApi()` (`:51-77`) and mock stores:

```ts
it("subscribes to workspace:create-failed without mutating stores (stub)", () => {
  setupDomainEvents(mockApi.api, mockStores);
  expect(() =>
    mockApi.emit("workspace:create-failed", {
      workspaceName: "feature-branch",
      projectPath: "/projects/test",
      error: "boom",
    })
  ).not.toThrow();
  expect(mockStores.removeWorkspace).not.toHaveBeenCalled();
  expect(mockStores.addWorkspace).not.toHaveBeenCalled();
});
```

This proves the subscription exists (so #11 has a seam) and confirms #1 introduces no behavioral change. The mock `emit` typing depends on the `ApiEvents` entry, so edit #2 must land first.

### Commands

```bash
pnpm test:integration   # exercises ui-ipc-module.integration.test.ts
pnpm test               # full suite (renderer test runs here)
pnpm validate:fix       # lint + format + tests (run last)
```

---

## Edge cases & backward-compat

- **No `projectId`/`workspacePath` in payload** — intentional and sufficient (see grounded facts). If #11 later requires id-keying, the renderer maps `projectPath → projectId` locally; only if that proves insufficient would enriching the domain payload be revisited (separate approval).
- **All sources forwarded** — `mcp`/`plugin-server`/`auto-workspace`/`open-project`/UI all forward. Harmless: the renderer stub is a no-op, and #11's placeholder lookup naturally no-ops when no placeholder exists. Do **not** add a source filter (unlike `error-notification-module.ts:25`, which filters `mcp` for user-facing notifications — IPC forwarding has no such concern).
- **Multiple subscribers to one event** — `ui-ipc-module` becomes the 3rd subscriber alongside `error-notification-module` and `view-module`; independent side effects, dispatcher-supported (`dispatcher.ts:192-205`).
- **Backward compatibility** — fully additive. Renderer is bundled with main (single Electron app, no external IPC consumers). An unconsumed-by-#1 channel is harmless; the no-op stub guarantees zero behavior change until #11.
- **`App.test.ts:233-246`** asserts a _subset_ of `api.on(...)` subscriptions (not the full count), so the new subscription does **not** break it. No edit required; noted for awareness.

---

## ⚠️ Approval-needed (CLAUDE.md: IPC channel names/signatures + shared `src/shared/` type changes require explicit user approval)

1. **New IPC channel** `WORKSPACE_CREATE_FAILED: "api:workspace:create-failed"` in `src/shared/ipc.ts` (`ApiIpcChannels`). _Additive — does not modify or rename any existing channel._
2. **New shared event type** member `"workspace:create-failed"` in `ApiEvents` (`src/shared/api/interfaces.ts`). _Additive interface member._

Both are strictly additive and back-compatible. **No** changes to existing IPC signatures, intent/event type definitions, the domain `WorkspaceCreateFailedPayload`, preload APIs, or `electron-api.d.ts`. (Out-of-scope alternative — adding `projectId` to the domain `WorkspaceCreateFailedPayload` — would be a **third** approval-needed change to an intent/event type definition; not pursued.)

---

## Verification

1. **Tests** — `pnpm test:integration` then `pnpm test`; both new tests green. `pnpm validate:fix` clean (lint/format/types).
2. **Manual end-to-end (optional, via appctrl MCP)** — run the app, attempt a workspace creation that fails (e.g. an invalid base/branch name), and confirm `api:workspace:create-failed` is delivered: with `CH_LOG__LEVEL=debug CH_LOG__OUTPUT=console pnpm dev`, verify the `[api]` forwarder fires; in the renderer console confirm the `api.on("workspace:create-failed", …)` handler is invoked (e.g. temporarily log inside the stub during manual testing, then revert). No visible UI change is expected — rollback arrives in #11.
3. **Regression** — existing `workspace:created` forwarding and the error notification / loading-dialog-close behavior are unchanged (the forwarder is purely additive and the other two subscribers are untouched).

---

## Files touched

| File                                            | Change                                                 | Approval |
| ----------------------------------------------- | ------------------------------------------------------ | -------- |
| `src/shared/ipc.ts`                             | + `WORKSPACE_CREATE_FAILED` channel constant           | ⚠️ yes   |
| `src/shared/api/interfaces.ts`                  | + `"workspace:create-failed"` in `ApiEvents`           | ⚠️ yes   |
| `src/modules/ui-ipc-module.ts`                  | + import + `[EVENT_WORKSPACE_CREATE_FAILED]` forwarder | no       |
| `src/renderer/lib/utils/domain-events.ts`       | + no-op handler stub (seam for #11)                    | no       |
| `src/modules/ui-ipc-module.integration.test.ts` | + forwarding test                                      | no       |
| `src/renderer/lib/utils/domain-events.test.ts`  | + stub no-op test                                      | no       |

No changes to: `src/preload/**`, `src/shared/electron-api.d.ts`, `src/intents/open-workspace.ts`, `setup-domain-event-bindings.ts`, the `pending-workspaces` store.
