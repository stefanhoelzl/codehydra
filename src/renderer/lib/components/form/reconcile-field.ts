/**
 * Pure field reconciliation for Form.svelte: given a field section from a
 * config push, the value (and dropdown display text) the form currently holds
 * for it, and the last pushed value the form adopted for it, compute what the
 * field holds after the push.
 *
 * Per type:
 * - radio: keep the existing choice if still a valid option id, else the
 *   first option's id.
 * - input / checkbox / free-text dropdown: adopt a controlled push the form
 *   has not adopted yet (e.g. a reset-to-default); re-sends preserve the
 *   user's edits. Without a push: keep the existing value, else seed from
 *   initialValue (checkbox: unchecked) on first sight.
 * - strict dropdown: a fresh push is adopted when it names a suggestion, else
 *   the field falls back to the first suggestion. Only an applied push is
 *   recorded as adopted — a rejected one must stay adoptable, or the backend
 *   re-sending it (e.g. the creation form seeding the base branch before the
 *   branch list arrives, then re-sending it with the list) would be dismissed
 *   as a re-send. Without a push the existing value is kept while valid; on
 *   first sight initialValue is used when it names a suggestion. An empty
 *   suggestion list accepts any value, so a seeded default paints while the
 *   list is still loading; it is re-validated once the list arrives.
 * - dropdown display text follows the value (its suggestion label) unless the
 *   value is unchanged and nothing was pushed, preserving what the user sees
 *   (e.g. typed free text).
 */
import type { DropdownSectionConfig, FieldSectionConfig } from "./types";

/** What the form currently holds for a field (undefined = first sight). */
export interface FieldState {
  readonly value: string | undefined;
  /** Dropdown display text; unused for other field types. */
  readonly display: string | undefined;
}

export interface ReconciledField {
  readonly value: string;
  /** Dropdown display text; undefined for every other field type. */
  readonly display?: string;
  /** A pushed value the caller must record as adopted for this field. */
  readonly adopt?: string;
}

/**
 * The adopt-once rule shared by every controlled field: a pushed value counts
 * only when it differs from the one last adopted; a re-send is undefined.
 */
export function freshPush(
  raw: string | undefined,
  adopted: string | undefined
): string | undefined {
  return raw !== undefined && raw !== adopted ? raw : undefined;
}

/** A dropdown section's suggestions flattened across groups. */
function flatSuggestions(
  section: DropdownSectionConfig
): readonly { value: string; label: string }[] {
  return section.suggestions.flatMap((group) => group.items);
}

/** The label of the suggestion with this value, or the value itself. */
export function suggestionLabel(section: DropdownSectionConfig, value: string): string {
  return flatSuggestions(section).find((o) => o.value === value)?.label ?? value;
}

/** A strict dropdown's value: see the module comment. */
function strictDropdownValue(
  section: DropdownSectionConfig,
  pushed: string | undefined,
  existing: string | undefined
): string {
  const options = flatSuggestions(section);
  const isValid = (v: string | undefined): v is string =>
    v !== undefined && (options.length === 0 || options.some((o) => o.value === v));
  const fallback = options[0]?.value ?? "";
  if (pushed !== undefined) return isValid(pushed) ? pushed : fallback;
  if (existing !== undefined) return isValid(existing) ? existing : fallback;
  return isValid(section.initialValue) ? section.initialValue : fallback;
}

function reconcileDropdown(
  section: DropdownSectionConfig,
  existing: FieldState,
  adopted: string | undefined
): ReconciledField {
  const pushed = freshPush(section.value, adopted);
  let value: string;
  let adopt: string | undefined;
  if (section.freeText) {
    value = pushed ?? existing.value ?? section.initialValue ?? "";
    adopt = pushed;
  } else {
    value = strictDropdownValue(section, pushed, existing.value);
    adopt = pushed !== undefined && value === pushed ? pushed : undefined;
  }
  const display =
    value === existing.value && existing.display !== undefined && pushed === undefined
      ? existing.display
      : suggestionLabel(section, value);
  return adopt === undefined ? { value, display } : { value, display, adopt };
}

/** Reconcile one field against a config push. */
export function reconcileField(
  section: FieldSectionConfig,
  existing: FieldState,
  adopted: string | undefined
): ReconciledField {
  switch (section.type) {
    case "radio": {
      const current = existing.value;
      if (current !== undefined && section.options.some((o) => o.id === current)) {
        return { value: current };
      }
      return { value: section.options[0]?.id ?? "" };
    }
    case "dropdown":
      return reconcileDropdown(section, existing, adopted);
    case "input": {
      const pushed = freshPush(section.value, adopted);
      const value = pushed ?? existing.value ?? section.initialValue ?? "";
      return pushed === undefined ? { value } : { value, adopt: pushed };
    }
    case "checkbox": {
      const raw = section.value === undefined ? undefined : String(section.value);
      const pushed = freshPush(raw, adopted);
      const value = pushed ?? existing.value ?? "false";
      return pushed === undefined ? { value } : { value, adopt: pushed };
    }
  }
}
