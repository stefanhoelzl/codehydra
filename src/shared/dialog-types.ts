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
 * Selection section - displays radio-group cards with icon + label.
 */
interface SelectionSection {
  readonly type: "selection";
  readonly options: readonly SelectionOption[];
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

export type DialogSection = TextSection | ProgressSection | SelectionSection | TableSection;

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

// ---- Selection Options ----

export interface SelectionOption {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
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
 * Events sent from renderer -> main when user interacts with a dialog.
 */
export interface DialogUserEvent {
  readonly dialogId: string;
  readonly actionId: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
