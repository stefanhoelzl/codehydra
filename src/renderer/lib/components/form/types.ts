/**
 * Narrowed views of the shared DialogSection union for the form components.
 * The individual section interfaces are intentionally not exported from
 * dialog-types, so each leaf component picks its slice via Extract here.
 */
import type { DialogSection } from "@shared/dialog-types";

export type TextSectionConfig = Extract<DialogSection, { type: "text" }>;
export type ProgressSectionConfig = Extract<DialogSection, { type: "progress" }>;
export type RadioSectionConfig = Extract<DialogSection, { type: "radio" }>;
export type DropdownSectionConfig = Extract<DialogSection, { type: "dropdown" }>;
export type TableSectionConfig = Extract<DialogSection, { type: "table" }>;
export type InputSectionConfig = Extract<DialogSection, { type: "input" }>;
export type CheckboxSectionConfig = Extract<DialogSection, { type: "checkbox" }>;
export type GroupSectionConfig = Extract<DialogSection, { type: "group" }>;
export type SettingRowSectionConfig = Extract<DialogSection, { type: "setting-row" }>;

export type GroupItem = GroupSectionConfig["items"][number];
export type ButtonItem = Extract<GroupItem, { type: "button" }>;

/** Sections that hold a user-editable value (top-level or nested in groups). */
export type FieldSectionConfig = Extract<
  DialogSection | GroupItem,
  { type: "input" | "radio" | "dropdown" | "checkbox" }
>;

/** Section layout mode; see DialogConfig.layout. */
export type FormLayout = "centered" | "form";

/**
 * Raw-interaction callbacks threaded from Form through the Section dispatcher
 * (and containers like GroupSection) down to the field/button leaves. Form
 * owns all timing and payloads; sections only report what happened, passing
 * their own config object as identity.
 */
export interface SectionHandlers {
  /** An input section's text changed (every keystroke). */
  readonly onInput: (section: InputSectionConfig, value: string) => void;
  /** A radio section's option was selected. */
  readonly onSelect: (section: RadioSectionConfig, optionId: string) => void;
  /** A dropdown suggestion was picked (or free text committed). */
  readonly onPick: (section: DropdownSectionConfig, value: string) => void;
  /** A dropdown's text was typed (every keystroke). */
  readonly onType: (section: DropdownSectionConfig, text: string) => void;
  /** A checkbox section was toggled. */
  readonly onToggle: (section: CheckboxSectionConfig, checked: boolean) => void;
  /** A button was clicked. */
  readonly onAction: (button: ButtonItem) => void;
  /** A field requested the primary action (Enter). */
  readonly onSubmit: () => void;
}
