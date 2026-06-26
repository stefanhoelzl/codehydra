# UI State Architecture — Backend-Held UI State

**Status**: Design agreed (2026-06-11). **All phases complete (2026-06-26).**
A: presenter + `UiState` snapshot + full renderer cutover (no stores; `App` holds
`$state.raw`, props down). B: the surface is now exactly **2 channels**
(`api:ui:state` down, `api:ui:event` up) with theme folded into the snapshot.
C: the dialog/notification frameworks are unified in a presenter-owned
`modules/presentation/` folder, with the deletion dialog reading progress from
the presenter (single source of truth). D: **reframed** — the docs were brought
in line with reality (`docs/ARCHITECTURE.md`, `PATTERNS.md`, `INTENTS.md`), and
the planned "absorb `WindowManager`/`UiViewManager` into the presenter" was
**rejected**: those are shell infrastructure used by ~7 modules, and the
presenter is already narrowly coupled to them (`Pick<IViewManager,
"sendToUI"|"onFromUI">` + a theme accessor), so they stay as shell seams.

Now that the app uses a single WebContentsView hosting `index.html` with workspaces as
iframes, the complete semantic UI state moves into the main process. The renderer becomes
a pure render function of a snapshot pushed over IPC. This kills every dual-source
reconciliation hack, collapses the IPC surface to two channels, and makes UI behavior
testable headlessly in main.

## Goals

1. **Kill dual-source reconciliation** — `__pending__` name-matching, `_lastEmittedMode`
   dedup, modal-sweep-on-panel-open, `_switchingWorkspace` guard.
2. **Shrink the IPC surface** — 21 channels → 2.
3. **Make the renderer dumb & testable** — behavior logic moves to main; components become
   pure functions of (snapshot props, local ephemeral state).

## Decisions

| Branch           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State line       | Semantic state in main; ephemeral (hover, in-flight edits, focus/scroll/animation) stays renderer-local. Rule: if two components or main+renderer both care, it's main's.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sync model       | Single full-`UiState`-snapshot push, coalesced per microtask. No diffs, no versioning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Up channel       | One generic `ui:event` discriminated union, zod-validated at the boundary. `log` is a variant of it (no separate channel).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Snapshot type    | Dedicated `UiState` view-model in `src/shared` — NOT domain types. Render-ready: sorted projects, inline flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Lifecycle        | Each workspace entry carries `status: creating\|ready\|deleting\|delete-failed`, an **orthogonal** `hibernated: boolean` (a hibernated workspace is still `ready`/`deleting` — sleep is layered on the lifecycle, not a phase), and an optional render-ready `deletionProgress` (present while deleting/delete-failed; `status` derives from it). Presenter inserts/swaps `creating` placeholders internally. The `deletionProgress` detail-consumer (snapshot-driven deletion dialog) lands in Phase C; until then it rides along carrying the data the presenter derives `status` from. |
| UI mode          | Computed only in main from state it owns (dialogs, panel, shortcut) + a hover `ui:event`. The setMode/mode-changed feedback loop dies.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shortcuts        | Main interprets keys directly against its own state. `shortcut:key` push channel and renderer shortcuts logic die.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Switching        | Strict round-trip (keypress → ui:event → main → snapshot → iframe swap). No optimistic highlight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Gathering        | Central presenter subscribes to domain events (no slice-contribution model). Registered before `app:start` ⇒ witnesses events from genesis, no initial pull.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Module shape     | ONE presentation module: owns IPC, view-model, mode, shortcut interpretation, domain-event→dialog/notification mapping, dispatches intents from ui:events. ~~Absorbs WindowManager/ViewManager~~ — **not done (Phase D reframe)**: those are shell infra used by ~7 modules; the presenter stays narrowly coupled (`Pick<IViewManager,"sendToUI"\|"onFromUI">` + theme accessor) and they remain shell seams.                                                                                                                                                                             |
| Dialog framework | DialogManager/NotificationManager DISSOLVE. Domain modules become UI-agnostic and emit domain events only; presenter maps them to dialogs/notifications. Creation-form logic becomes a presenter sub-module.                                                                                                                                                                                                                                                                                                                                                                              |
| Confirmations    | Parked dispatch: intent payload carries `interactive`; the operation calls a `UserInteraction` capability (presenter-provided, **new approved interface**) that opens the dialog and resolves with the user's answers (keepBranch, force, blocking PIDs).                                                                                                                                                                                                                                                                                                                                 |
| Local dialogs    | RemoveWorkspaceDialog / CloseProjectDialog migrate into this model (no renderer-local dialogs remain).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Renderer state   | NO stores. `App.svelte` holds `let ui = $state.raw(...)`, reassigned by `api.onState`; props all the way down. `stores/` directory is deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| IPC names        | `api:ui:state` (main→renderer), `api:ui:event` (renderer→main). Preload: `window.api = { onState(cb), send(event) }` + existing `__ch*` window hooks. **User-approved IPC change.**                                                                                                                                                                                                                                                                                                                                                                                                       |

## Wire diagrams

### Big picture — two wires

```
┌───────────────────────────────┐ ELECTRON MAIN  ┌──────────────────────────────┐ RENDERER
│                               │                │                              │
│   Domain modules & services   │                │   Svelte UI (dumb view)      │
│   (project, workspace, agent, │                │                              │
│    deletion, updater, clone…) │                │   App.svelte                 │
│        │            ▲         │                │   ┌──────────────────────┐   │
│        │ domain     │ intent  │                │   │ let ui = $state.raw  │   │
│        │ events     │ dispatch│                │   │ api.onState(s=>ui=s) │   │
│        ▼            │         │                │   └─────────┬────────────┘   │
│   ┌─────────────────┴──────┐  │  api:ui:state  │             │ props          │
│   │  PRESENTATION MODULE   │ ────────────────────►           ▼                │
│   │                        │  │  (full UiState │   <MainView {ui}/>           │
│   │  · UiState view-model  │  │   snapshot,    │    ├ Sidebar                 │
│   │  · mode computation    │  │   coalesced)   │    ├ WorkspaceFrames         │
│   │  · shortcut interpret  │  │                │    ├ PanelView               │
│   │  · domain→dialog map   │  │  api:ui:event  │    ├ DialogHost              │
│   │  · UserInteraction svc │ ◄────────────────────  └ NotificationStack       │
│   │  · Window/ViewBoundary │  │  (zod-checked  │             │                │
│   └────────────────────────┘  │   union, incl. │             │ api.send(...)  │
│                               │   log)         │   { switch-workspace,        │
│                               │                │     request-delete, hover,   │
│                               │                │     dialog-action, log, … }  │
└───────────────────────────────┘                └──────────────────────────────┘

   2 channels total — all 21 existing channels die.
   (__chFocusActiveFrame / __chActiveFrameRect window hooks stay for
    main-initiated queries: screenshot rect, focus refresh)
```

### Inside main — the presenter as the single convergence point

```
  domain modules                      PRESENTATION MODULE                      renderer
 ───────────────                ────────────────────────────────              ─────────

 project:opened ────────┐
 workspace:created ─────┤      ┌──────────────────────────────┐
 workspace:loading ─────┤      │     UiState view-model       │
 workspace:removed ─────┼─────►│     (render-ready: sorted,   │
 status-changed ────────┤      │      flags inline)           │
 deletion-progress ─────┤      │                              │
 metadata-changed ──────┤      │  projects[]                  │   coalesce
 update:available ──────┤      │   └ workspaces[]             │   per microtask
 clone:progress ────────┘      │      · status: creating|     │ ──────────────► ui:state
                               │        ready|deleting|       │
 (presenter registered         │        delete-failed|        │
  before app:start ⇒ sees      │        hibernated            │
  events from genesis;         │      · deletionProgress?     │
  no initial pull)             │  activeWorkspacePath         │
                               │  mode  (computed HERE)       │
                               │  dialogs[] / panel           │
                               │  notifications[]             │
                               │  theme · bootstrap info      │
                               └──────────────────────────────┘

                               ┌──────────────────────────────┐
            ui:event ─────────►│         event router         │
                               │                              │
   { kind: switch-workspace }  │──► dispatch workspace:switch │
   { kind: request-delete }    │──► dispatch workspace:delete │
   { kind: open-project }      │──► dispatch project:open     │      intents
   { kind: dialog-action }     │──► resolve parked            │ ──────────────►
   { kind: form-change }       │    UserInteraction           │   dispatcher
   { kind: hover-changed }     │──► presenter-local           │
   { kind: log }               │    (mode recompute) / logger │
                               └──────────────────────────────┘
```

The `__pending__` hack dies here: `workspace:loading` makes the presenter insert a
`status: "creating"` entry into its own view-model and swap it on `workspace:created` —
the renderer only ever renders the array.

### Renderer — one signal, props down, events up

```
              api:ui:state                          api:ui:event
                   │                                     ▲
                   ▼                                     │
   ┌─ App.svelte ─────────────────────────────────────────────────────┐
   │  let ui = $state.raw(EMPTY)     ← only rune for server state;    │
   │  api.onState(s => ui = s)         plain `let` is NOT reactive    │
   │                                   in runes mode; raw = replace-  │
   │                                   only, no deep-proxy overhead   │
   └──────────────┬───────────────────────────────────────────────────┘
                  │ {ui} props (read-only; raw ⇒ local patching impossible)
                  ▼
   ┌─ MainView ───────────────────────────────────────────────────────┐
   │   Sidebar {ui.projects} {ui.mode}      WorkspaceFrames {ui...}   │
   │   PanelView {ui.panel}                 DialogHost {ui.dialogs}   │
   │   NotificationStack {ui.notifications}                           │
   │                                                                  │
   │   leaves keep PRIVATE $state for ephemeral only:                 │
   │     hover + debounce timers · Form in-flight edits               │
   │     (seed once per session id) · focus/scroll/animation          │
   └──────────────────────────────────────────────────────────────────┘

   stores/ directory: deleted. No uiState store, no module singletons.
   Components are pure functions of (snapshot props, local ephemeral).
```

### Parked confirmation — `workspace:delete` end to end

```
 renderer              presenter                dispatcher           delete operation
 ────────              ─────────                ──────────           ────────────────
    │  ui:event            │                        │                      │
    │  {request-delete} ──►│                        │                      │
    │                      │ dispatch               │                      │
    │                      │ workspace:delete ─────►│ hooks/interceptors   │
    │                      │ {interactive: true}    │ (idempotency…) ─────►│
    │                      │                        │                      │ inspects: dirty?
    │                      │   UserInteraction      │                      │ unmerged? blocking
    │                      │◄──.confirm(warnings)───┼──────────────────────│ PIDs?
    │   ui:state           │                        │                      │
    │◄─ (dialog open) ─────│ dialog in view-model   │      ⏸ dispatch parks│
    │                      │                        │                      │
    │  ui:event            │                        │                      │
    │  {dialog-action:     │                        │                      │
    │   confirm, keepBranch│ resolve parked promise │                      │
    │   force, pids} ─────►│ ───────────────────────┼─────────────────────►│ ▶ proceeds
    │                      │                        │                      │ (dismiss ⇒ typed
    │   ui:state           │                        │                      │  abort, not error)
    │◄─ (dialog gone, ─────│◄── deletion-progress ──┼──────────────────────│
    │    ws "deleting") …  │    domain events       │                      │

 MCP / plugin / auto-workspace: dispatch WITHOUT `interactive`, pass
 force/keepBranch up front ⇒ UserInteraction never invoked, no dialog.
 app:shutdown ⇒ all parked interactions resolve as dismissed ⇒ clean aborts.
```

### What dissolves vs. what survives

```
 DELETED                                   │  SURVIVES
 ──────────────────────────────────────────│──────────────────────────────────────
 renderer:                                 │  renderer (ephemeral, component-local):
   entire stores/ directory —              │    hover + debounce timers
   projects · agent-status ·               │    Form in-flight edits (seed-once
   workspace-lifecycle · ui-mode ·         │     per session id; main forces
   shortcuts logic · new-workspace-view ·  │     reseed via field revision)
   dialog-framework · dialogs ·            │    focus / scroll / animation
   notification-store · bootstrap          │    $lib/api re-export (send/onState)
     → App-owned $state.raw + props        │
                                           │  main:
 main:                                     │    WindowBoundary / ViewBoundary seams +
   IPC event bridge (14 typed channels)    │     WindowManager / UiViewManager classes
   setMode/mode-changed feedback loop      │     (shell infra, ~7 module consumers —
   _lastEmittedMode dedup · modal sweep    │      Phase D reframe: NOT absorbed)
   __pending__ name reconciliation         │    DialogManager / NotificationManager
   _switchingWorkspace guard               │     unified in presentation/sessions.ts
   typed invoke channels (api:workspace:*, │    domain modules — fully UI-agnostic,
    api:project:*, api:ui:*, api:log)      │     emit domain events only
   separate api:ui:theme channel           │    creation-form stays a standalone module
                                           │    parked nextEvent() confirmations
                                           │     (no separate UserInteraction iface)
```

## Invariants

- **Seed-once forms**: Form owns in-flight field state, seeded from the dialog config
  only when the session id changes (object identity changes on every snapshot — never
  key on it). Main-initiated mid-session value overwrites require an explicit per-field
  revision counter that forces a reseed. This is the only defense against snapshot
  echoes clobbering fast typing on `changeEvent` fields.
- **`$state.raw` for the snapshot**: replace-only, no deep proxies. Local patching of
  the snapshot is physically impossible — the renderer cannot drift from main's truth.
  If profiling ever shows re-evaluation cost, split into a few root `$derived` slices
  (reference-equality short-circuit); hold in reserve, don't start there.
- **Shutdown resolves parked interactions**: on `app:shutdown`, every pending
  `UserInteraction` resolves as _dismissed_; operations abort cleanly (typed abort
  outcome, not an error). No hung dispatch can block quit.
- **Idempotency covers parked re-dispatch**: a second `workspace:delete` for the same
  key while the first is parked is handled by the existing per-key idempotency rules.
- **No optimism anywhere**: the renderer never anticipates main. If latency is ever
  perceptible (it shouldn't be — same-machine structured-clone IPC), fix coalescing in
  main, not with renderer-side optimistic state.
- **Coalescing**: presenter batches view-model writes and sends at most one snapshot
  per microtask.

## Open items

- **Phasing**: A read path (presenter + snapshot + renderer cutover) — **DONE** →
  B write path (ui:event, shortcuts + mode to main, delete typed channels) —
  **DONE** (dead `api:project:*`/`api:workspace:*` constants removed; theme
  folded into the snapshot and `theme-module` + the `api:ui:theme` channel
  deleted; dead preload `on()` generic + the orphaned `ApiEvents` map removed;
  surface is now exactly `ui:state` + `ui:event`) → C dialogs — **DONE**, though
  reality reshaped the sketch: the managers are load-bearing (9 callers), so
  rather than "dissolve" they were **unified** into one generic `SessionRegistry`
  core and co-located in a presenter-owned `modules/presentation/` folder; the
  parked-`nextEvent()` pattern was kept as the confirmation mechanism (no
  separate `UserInteraction` interface); the creation form stays a standalone
  module; local dialogs were already migrated; and the deletion dialog now reads
  progress from the presenter (the single owner of the full `DeletionProgress`),
  which derives the render-ready `deletionProgress` onto the row → D shell
  absorption — **DONE as a reframe**: the literal "absorb window/view managers
  into the presenter" was rejected (they're shell infra for ~7 modules; the
  presenter is already narrowly coupled), so they stay as shell seams; the
  substantive work was bringing `docs/` in line with reality + verifying
  appctrl.
- **docs/** updates (ARCHITECTURE.md, PATTERNS.md, INTENTS.md) — **DONE** (Phase D):
  renderer-no-stores, 2-channel IPC, main-computed mode, presenter as convergence
  point, unified `presentation/` sessions, deletion single-source.
- **appctrl** frame targeting hooks (`__chFocusActiveFrame` / `__chActiveFrameRect` /
  `__chReloadFrames`) unaffected by design; still installed by `WorkspaceFrames.svelte`
  and called by `UiViewManager` — verify in the running app.
