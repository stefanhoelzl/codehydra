<!--
  DropdownSection.svelte

  Dropdown section leaf: a combobox (FilterableDropdown) with the field's own
  optional label above and error helper below. The displayed text is
  controlled by the owner (Form), which may differ from the reported field
  value after a suggestion pick (the input shows the suggestion's label while
  the field reports its value).

  A `loading` flag overlays a spinner at the control's right edge while the
  backend fetches suggestions; the control stays interactive.

  Callbacks report raw interactions: onPick for a committed suggestion pick
  (or free-text commit via Enter/Tab), onType for every typed change, and
  onSubmit when Enter falls through with no pick to commit.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import FilterableDropdown, {
    type DropdownOption as FilterableOption,
  } from "../FilterableDropdown.svelte";
  import type { DropdownSectionConfig } from "./types";

  interface Props {
    section: DropdownSectionConfig;
    value: string;
    onPick: (value: string) => void;
    onType: (text: string) => void;
    onSubmit: () => void;
  }

  const { section, value, onPick, onType, onSubmit }: Props = $props();

  /**
   * Map the section's suggestion groups onto FilterableDropdown's flat option
   * list (a group's header becomes a non-selectable header entry).
   */
  function toFilterableOptions(s: DropdownSectionConfig): FilterableOption[] {
    const result: FilterableOption[] = [];
    s.suggestions.forEach((group, groupIndex) => {
      if (group.header !== undefined && group.items.length > 0) {
        result.push({ type: "header", label: group.header, value: `__header_${groupIndex}__` });
      }
      for (const item of group.items) {
        result.push({ type: "option", label: item.label, value: item.value });
      }
    });
    return result;
  }
</script>

<div class="form-field">
  {#if section.label}
    <vscode-label for="{section.id}-input">{section.label}</vscode-label>
  {/if}
  <div class="dropdown-wrapper">
    <FilterableDropdown
      id={section.id}
      options={toFilterableOptions(section)}
      {value}
      placeholder={section.placeholder ?? ""}
      allowFreeText={section.freeText ?? false}
      searchable={section.searchable ?? true}
      disabled={section.disabled ?? false}
      autofocus={section.autofocus ?? false}
      invalid={!!section.error}
      describedBy={section.error ? `${section.id}-error` : undefined}
      onSelect={onPick}
      onInput={onType}
      onEnter={onSubmit}
    />
    {#if section.loading}
      <div class="dropdown-loading" role="status" aria-label="Loading options">
        <Icon name="loading" spin />
      </div>
    {/if}
  </div>
  {#if section.error}
    <vscode-form-helper id="{section.id}-error">
      <span class="field-error">{section.error}</span>
    </vscode-form-helper>
  {/if}
</div>

<style>
  /* Field wrapper: groups the field's label, control, and error tightly so
     the error sits directly under its control (the form's section gap only
     applies between sections). */
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }

  /* Per-field validation error (slotted into <vscode-form-helper>). */
  .field-error {
    color: var(--ch-danger, #f14c4c);
    font-size: 0.75rem;
  }

  .dropdown-wrapper {
    position: relative;
    width: 100%;
  }

  /* Loading spinner overlaid at the combobox input's right edge. The control
     stays interactive (pointer-events: none). */
  .dropdown-loading {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    pointer-events: none;
    color: var(--ch-foreground);
    opacity: 0.7;
  }
</style>
