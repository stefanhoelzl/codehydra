/**
 * Dialog framework types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 *
 * Dialogs are composed from ordered sections (building blocks). Buttons are
 * declared inside group sections — a trailing button-only group is the footer
 * (submit/cancel); a group mixing a field with buttons attaches side-flow
 * buttons to that field's row. The backend sends the full config; a generic
 * renderer displays it.
 */

// ---- Sections ----

/**
 * Text section - displays a text element with optional styling and icon.
 *
 * - style "heading": large + bold (h1-like)
 * - style "subheading": medium + semibold (h2-like); a subordinate section
 *   header (e.g. a settings group's nested sub-group).
 * - style "subtitle": small + dim
 * - style "warning" / "error": alert box (icon + tinted background). The two
 *   styles state semantic intent — a caution the user should weigh vs. a
 *   failure — and map to the warning/error theme colors.
 * - default: normal paragraph
 * - icon: codicon name rendered before text (e.g., "error" for danger
 *   styling). Alert styles default to the "warning" icon when unset.
 */
interface TextSection {
  readonly type: "text";
  readonly content: string;
  readonly style?: "heading" | "subheading" | "subtitle" | "warning" | "error";
  readonly icon?: string;
  /** Indentation depth (0 = flush). Each level indents the text left-to-right. */
  readonly indent?: number;
}

/**
 * Progress section - displays a list of progress items with status indicators.
 *
 * - style "bar" (default): running items show a progress bar
 *   (undefined progress = indeterminate, else determinate)
 * - style "spinner": running items show a spinner ring
 */
interface ProgressSection {
  readonly type: "progress";
  readonly items: readonly ProgressItem[];
  readonly style?: "bar" | "spinner";
}

/**
 * Per-field opt-in for emitting field-change events to the backend as the user
 * edits a field, BEFORE submit. Lets the backend react (validation, dependent
 * options) and push handle.update().
 *
 * - absent / false: the field never emits change events (default — existing
 *   dialogs stay silent).
 * - true / {}: emit, using the field type's default debounce. A discrete field
 *   (radio) emits immediately (0ms); a continuous field (input, dropdown
 *   typing) debounces 200ms. Dropdown suggestion picks are discrete and always
 *   emit immediately.
 * - { debounceMs }: emit with a custom debounce in ms (0 = immediate). Applies
 *   to any field type, so a radio can coalesce rapid keyboard navigation.
 */
export type FieldChangeConfig = boolean | { readonly debounceMs?: number };

/**
 * Field section base — sections that hold a user-editable value reported in
 * DialogUserEvent.data.
 *
 * - id: stable field id. The field's value is reported in DialogUserEvent.data
 *   keyed by this id. Must be unique among the field sections
 *   (input/radio/dropdown) of a DialogConfig.
 * - label: optional field label rendered above the control. Shown whenever
 *   present; the "form" layout (see DialogConfig.layout) lays fields out as
 *   left-aligned labeled rows.
 * - error: optional validation message rendered as red helper text below the
 *   control, which is also marked invalid (red border). Set/cleared by the
 *   backend via handle.update().
 * - disabled: the control is rendered but not interactive (e.g. fields that
 *   only become editable once another field has a value). A disabled field
 *   still reports its current value in DialogUserEvent.data.
 * - autofocus: focus this control when the form mounts. When a config update
 *   MOVES the flag to a different control (e.g. from a picker button to the
 *   name field once a project exists), focus follows; re-sending the same
 *   target never steals focus. At most one control should carry the flag.
 */
interface FieldSection {
  readonly id: string;
  readonly label?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly autofocus?: boolean;
}

/**
 * Radio section - displays radio-group cards with icon + label.
 * Extends FieldSection (id/label/error).
 *
 * - changeEvent: opt in to emit a field-change event when the radio selection
 *   changes (immediate by default; see FieldChangeConfig).
 */
interface RadioSection extends FieldSection {
  readonly type: "radio";
  readonly options: readonly RadioOption[];
  readonly changeEvent?: FieldChangeConfig;
}

/**
 * Dropdown section - a combobox: a text input with a filtered suggestion
 * list. Extends FieldSection (id/label/error).
 *
 * Suggestions are supplied in groups; a group's optional header renders as a
 * non-selectable divider, shown only while the group has at least one match.
 * Filtering is purely client-side/presentational (case-insensitive substring
 * on the label) and never emits events. The list opens on focus.
 *
 * - freeText false (default): select-like. The field always reports a valid
 *   option value: it starts at the option matching initialValue (else the
 *   first option), typing only filters, and leaving the field with text that
 *   matches no option label reverts to the current choice. A config update
 *   keeps the choice while still valid, else falls back to the first option.
 * - freeText true: the field reports the typed text, or a picked suggestion's
 *   value (the input then displays its label); editing the text again reverts
 *   to reporting the typed text. Seeds from initialValue on first sight.
 * - changeEvent: opt in to field-change events. Picking a suggestion always
 *   emits immediately (cancelling any pending typing debounce); typing (free
 *   text only) debounces 200ms by default. A custom debounceMs applies to
 *   typing only.
 * - loading: the backend is fetching this field's suggestions. Two-phase
 *   update: on the triggering change, push loading: true (typically with
 *   stale suggestions cleared), fetch, then push the real suggestions with
 *   loading: false. Renders a spinner overlaid at the control's right edge;
 *   the control stays interactive and reports its current value as usual.
 *   Independent of any error state (both may be shown at once).
 * - value: controlled value push. When a config update carries a value the
 *   renderer has not adopted yet, the field adopts it (strict mode falls back
 *   to the first suggestion when the value names no suggestion). Re-sending
 *   the same value is a no-op, so user edits between pushes are preserved —
 *   the backend changes the field only by pushing a *different* value.
 * - searchable false (strict mode only): the input is read-only — the field
 *   behaves like a classic select (focus opens the list, arrow keys + click
 *   pick, typing does nothing). Default true (type-to-filter combobox).
 */
interface DropdownSection extends FieldSection {
  readonly type: "dropdown";
  readonly suggestions: readonly DropdownSuggestionGroup[];
  readonly freeText?: boolean;
  readonly searchable?: boolean;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly value?: string;
  readonly changeEvent?: FieldChangeConfig;
  readonly loading?: boolean;
}

/**
 * Table section - displays a data table with optional header.
 */
interface TableSection {
  readonly type: "table";
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly header?: string;
  readonly headerIcon?: string;
}

/**
 * Input section - displays a text input field. Extends FieldSection
 * (id/label/error).
 *
 * - multiline false (default): single-line text field
 * - multiline true: multi-line textarea
 * - rows: initial height of a multiline textarea in text rows (user can still
 *   resize vertically). Without it the textarea gets a tall viewport-relative
 *   default height.
 * - initialValue seeds the field on first render only; later edits are preserved
 * - selectInitialValue selects the seeded text instead of placing a caret, so
 *   the first keystroke replaces it
 * - Input values are included in DialogUserEvent.data keyed by field id when actions fire
 * - changeEvent: opt in to emit a field-change event as the user types
 *   (debounced 200ms by default; see FieldChangeConfig).
 */
interface InputSection extends FieldSection {
  readonly type: "input";
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly initialValue?: string;
  readonly selectInitialValue?: boolean;
  /**
   * Controlled value push with the dropdown/checkbox adopt-once semantics: the
   * renderer adopts a pushed value it has not seen yet; re-sending the same
   * value preserves the user's edits. Lets the backend force the field (e.g.
   * reset-to-default) while normal typing stays user-driven. Absent = seed from
   * initialValue, then fully user-driven.
   */
  readonly value?: string;
  readonly changeEvent?: FieldChangeConfig;
  /**
   * Render a single-line field as a masked/password input with an eye-toggle to
   * reveal. Used for sensitive settings (e.g. API tokens). Ignored when
   * `multiline` is set.
   */
  readonly masked?: boolean;
}

/**
 * Checkbox section - a single checkbox with an inline label. Extends
 * FieldSection (id/error/disabled), but renders `label` BESIDE the box (the
 * native checkbox convention), not above the control.
 *
 * - value: controlled value push with the dropdown's adopt-once semantics —
 *   the renderer adopts a pushed value it has not seen yet; re-sending the
 *   same value preserves the user's toggles. A backend that needs to force
 *   the box (e.g. one checkbox disabling another) must track the field via
 *   changeEvent and echo its model value on every update. Absent = starts
 *   unchecked, edits preserved.
 * - Reported in DialogUserEvent.data as the string "true" or "false" (field
 *   values are strings). A disabled checkbox still reports its current value.
 * - changeEvent: opt in to emit a field-change event on toggle (a discrete
 *   action — immediate by default, like radio).
 */
interface CheckboxSection extends FieldSection {
  readonly type: "checkbox";
  readonly value?: boolean;
  readonly changeEvent?: FieldChangeConfig;
}

/**
 * Group section - a horizontal row composing field sections and buttons.
 *
 * - items render in declaration order (which is also the tab order): field
 *   sections (input/dropdown) stretch, buttons size to their content. Child
 *   fields render as ordinary sections — their own label/error, when set,
 *   appear inline in their cell (mind the row geometry).
 * - A group whose items are all buttons is the footer/action-row form (e.g.
 *   submit/cancel); a group mixing a field with buttons attaches side-flow
 *   buttons to that field's row.
 * - label: row label rendered above the row, associated with the first field
 *   item for accessibility.
 * - align: horizontal alignment of the row content when it does not fill the
 *   row. Defaults to the layout's natural alignment: "center" in the
 *   "centered" layout, "left" in the "form" layout.
 * - reverse: render the items visually reversed while keeping declaration
 *   order for tabbing — the dialog-footer convention where the primary button
 *   is tabbed first but sits on the right (declare [primary, cancel]).
 */
interface GroupSection {
  readonly type: "group";
  readonly label?: string;
  readonly align?: "left" | "center" | "right";
  readonly reverse?: boolean;
  readonly items: readonly GroupItem[];
}

type GroupItem = InputSection | DropdownSection | ButtonItem;

/** A value-bearing control that can sit inside a settings row. */
export type SettingRowField = CheckboxSection | InputSection | DropdownSection;

/**
 * Setting row - one auto-populated settings entry: a labeled row wrapping one
 * or more real field controls (so the form's value collection and live-change
 * validation apply unchanged) plus settings-specific chrome.
 *
 * - fields: the value-bearing control(s). One for a simple setting; several for
 *   a multi-value setting (a checkbox per enum-list option) or a guarded field
 *   (an on/off checkbox + a text input).
 * - description: muted help text under the label (from the config key's description).
 * - badge: a small tag by the label naming a non-default source ("env" / "cli").
 * - note: an inline note under the row (e.g. "Restart to apply").
 * - indent: indentation depth (0 = flush) mirroring the key's group nesting.
 * - resetId: when set, a reset-to-default icon button appears at the right of
 *   the row and emits a DialogActionEvent with this id. Omit to hide it (value
 *   already at default / not user-set).
 * - action: an optional inline action button at the right of the row (before the
 *   reset icon), e.g. a "Browse…" file picker for a path setting. Clicking it
 *   emits a DialogActionEvent with `action.id`. `icon` is a codicon name shown
 *   before the label.
 * - helpPanel: optional preformatted reference text (e.g. the fields a template
 *   may reference), revealed by a disclosure toggle beneath the control.
 *   Presentational only; shown in a monospace, whitespace-preserving panel.
 * - helpLabel: label for that disclosure toggle (defaults to a generic label).
 */
interface SettingRowSection {
  readonly type: "setting-row";
  readonly label: string;
  readonly fields: readonly SettingRowField[];
  readonly description?: string;
  readonly badge?: string;
  readonly note?: string;
  readonly indent?: number;
  readonly resetId?: string;
  readonly action?: {
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
  };
  readonly helpPanel?: string;
  readonly helpLabel?: string;
}

export type DialogSection =
  | TextSection
  | ProgressSection
  | RadioSection
  | DropdownSection
  | TableSection
  | InputSection
  | CheckboxSection
  | GroupSection
  | SettingRowSection;

// ---- Progress Items ----

export interface ProgressItem {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "error";
  /** 0-100; undefined = indeterminate (spinner when running) */
  readonly progress?: number;
  /** Right-aligned status text (e.g., "Complete", "45%", "access denied") */
  readonly message?: string;
}

// ---- Radio Options ----

export interface RadioOption {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
}

// ---- Dropdown Options ----

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A group of dropdown suggestions. The optional header is rendered as a
 * non-selectable divider above the group's items (e.g. "Local Branches").
 */
export interface DropdownSuggestionGroup {
  readonly header?: string;
  readonly items: readonly DropdownOption[];
}

// ---- Table ----

export interface TableColumn {
  readonly key: string;
  readonly label: string;
}

export type TableRow = Readonly<Record<string, string>>;

// ---- Buttons ----

/**
 * Declarative button. Placed inside group sections (see GroupSection) — both
 * for footer-style submit rows and for field-attached side-flow buttons.
 * Clicking a button emits a DialogActionEvent with the button's id and the
 * full field-values snapshot.
 *
 * - label: visible button text. When absent, the button renders icon-only
 *   (vscode-button appearance "icon"); icon-only buttons must set `title`,
 *   which doubles as the accessible name.
 * - icon: codicon name rendered before the label (or alone when icon-only).
 * - variant: "secondary" renders the muted style; an explicit "primary" also
 *   marks the button that Enter activates from a radio group (without one,
 *   Enter does nothing).
 * - role "cancel": marks this as the dialog's cancel action. On a modal
 *   surface, Escape clicks the first enabled (non-disabled, non-busy)
 *   cancel-role button — the emitted event is indistinguishable from a real
 *   click (same actionId + field-values snapshot). A modal with no enabled
 *   cancel-role button swallows Escape (no-op); a panel surface instead falls
 *   back to a DialogDismissEvent. Independent of variant (a cancel button is
 *   usually "secondary", but the primary could be the cancel in some dialogs).
 * - busy: disables the button; a labeled button shows busyLabel (or label),
 *   an icon-only button spins its icon.
 * - autofocus: focus this button when the form mounts (same semantics as
 *   FieldSection.autofocus). Usually unnecessary — the form auto-focuses its
 *   first enabled field, else the primary button, on mount.
 */
export interface DialogButton {
  readonly id: string;
  readonly label?: string;
  readonly icon?: string;
  readonly variant?: "primary" | "secondary";
  readonly role?: "cancel";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly title?: string;
  readonly autofocus?: boolean;
}

/** A button placed in a group section's items. */
interface ButtonItem extends DialogButton {
  readonly type: "button";
}

// ---- Dialog Config ----

/**
 * Full dialog configuration.
 * All dialogs render: faded static logo backdrop + centered card with sections.
 * Buttons (including the footer submit/cancel row) are declared as group
 * sections; see GroupSection.
 * Positioning is automatic: if sidebar is visible -> workspace area; if not -> full viewport.
 */
export interface DialogConfig {
  readonly sections: readonly DialogSection[];
  /**
   * Section layout (renderer hint; the modal shell is unaffected).
   * - "centered" (default): centered stack, no field labels — today's behavior.
   * - "form": left-aligned labeled rows (each field's label above its control,
   *   actions right-aligned).
   */
  readonly layout?: "centered" | "form";
}

// ---- IPC Protocol ----

/**
 * How a form session is presented. One property, three mutually exclusive kinds
 * (replaces the old surface + config.modal pair):
 * - "modal" (default): a blocking popup on top of everything — centered card on
 *   a dimmed/blurred backdrop that captures clicks and blocks Alt+X (DialogView,
 *   via DialogHost). Use for anything that must be answered before proceeding.
 * - "modeless": a non-blocking popup on top, above the sidebar — no backdrop,
 *   clicks pass through so the sidebar stays live (PanelView). The creation
 *   ground state: you leave it by clicking a workspace in the sidebar.
 * - "panel": in place of the workspace view, below the sidebar — no backdrop,
 *   the sidebar renders on top (PanelView). The deletion progress/failed view.
 *
 * Set once on the open command and immutable for the session's lifetime —
 * update commands carry only the config and cannot move a session between kinds.
 */
export type DialogKind = "modal" | "modeless" | "panel";

/**
 * Commands sent from main -> renderer to manage dialog lifecycle.
 */
export type DialogCommand =
  | {
      readonly action: "open";
      readonly dialogId: string;
      readonly config: DialogConfig;
      /** Presentation kind; absent = "modal". See DialogKind. */
      readonly kind?: DialogKind;
    }
  | { readonly action: "update"; readonly dialogId: string; readonly config: DialogConfig }
  | { readonly action: "close"; readonly dialogId: string };

/**
 * `data` is a flat snapshot of the dialog's field values, keyed by each field's
 * stable id (input.id, radio.id, dropdown.id, ...), including fields nested in
 * group sections. Field ids must be unique within a DialogConfig. Every field
 * is present; an empty/unset field reports "" (a key being absent means the
 * field is not part of this dialog). Values are strings; a checkbox reports
 * "true"/"false". Widening the value type is a shared-type change.
 */
type FieldValues = Readonly<Record<string, string>>;

/**
 * Action event: the user activated a button (a footer submit or a
 * field-attached side-flow button). `actionId` is the button's id; `data` is
 * the field-values snapshot at click time.
 */
export interface DialogActionEvent {
  /** Discriminant. Absent is treated as "action" for backward compatibility. */
  readonly kind?: "action";
  readonly dialogId: string;
  readonly actionId: string;
  readonly data?: FieldValues;
}

/**
 * Field-change event: a field's value changed BEFORE submit. Emitted only for
 * fields that opt in via `changeEvent`. `fieldId` is the field that changed;
 * `data` is the full field-values snapshot (same shape as action `data`).
 */
export interface DialogFieldChangeEvent {
  readonly kind: "change";
  readonly dialogId: string;
  readonly fieldId: string;
  readonly data: FieldValues;
}

/**
 * Dismiss event: the user asked to dismiss the form session (Escape in the
 * panel surface). The shell only reports the intent; the backend session owner
 * decides what dismissing means (typically close + reopen with fresh config =
 * clear, or ignore).
 */
export interface DialogDismissEvent {
  readonly kind: "dismiss";
  readonly dialogId: string;
}

/**
 * Events sent from renderer -> main when the user interacts with a dialog, as
 * dialog-* kinds on the api:ui:event channel. Discriminated by `kind`: "action"
 * (default when absent), "change", or "dismiss".
 */
export type DialogUserEvent = DialogActionEvent | DialogFieldChangeEvent | DialogDismissEvent;
