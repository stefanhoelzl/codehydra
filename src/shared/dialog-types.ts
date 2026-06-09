/**
 * Dialog framework types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 *
 * Dialogs are composed from ordered sections (building blocks) plus action buttons.
 * The backend sends the full config; a generic renderer displays it.
 */

// ---- Sections ----

/**
 * Text section - displays a text element with optional styling and icon.
 *
 * - style "heading": large + bold (h1-like)
 * - style "subtitle": small + dim
 * - style "mono": monospace font
 * - default: normal paragraph
 * - icon: codicon name rendered before text (e.g., "error" for danger styling)
 * - Supports {badge:text} syntax for inline badges
 */
interface TextSection {
  readonly type: "text";
  readonly content: string;
  readonly style?: "heading" | "subtitle" | "mono";
  readonly icon?: string;
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
 */
interface FieldSection {
  readonly id: string;
  readonly label?: string;
  readonly error?: string;
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
 */
interface DropdownSection extends FieldSection {
  readonly type: "dropdown";
  readonly suggestions: readonly DropdownSuggestionGroup[];
  readonly freeText?: boolean;
  readonly placeholder?: string;
  readonly initialValue?: string;
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
 * - initialValue seeds the field on first render only; later edits are preserved
 * - cursorOffset places the caret at this character offset after seeding
 *   (only applied when initialValue is set)
 * - selectInitialValue selects the seeded text instead of placing a caret, so
 *   the first keystroke replaces it (overrides cursorOffset)
 * - Input values are included in DialogUserEvent.data keyed by field id when actions fire
 * - changeEvent: opt in to emit a field-change event as the user types
 *   (debounced 200ms by default; see FieldChangeConfig).
 */
interface InputSection extends FieldSection {
  readonly type: "input";
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly initialValue?: string;
  readonly cursorOffset?: number;
  readonly selectInitialValue?: boolean;
  readonly changeEvent?: FieldChangeConfig;
}

export type DialogSection =
  | TextSection
  | ProgressSection
  | RadioSection
  | DropdownSection
  | TableSection
  | InputSection;

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

// ---- Actions (footer buttons) ----

export interface DialogAction {
  readonly id: string;
  readonly label: string;
  readonly variant?: "primary" | "secondary";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly title?: string;
}

// ---- Dialog Config ----

/**
 * Full dialog configuration.
 * All dialogs render: faded static logo backdrop + centered card with sections + actions.
 * Positioning is automatic: if sidebar is visible -> workspace area; if not -> full viewport.
 */
export interface DialogConfig {
  readonly sections: readonly DialogSection[];
  readonly actions?: readonly DialogAction[];
  /** When true, the dialog is on top of everything and blocks keyboard shortcuts (Alt+X). Default: false. */
  readonly modal?: boolean;
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
 * Commands sent from main -> renderer to manage dialog lifecycle.
 */
export type DialogCommand =
  | { readonly action: "open"; readonly dialogId: string; readonly config: DialogConfig }
  | { readonly action: "update"; readonly dialogId: string; readonly config: DialogConfig }
  | { readonly action: "close"; readonly dialogId: string };

/**
 * `data` is a flat snapshot of the dialog's field values, keyed by each field's
 * stable id (input.id, radio.id, dropdown.id, ...). Field ids must be unique within a
 * DialogConfig. Every field is present; an empty/unset field reports "" (a
 * key being absent means the field is not part of this dialog). Values are
 * strings; widening the value type is a shared-type change.
 */
type FieldValues = Readonly<Record<string, string>>;

/**
 * Action event: the user activated an action button (submit). Carries the
 * field-values snapshot at submit time.
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
 * Events sent from renderer -> main when the user interacts with a dialog, over
 * the api:dialog:event channel. Discriminated by `kind`: "action" (default when
 * absent) or "change".
 */
export type DialogUserEvent = DialogActionEvent | DialogFieldChangeEvent;
