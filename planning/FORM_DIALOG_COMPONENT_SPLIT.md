# Form / Dialog Component Split

Status: IMPLEMENTED (tests + lint + typecheck green; visual parity verified via appctrl)
Scope: renderer-only refactor. Foundational task for the larger "migrate the
workspace-creation view onto the declarative form framework" effort.

---

## Context

The larger effort migrates the hand-rolled `NewWorkspaceView.svelte` onto the
declarative dialog framework, generalized into a declarative **form** framework:
creation logic moves to a main-process module, and the renderer becomes a dumb
declarative renderer plus a thin, renderer-owned panel shell.

The originally-scoped task here was "add a form layout mode (left-aligned labeled
rows)". During design review we **narrowed it**: that layout mode and its
required `label` field are a _behavior_ change and belong to the later task that
actually builds the creation form/panel. This task is the **structural seam**
those later tasks build on, and nothing more.

**This task = a pure component split, with no behavior change and no shared-type
change:** extract the declarative renderer (`DialogView`'s sections + actions)
into a new `Form.svelte`; `DialogView.svelte` becomes the modal shell that wraps
`<Form>`. The future creation panel (task #10) will be a _second_ surface that
wraps the same `Form`.

```
TODAY:           DialogHost ──> DialogView (modal chrome + section/action rendering)
AFTER THIS TASK: DialogHost ──> DialogView (modal chrome) ──> Form (sections + actions)
LATER (#10):     PanelShell ──> Form          ← same renderer, different surface
```

### Why a seam, and why now

`Form` becomes the single declarative renderer that both the modal-dialog surface
(today) and the creation-panel surface (#10) consume. Later tasks graft onto
`Form`: #3 (per-field error slot), #7 (select/combobox), #8 (field-attached
buttons). Establishing the surface/renderer seam first means those tasks touch
one renderer, and the panel surface gets a clean component to host.

### Important: two parallel dialog systems exist (only one is in scope)

The renderer currently has **two** independent dialog systems. This task touches
only the declarative one. Naming the distinction up front avoids confusion:

|                    | Old (renderer-authoritative, imperative)                                                                                                                       | New (backend-driven, declarative) — IN SCOPE                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| State store        | `stores/dialogs.svelte.ts` (`DialogState`: remove / close-project / git-clone)                                                                                 | `stores/dialog-framework.svelte.ts` (`SvelteMap<id, DialogEntry>`)                                                               |
| Generic modal      | `components/Dialog.svelte` (focus-trap + overlay + snippet slots)                                                                                              | `components/DialogView.svelte` (backdrop + card + sections)                                                                      |
| Concrete dialogs   | `RemoveWorkspaceDialog` / `CloseProjectDialog` / `GitCloneDialog` / `OpenProjectErrorDialog`, switched in `MainView.svelte` via `{#if dialogState.value.type}` | authored by main-process modules (`bug-report-module`, `deletion-dialog-module`) via `DialogManager`                             |
| Driven by          | renderer calls `openRemoveDialog()` etc.                                                                                                                       | `DialogManager` → `dialog:command` IPC → `processCommand`                                                                        |
| Fate in the effort | **moves to backend / gets retired** as each dialog becomes a `DialogManager` module                                                                            | **stays** — `dialog-framework` store is the renderer's passive projection of backend commands; `DialogHost` is the dumb receiver |

Consequences this plan relies on:

1. **The host stays.** Moving logic to the backend moves _authoring_, not
   _rendering_. The renderer still needs a local list of currently-open dialogs
   to paint (`dialog-framework`'s map) and a component subscribed to the IPC
   (`DialogHost`). Neither is removed by this task or the broader effort.
2. **`Dialog.svelte` is already taken** by the legacy generic modal, so the
   modal shell is **not** renamed to `Dialog`. It keeps the name `DialogView`,
   which means `DialogHost.svelte` and all imports are untouched.

---

## Files

| File                                                            | Change                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/renderer/lib/components/Form.svelte`                       | **NEW** — declarative renderer: section loop + actions + state + events + section CSS |
| `src/renderer/lib/components/DialogView.svelte`                 | **MODIFIED** — reduced to the modal shell; renders `<Form>`                           |
| `src/renderer/lib/components/Form.test.ts`                      | **NEW** — section/action/event tests (moved from `DialogView.test.ts`)                |
| `src/renderer/lib/components/DialogView.test.ts`                | **MODIFIED** — slimmed to surface-only tests                                          |
| `src/renderer/lib/components/DialogHost.svelte`                 | **UNCHANGED** (no rename)                                                             |
| `src/shared/dialog-types.ts`                                    | **UNCHANGED** (see Approval-Needed)                                                   |
| `stores/dialogs.svelte.ts`, `stores/dialog-framework.svelte.ts` | **UNCHANGED** (out of scope)                                                          |

---

## Where the seam is drawn

Reference: current `DialogView.svelte` (single file today).

### Moves into `Form.svelte` (the declarative renderer)

Props: `{ dialogId: string; config: DialogConfig }` — `Form` consumes the
**existing** `DialogConfig` as-is and uses only `config.sections` +
`config.actions` (it ignores `config.modal`, which is the shell's concern).

Move verbatim from `DialogView.svelte`:

- **State** — `selectionState` and `inputState` (`DialogView.svelte:32–36`).
- **Reactive seeding `$effect`s** — selection-state init (`39–50`) and
  input-value seeding (`54–69`).
- **`onMount` selection auto-focus** (`72–77`) — re-point its
  `cardRef.querySelector("[aria-checked='true']")` query at `Form`'s own root
  element ref (see CSS note below).
- **`seedCursor` Svelte action** (`87–124`).
- **Helpers** — `getSelectionData` (`128–136`), `getInputData` (`139–147`),
  `handleAction` (`150–162`, calls `sendDialogEvent` from `$lib/api`),
  `parseTextContent` (`165–182`), `getStatusIcon` (`184–196`),
  `getStatusClass` (`198–208`).
- **Markup** — the entire `{#each config.sections}` section switch (`222–422`)
  and the actions footer (`424–441`).
- **CSS** — all section + action styles (`486–786`): `.section-*`,
  `.progress-*`, `.selection-*`, `.table-*`/`table`/`th`/`td`, `.input-*`,
  `.actions`, plus `.spinner-inline`.
- **Imports** — `Icon`, `sendDialogEvent`, the `@shared/dialog-types` types,
  `onMount`/`untrack`.

`Form`'s root element is a new wrapper (e.g. `<div class="form">`) carrying the
inner-layout rules that `.card` provides today, so the visual output is
unchanged (see CSS note). `bind:this` on this root replaces the old `cardRef`
for the auto-focus query.

### Stays in `DialogView.svelte` (the modal shell)

- Props: `{ dialogId, config, workspaceArea = false }` (unchanged signature).
- The `heading` `$derived` (`211–214`) — still used for the `aria-label`.
- Markup: the `.dialog-view` container (with `class:workspace-area`,
  `role="dialog"`, `aria-label={heading}`), the `.backdrop` (`<Logo>`), and the
  `.card`. Inside `.card`, render a single child:
  `<Form {dialogId} {config} />`.
- CSS: `.dialog-view`, `.dialog-view.workspace-area`, `.backdrop`, `.card`
  (`446–484`).
- Imports: `Logo`, `DialogConfig` type, and `Form`. (`cardRef`,
  `sendDialogEvent`, `Icon`, and all section helpers are removed — they moved.)

---

## CSS approach (the one real regression-risk point)

The DOM gains exactly one wrapper level: `.card > [sections…]` becomes
`.card > .form > [sections…]`. The split of styling must keep output identical.

Today `.card` (`DialogView.svelte:470–484`) does **both** surface and
inner-layout duty:

```css
.card {
  position: relative; /* surface */
  display: flex; /* inner layout ↓ */
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  max-width: 500px;
  width: 100%; /* surface */
  padding: 2rem; /* surface */
  text-align: center; /* inherited by sections */
  background: …;
  border: …;
  border-radius: …;
  box-shadow: …; /* surface */
}
```

Split it:

- **`.card` (stays in `DialogView`)** keeps the _surface_ rules: `position`,
  `max-width`, `width`, `padding`, `text-align: center`, `background`, `border`,
  `border-radius`, `box-shadow`. It now has a single child (`.form`), so its old
  inter-child `gap` is irrelevant; `align-items`/`flex` may stay or be dropped
  without visual effect (one full-width child).
- **`.form` (new, in `Form`)** takes the _inner-layout_ rules:
  `display: flex; flex-direction: column; align-items: center; gap: 0.75rem; width: 100%;`.
  `text-align: center` is inherited from `.card`, so centered text sections
  render exactly as before; section-level `text-align: left` overrides
  (`.section-mono`, `.table-container`) are unaffected.

Net: identical layout, no double-gap (the gap lives only on `.form`), padding
still around the content. This is the only place to eyeball after implementing
(see Verification).

---

## Accessibility

No accessibility change — associations stay where they are:

- `role="dialog"` + `aria-label={heading}` remain on `.dialog-view` in the shell
  (`DialogView.svelte:217`).
- `.backdrop` keeps `aria-hidden="true"`.
- Section-level roles/labels move _with_ their markup into `Form` and are
  byte-for-byte the same: `role="status"`/`aria-live` on progress,
  `role="radiogroup"`/`role="radio"`/`aria-checked` on selection,
  `aria-label` on inputs and progress bars, table semantics.
- Keyboard behavior (selection arrow-key nav, Enter-fires-primary-action,
  `seedCursor` Alt-keyup refocus) moves intact into `Form`.

(The `<label for>` / per-field-id accessibility work belongs to the later
labeled-rows task, not this one.)

---

## Out of scope (explicit)

- **No form layout / labeled rows.** Only the existing centered dialog layout
  exists after this task.
- **No `label?` field** (or any other) added to `src/shared/dialog-types.ts`.
  The labeled-row layout + its shared-type change live in the follow-up task that
  builds the creation form; that task will need shared-type approval.
- **No `layout` prop** on `Form` or `DialogConfig`.
- **No panel surface** (task #10).
- **No migration/retirement** of the legacy `Dialog.svelte` /
  `dialogs.svelte.ts` / hand-rolled dialogs — separate effort.
- **No store or IPC changes.**

---

## Tests (`@testing-library/svelte`, < 50 ms each)

Pattern follows the existing `DialogView.test.ts`: render the component directly
with a `DialogConfig`, mock `$lib/api` (`sendDialogEvent`).

**`Form.test.ts` (new)** — move the section/action tests out of
`DialogView.test.ts` and render `<Form>` directly:

- text sections (heading→`h1`, subtitle, mono, default paragraph)
- `{badge:…}` parsing
- progress sections (labels; indeterminate bar `aria-label`)
- selection sections (renders cards; click selects; arrow-key nav)
- table sections (header + columns + rows)
- input sections (`selectInitialValue` selects text; `cursorOffset` caret;
  Alt-keyup refocus)
- actions (render; click → `sendDialogEvent` with `dialogId`/`actionId`;
  disabled/busy don't fire; busy shows `busyLabel`; selection data included)

**`DialogView.test.ts` (slimmed)** — surface-only, rendering `<DialogView>`:

- `role="dialog"` present
- `aria-label` equals heading text
- `.backdrop` has `aria-hidden="true"`
- `workspaceArea` toggles the `.workspace-area` class (left offset)
- one smoke test that a section (e.g. a heading) renders _through_ `Form`

**Unchanged (must stay green — proves no behavior change):**
`bug-report-module.integration.test.ts`,
`deletion-dialog-module.integration.test.ts`,
`dialog-manager.integration.test.ts`, `MainView.test.ts`,
`dialog-framework.svelte.test.ts`.

---

## Approval-Needed

**None for this task.** It is a renderer-only component split:

- No IPC channel/signature changes.
- No intent/event/shared-type changes — `src/shared/dialog-types.ts` is
  untouched; `Form` consumes the existing `DialogConfig`.
- No new boundary interfaces / External System Access entries.

(The deferred labeled-rows task **will** require approval to add `label?` to
`src/shared/dialog-types.ts`. Flagging here so it isn't forgotten.)

---

## Verification

1. `pnpm test` — `Form.test.ts` + slimmed `DialogView.test.ts` pass; all
   integration tests above stay green.
2. `pnpm validate:fix` — lint/format/types clean (no `any`, no ignore comments).
3. Visual parity check (the DOM-nesting change): launch the app and trigger a
   declarative dialog — e.g. the **bug report** dialog, or a workspace
   **deletion** (progress + optional blockers table) — and confirm the backdrop,
   centered card, section spacing, and actions look identical to before. The
   `appctrl_*` MCP tools (or `pnpm dev`) can drive this; `appctrl_screenshot`
   for a before/after compare.
