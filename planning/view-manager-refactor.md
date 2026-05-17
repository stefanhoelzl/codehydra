# View Manager Refactor — Design Doc

## Context

`src/boundaries/shell/view-manager.ts` is a ~1.4k-line `ViewManager` class that mixes
per-workspace `WebContentsView` lifecycle with UI-level concerns that have nothing to
do with Electron's view model (UI mode state machine, z-order rules, focus routing,
loading-overlay coordination, active-workspace switching with attach-before-detach
sequencing, etc.).

A separate branch is exploring an alternative implementation (different rendering
model). To unblock that work cleanly — and to let both implementations live behind a
feature flag without duplicating fragile coordination logic — the existing code needs
to be re-shaped so the seam is sharp:

- An **abstract base class** owns all the UI/state-machine logic that any
  implementation must share.
- A **concrete subclass** owns only the Electron-`WebContentsView`-specific bits
  (creation/security, attach/detach, URL load + retry, render-process-gone recovery,
  watchdog, etc.).
- A **conformance test suite** that runs against any `IViewManager` implementation,
  so the alternative implementation can prove it honors the same contracts.
- Narrow **capability interfaces** (`DevtoolsTarget`, `KeyboardTarget`) replace the
  current `ViewHandle` escape hatches so consumers stop coupling to Electron's view
  layer.

This refactor is **behavior-preserving**. No new features. No iframe work. No feature
flag yet — just the seam.

---

## Findings from the current code

`IViewManager` (`src/boundaries/shell/view-manager.interface.ts`) is Electron-agnostic
at the type level. The two leaks are `getUIViewHandle()` and `getWorkspaceView()`,
which return raw `ViewHandle`s. Consumers use them only as tokens passed back to
`viewLayer`:

- `devtools-module.ts:45,52` — handle goes into `viewLayer.openDevTools/closeDevTools/
isDevToolsOpened`.
- `shortcut-module.ts:90-104,229,253` — handle goes into
  `viewLayer.onBeforeInputEvent`/`onDestroyed`, and `handle.id` is a map key.

That's it. Both can be replaced by tiny capability interfaces the view-manager
returns, with no loss of functionality.

What's genuinely shared (UI/coordination, identical for any implementation):

- UI mode state machine (`"workspace" | "shortcut" | "dialog" | "hover"`) + mode bus.
- Active-workspace tracking and the **attach-before-detach** sequencing in
  `setActiveWorkspace` (visual continuity guarantee).
- Z-order re-adjustment after switching while in `dialog`/`shortcut`/`hover` mode
  (`view-manager.ts:858-892`, `1137-1150`).
- Loading-state coordinator: `loadingWorkspaces` map, 10s timeout,
  `setWorkspaceLoaded` idempotency guard, **immediate replay of `loading=false` for
  already-loaded workspaces** on `onLoadingChange` subscription
  (`view-manager.ts:1177-1194`).
- Focus router (`getTopView()` + mode-switched `focus()` at
  `view-manager.ts:927-977`).
- Bounds math: clamp to 800×600, UI gets full window, active workspace offset by
  `SIDEBAR_MINIMIZED_WIDTH`, loading workspaces still receive full bounds while
  detached so the renderer re-layouts (`view-manager.ts:616-657`).
- Workspace registry, event-callback sets, IPC `sendToUI` passthrough,
  `destroy()` bookkeeping, reentrancy guard.
- Concrete default for `reloadAllViews()` (iterate, skip loading, call a
  per-workspace reload primitive).
- Concrete default for `updateCodeServerPort()` (store the port on the base;
  subclass primitives read it when they care).

What's genuinely WebContents-specific:

- Electron security/partition config (`webviewTag`, `focusOnNavigation`,
  `backgroundThrottling`, permission/header handlers).
- Wiring of `will-navigate`, `did-fail-load`, `render-process-gone`,
  `did-finish-load`, `unresponsive`/`responsive`.
- Exponential-backoff retry on main-frame load failure (`RETRY_DELAYS_MS`).
- `needsReloadOnAttach` flag + 15s watchdog + `recreateWorkspaceView()`.
- Windows DirectComposition re-composite workaround (inline in the subclass's
  `attachView` override).
- Calls into `viewLayer`/`sessionLayer`.

Consumers: only `main.ts` references the **concrete** class. Every other module uses
`IViewManager` or `Pick<IViewManager, …>`. After commits 7–8, `devtools-module` and
`shortcut-module` stop importing `ViewBoundary` for view-manager-owned handles.

---

## Target structure

Composition + a template-method base class. Concrete impl is a thin subclass that
fills in primitive operations; the base owns all state and orchestration.

```
src/boundaries/shell/
  view-manager.interface.ts          # IViewManager — invariants in JSDoc;
                                       capability getters replace handle getters
  view-manager-base.ts               # abstract BaseViewManager<TImplState> (new)
  view-manager-types.ts              # WorkspaceState<TImplState>, UIMode,
                                       DevtoolsTarget, KeyboardTarget,
                                       pure bounds/z-order helpers (new)
  webcontents-view-manager.ts        # concrete impl (renamed from view-manager.ts)
  view-manager.conformance.ts        # impl-agnostic test suite + Probe type (new)
  webcontents-view-manager.integration.test.ts
                                     # invokes conformance suite with a
                                       WebContents factory + impl-specific tests
```

### `BaseViewManager<TImplState>` — owns the state machine

Generic only over `TImplState`, the per-workspace impl-private slot
(e.g. `WebContentsImplState` carries retry counters + watchdog timers).
Handles stay typed via existing abstract `ViewHandle` — no extra generics there.

State (moved from current `ViewManager`):

- `workspaceStates: Map<string, WorkspaceState<TImplState>>`.
- `mode`, `activeWorkspacePath`, `attachedWorkspacePath`, `destroying`,
  `isChangingWorkspace` reentrancy guard.
- `loadingWorkspaces: Map<string, NodeJS.Timeout>`, event-callback sets.
- `codeServerPort: number` (set by `updateCodeServerPort`, read by subclass).

Concrete methods (full implementations live here):

- `create()`, `destroy()`
- `setMode`, `getMode`, `onModeChange`
- `setActiveWorkspace` (incl. attach-before-detach + z-order re-adjustment),
  `getActiveWorkspacePath`
- `focus()`, `getTopView()`
- `isWorkspaceLoading`, `setWorkspaceLoaded`, `onLoadingChange` (with immediate
  replay), 10s loading timeout
- `updateBounds()` (uses bounds-math helpers from `view-manager-types.ts`)
- `getWorkspaceState`, `isUIAvailable`
- `getUIDevtoolsTarget`, `getWorkspaceDevtoolsTarget(path)`,
  `getUIKeyboardTarget`, `getWorkspaceKeyboardTarget(path)` — default impls call
  protected primitives `makeDevtoolsTarget(handle)` / `makeKeyboardTarget(handle)`
- `sendToUI` (delegated to a `sendIpc` primitive)
- `reloadAllViews()` (default: iterate, skip loading, call `reloadView(state)`)
- `updateCodeServerPort()` (default: store the port; subclass reads via getter)

Abstract primitives (subclass fills in):

```ts
protected abstract createUIView(): ViewHandle;
protected abstract loadUIContent(handle: ViewHandle): Promise<void>;
protected abstract disposeUIView(handle: ViewHandle): void;

protected abstract createUnderlyingView(
  path: string, url: string, projectPath: string, isNew: boolean,
): { handle: ViewHandle; implState: TImplState };
protected abstract loadWorkspaceUrl(state: WorkspaceState<TImplState>): void;
protected abstract attachView(state: WorkspaceState<TImplState>): void;
protected abstract detachView(state: WorkspaceState<TImplState>): void;
protected abstract applyBounds(handle: ViewHandle, rect: Rect): void;
protected abstract focusHandle(handle: ViewHandle): void;
protected abstract disposeView(state: WorkspaceState<TImplState>): Promise<void>;
protected abstract captureViewPng(handle: ViewHandle): Promise<Buffer | null>;
protected abstract sendIpc(channel: string, ...args: unknown[]): void;
protected abstract reloadView(state: WorkspaceState<TImplState>): void;

protected abstract makeDevtoolsTarget(handle: ViewHandle): DevtoolsTarget;
protected abstract makeKeyboardTarget(handle: ViewHandle): KeyboardTarget;
```

### `WebContentsViewManager` — concrete subclass

Owns everything currently inline that is `WebContents`-specific:

- Electron security/partition wiring inside `createUnderlyingView`.
- `wireEventHandlers()` (`will-navigate`, `did-fail-load`, `render-process-gone`,
  `did-finish-load`, `unresponsive`/`responsive`).
- `handleLoadFailure()` + `RETRY_DELAYS_MS` exponential backoff
  (state held in `WebContentsImplState`).
- `needsReloadOnAttach` flag + `RELOAD_WATCHDOG_MS` watchdog +
  `recreateWorkspaceView()`.
- Windows DirectComposition re-composite — **inline inside `attachView` override**.
- `makeDevtoolsTarget(handle)` and `makeKeyboardTarget(handle)` — closures over
  `viewLayer` that adapt the calls (`openDevTools`/`closeDevTools`/
  `isDevToolsOpened`, `onBeforeInputEvent`/`onDestroyed`). Each returned target
  carries a stable `id` (the handle id) so consumers can keep using it as a map key.
- Concrete delegation to `viewLayer.attachToWindow`/`detachFromWindow`/
  `setBounds`/`focus`/`reload` and `sessionLayer`.

### Why template-method + composition (and not pure composition)

Composition forces the base to call into a strategy via an interface, but most
"primitives" need access to shared state (the registry, the attached path, etc.).
Template-method keeps shared state encapsulated and the subclass override surface
flat — closer to what's there today, lower risk per commit. Stateless concerns
(bounds math, mode→z-order mapping) are **plain functions** in
`view-manager-types.ts` regardless, so they're trivially unit-testable.

### Construction

`create()` stays on `IViewManager` (two-phase init: `new` then `await create()`).
`main.ts` picks the concrete class; `view-module.ts` keeps calling
`viewManager.create()` in the `app-start/init` hook. No factory indirection.
A future feature flag becomes a one-line `new A() vs new B()` swap in `main.ts`.

### Narrow capability interfaces

```ts
// in view-manager-types.ts
export interface DevtoolsTarget {
  readonly id: string; // stable; was handle.id
  toggle(): void; // open if closed, close if open
  isOpen(): boolean;
}

export interface KeyboardTarget {
  readonly id: string;
  onBeforeInput(cb: (input: KeyboardInput) => void): Unsubscribe;
  onDestroyed(cb: () => void): Unsubscribe;
}
```

`IViewManager` exposes:

- `getUIDevtoolsTarget(): DevtoolsTarget`
- `getWorkspaceDevtoolsTarget(path): DevtoolsTarget | undefined`
- `getUIKeyboardTarget(): KeyboardTarget`
- `getWorkspaceKeyboardTarget(path): KeyboardTarget | undefined`

`getUIViewHandle()` and `getWorkspaceView()` are **removed** in commit 8.

---

## Conformance test suite

`view-manager.conformance.ts` exports:

```ts
export interface ConformanceProbe {
  attachLog: string[]; // paths in attach order
  detachLog: string[]; // paths in detach order
  isAttached(path: string): boolean;
  uiIsTop(): boolean; // for z-order assertions
}

export function runViewManagerConformance(opts: {
  name: string;
  makeFactory: () => Promise<{
    create(): Promise<IViewManager>; // tests call this per case
    probe: ConformanceProbe; // populated by the factory's mocks
  }>;
}): void;
```

Each implementation's test file builds its own probe over its own mocks. For
`WebContentsViewManager`, the probe wraps `ViewBoundaryMock`'s call log. The alt
impl, when it lands, ships its own probe over whatever mock surface it uses — the
conformance suite stays oblivious.

Cross-impl assertions inside the suite:

- `setActiveWorkspace` attaches new view **before** detaching old (probe ordering).
- Idempotency: re-`setActiveWorkspace`(samePath), `setMode`(sameMode),
  `setWorkspaceLoaded`, `destroyWorkspaceView` are all no-ops on repeat.
- `onLoadingChange` replays `loading=false` immediately for already-loaded
  workspaces.
- Loading-state 10s timeout flips a workspace to loaded.
- Z-order: switching active workspace while in `shortcut`/`dialog`/`hover` leaves
  the UI handle on top (`probe.uiIsTop()`).
- `updateBounds()` is O(1) over workspaces (only UI + active touched on resize).
- `focus()` routes per mode.
- `destroy()` is idempotent and tears down every workspace.
- `getUIDevtoolsTarget()` / `getWorkspaceDevtoolsTarget(path)` round-trip
  toggle → isOpen.
- `KeyboardTarget.onBeforeInput` fires for input events on the underlying view.

`webcontents-view-manager.integration.test.ts` invokes
`runViewManagerConformance(...)` and retains WebContents-specific tests:
retry backoff, watchdog, render-process-gone flag, navigation/origin handler,
Windows DirectComposition workaround.

---

## Critical files

| File                                                                | Change                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/boundaries/shell/view-manager.interface.ts`                    | Add JSDoc invariants. Replace `getUIViewHandle`/`getWorkspaceView` with the four capability getters (commits 7–8).                                                                     |
| `src/boundaries/shell/view-manager.ts`                              | Renamed to `webcontents-view-manager.ts`; class renamed to `WebContentsViewManager`; reduced to subclass + WebContents specifics.                                                      |
| `src/boundaries/shell/view-manager-base.ts`                         | **New.** Abstract `BaseViewManager<TImplState>`.                                                                                                                                       |
| `src/boundaries/shell/view-manager-types.ts`                        | **New.** `WorkspaceState<TImplState>`, `UIMode`, `DevtoolsTarget`, `KeyboardTarget`, bounds-math helpers (`computeUIRect`, `computeWorkspaceRect`, `clampSize`), mode→z-order helpers. |
| `src/boundaries/shell/view-manager.conformance.ts`                  | **New.** `ConformanceProbe` + `runViewManagerConformance`.                                                                                                                             |
| `src/boundaries/shell/webcontents-view-manager.integration.test.ts` | Renamed from `view-manager.integration.test.ts`. Invokes conformance suite; keeps WebContents-specific tests.                                                                          |
| `src/main.ts`                                                       | `new ViewManager(...)` → `new WebContentsViewManager(...)`.                                                                                                                            |
| `src/modules/view-module.ts`                                        | No call-site changes — still uses `IViewManager`, still calls `viewManager.create()`.                                                                                                  |
| `src/modules/devtools-module.ts`                                    | Uses `DevtoolsTarget` getters; stops depending on `ViewBoundary`.                                                                                                                      |
| `src/modules/shortcut-module.ts`                                    | Uses `KeyboardTarget` getters; stops depending on `ViewBoundary` for view-manager-owned handles.                                                                                       |

Modules unaffected: `notification-manager`, `theme-module`, `ui-ipc-module`,
`hibernation-screenshot-module`.

---

## Commit sequence

Each commit compiles, passes `pnpm validate`, leaves tests green.

1. **docs(view-manager): tighten interface invariants in JSDoc.**
   Doc-only change on `view-manager.interface.ts` — attach-before-detach,
   idempotency rules, immediate-replay contract, focus routing per mode.

2. **refactor(view-manager): extract pure helpers and types.**
   Create `view-manager-types.ts`. Move `UIMode`, `WorkspaceState` shape, and pure
   bounds/z-order helpers out of `view-manager.ts`. `view-manager.ts` imports them.

3. **refactor(view-manager): rename ViewManager → WebContentsViewManager.**
   Rename `view-manager.ts` → `webcontents-view-manager.ts`. Rename
   `view-manager.integration.test.ts` →
   `webcontents-view-manager.integration.test.ts`. Update class name + `main.ts`
   import. Tests still target the concrete class.

4. **refactor(view-manager): extract BaseViewManager (template method).**
   Add `view-manager-base.ts`. Move mode / active-workspace / focus / loading /
   bounds / registry / event-bus state and orchestration into
   `BaseViewManager<TImplState>`. Convert `WebContentsViewManager` to extend it
   and implement the protected abstract primitives. Largest commit — keep it
   mechanical: cut-and-paste with `protected abstract` stubs filled in, no logic
   edits. The existing integration test is the safety net.

5. **test(view-manager): introduce conformance suite and Probe type.**
   Add `view-manager.conformance.ts`. Move impl-agnostic test cases out of the
   integration file into the suite. The integration file calls
   `runViewManagerConformance({ makeFactory })` and retains only WebContents-
   specific tests. The WebContents factory builds a `ConformanceProbe` over the
   existing `ViewBoundaryMock`.

6. **refactor(view-manager): concrete defaults for reloadAllViews + port.**
   Move the iterate-and-reload body into `BaseViewManager.reloadAllViews` (calls
   the `reloadView` primitive). Move port storage into the base; subclass reads
   via `getCodeServerPort()`. Keeps the `WebContentsViewManager` lighter and
   forces the shape that the alt impl will get for free.

7. **feat(view-manager): introduce DevtoolsTarget + KeyboardTarget capabilities.**
   Add the two interfaces in `view-manager-types.ts`. Add the four capability
   getters on `IViewManager`. Implement on `BaseViewManager` via abstract
   `makeDevtoolsTarget` / `makeKeyboardTarget` primitives. Implement those on
   `WebContentsViewManager` as closures over `viewLayer`. **Both old and new
   getters coexist** in this commit — nothing is removed yet, so consumers stay
   green. Conformance suite picks up its capability-getter assertions.

8. **refactor(view-manager): drop getUIViewHandle / getWorkspaceView.**
   Rewire `devtools-module` and `shortcut-module` to use the capability getters.
   Remove the old methods from `IViewManager`, `BaseViewManager`, and
   `WebContentsViewManager`. `devtools-module` and `shortcut-module` no longer
   need `ViewBoundary` for view-manager-owned handles (verify imports).

> Commits 7–8 modify `IViewManager` and therefore trigger CLAUDE.md's
> "API/IPC Interface Changes" rule. Surface this explicitly on the PR for
> approval before merging those commits.

---

## Verification

After each commit:

- `pnpm test` — all green; no skipped tests.
- `pnpm validate` — typecheck + lint + format pass.

After commit 8:

- Inspect the conformance suite: at least the 10 listed behavioral assertions
  run; impl-specific tests cover retry, watchdog, render-process-gone,
  navigation, DirectComposition.
- `pnpm dev`: create a workspace, switch between workspaces in normal mode, enter
  shortcut mode (Alt+X), open a dialog, hover the sidebar — verify no visual
  flicker on switch, no focus loss, loading overlay appears for new workspaces
  and clears on first agent status update.
- Devtools shortcuts (Ctrl+Shift+D on UI, Ctrl+Shift+W on active workspace) both
  work — exercises the new `DevtoolsTarget` path end-to-end.
- Shortcut mode keyboard navigation still works — exercises the new
  `KeyboardTarget` path end-to-end.
- Resume from sleep (or trigger the experimental resume path): `reloadAllViews()`
  still recovers all workspaces.

End-to-end UI verification matters: tests verify code correctness, not the
visual-continuity / focus / z-order behavior that this refactor explicitly
preserves.

---

## Risks & hidden couplings (must-preserve list)

1. **Attach-before-detach sequencing** in `setActiveWorkspace` is a hard visual
   continuity contract (no blank frame).
2. **Z-order re-adjustment after active-workspace switch** while in
   `dialog`/`shortcut`/`hover`: the UI handle must end up on top again.
3. **Immediate replay of `loading=false`** when an `onLoadingChange` subscriber
   registers after a workspace already loaded. The startup-splash flow in
   `view-module.ts` depends on this.
4. **Loading-workspace bounds updated while detached** so code-server's layout
   is right the moment it's revealed.
5. **Reentrancy guard** `isChangingWorkspace` — bounds + focus calls inside the
   guarded section are skipped on re-entry.
6. **Idempotency** of `setMode`, `setActiveWorkspace(samePath)`,
   `setWorkspaceLoaded`, `destroyWorkspaceView`.
7. **`destroying` flag suppresses focus ops during shutdown** — alternative impls
   must respect this or shutdown will reach into freed handles.
8. **`needsReloadOnAttach` + 15s watchdog + recreate** are WebContents quirks;
   they stay in the subclass.
9. **Windows DirectComposition workaround** stays inline in the subclass's
   `attachView` override; do not promote to the base.
10. **`KeyboardTarget.id` must equal the underlying handle id** so
    `shortcut-module`'s map (currently keyed by `handle.id`) keeps de-duplicating
    correctly across registrations.
11. **Two-phase init (`new` + `create()`)** remains a contract; `create()` stays
    on `IViewManager`. `view-module.ts`'s `app-start/init` hook continues to own
    the timing.

---

## Phase 2: iframe integration

The seam this refactor created is used by a second `IViewManager` implementation,
`IframeViewManager` (`src/boundaries/shell/iframe-view-manager.ts`), gated behind
the `experimental.iframes` config flag (default `false`, requires app restart).

### Shape

- One shared `WebContentsView` (`workspace-host`) loads `workspace-host.html`,
  which holds one `<iframe>` per workspace keyed by path.
- All workspaces share a single renderer process — the memory win.
- Per-workspace state still flows through `BaseViewManager`; every state's
  `handle` is the host view handle, and `attachViewImpl` / `detachViewImpl`
  toggle `display: block` / `none` on the right iframe via injected JS
  (`window.__host.show/hide/add/remove`).

### One base hook added

`BaseViewManager.shouldAttachWhileLoading(): boolean` (default `false`).
`IframeViewManager` overrides it to `true` because iframes that are
`display: none` don't lay out — VS Code's workbench needs to be visible so it
renders, otherwise `terminal.focus` lands on an unmounted terminal at
agent-idle time.

### Composition

`main.ts` reads the flag once at startup and picks the implementation:

```ts
const useIframes = configService.get("experimental.iframes") as boolean;
const viewManager: IViewManager = useIframes
  ? new IframeViewManager({ ... })
  : new WebContentsViewManager({ ... });
```

### Stubbed in the iframe impl (matches "experimental" label)

- Per-workspace `did-fail-load` retry — failures show as broken iframes.
- Per-workspace `render-process-gone` recovery — host-renderer-wide.
- Reload watchdog.
- Per-workspace DevTools — routed to the host (all workspaces share).
- Per-workspace keyboard input target — routed to the host.

### Initial terminal focus

`main.ts` subscribes to `agent:status-updated` (focuses terminal when the
active workspace's agent becomes idle, once per session) and
`workspace:switched` (queries status; if idle, focuses terminal). Tracked via
a `firstFocused` set so subsequent switches let Chromium's native focus
restoration take over. These subscriptions are registered unconditionally —
harmless in WebContentsView mode (event fires, dispatch runs, no observable
side effect).

### Tests

`src/boundaries/shell/iframe-view-manager.integration.test.ts` runs the
same conformance suite as the WebContentsView impl, plus iframe-specific
tests (host lifecycle, `shouldAttachWhileLoading`, hostExec queue draining).
