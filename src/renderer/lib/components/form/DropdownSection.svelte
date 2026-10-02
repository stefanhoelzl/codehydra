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
  import FieldShell, { fieldErrorId } from "./FieldShell.svelte";
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

<FieldShell
  fieldId={section.id}
  label={section.label}
  labelFor="{section.id}-input"
  error={section.error}
>
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
      selectOnFirstFocus={section.selectInitialValue ?? false}
      invalid={!!section.error}
      describedBy={section.error ? fieldErrorId(section.id) : undefined}
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
</FieldShell>

<style>
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
