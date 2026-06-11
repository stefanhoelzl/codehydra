<!--
  GroupSection.svelte

  Group section: a pure layout container — a horizontal row of sections.
  Items render in declaration order (which is also the tab order) through the
  renderItem snippet (Form's recursive Section snippet — inverted so this
  module never imports the dispatcher, keeping the import graph acyclic):
  field children sit in stretching cells, buttons keep their natural size.
  A group's own optional label renders above the row, associated with the
  first field for a11y. Children render as ordinary sections (their own
  label/error, when set, appear inline in their cell).

  `reverse` renders the items visually reversed while keeping declaration
  order for tabbing — the dialog-footer convention where the primary button is
  tabbed first but sits on the right.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FormLayout, GroupItem, GroupSectionConfig } from "./types";

  interface Props {
    section: GroupSectionConfig;
    layout: FormLayout;
    /** Renders one item as an ordinary section (Form's recursive snippet). */
    renderItem: Snippet<[GroupItem]>;
  }

  const { section, layout, renderItem }: Props = $props();

  const firstField = $derived(section.items.find((i) => i.type !== "button"));

  /**
   * The element id the row label points at for a field: FilterableDropdown
   * renders its text input as `${id}-input`; other controls use the id as-is.
   */
  function labelTargetOf(field: GroupItem): string {
    return field.type === "dropdown" ? `${field.id}-input` : field.id;
  }

  /** Resolved horizontal alignment of the row (layout-natural default). */
  const align = $derived(section.align ?? (layout === "form" ? "left" : "center"));
</script>

<div class="form-field">
  {#if section.label}
    <vscode-label for={firstField ? labelTargetOf(firstField) : undefined}
      >{section.label}</vscode-label
    >
  {/if}
  <div class="group-row align-{align}" class:reverse={section.reverse}>
    {#each section.items as item, itemIndex (itemIndex)}
      {#if item.type === "button"}
        {@render renderItem(item)}
      {:else}
        <div class="group-field">{@render renderItem(item)}</div>
      {/if}
    {/each}
  </div>
</div>

<style>
  /* Field wrapper: groups the row's label and content tightly (the form's
     section gap only applies between sections). */
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }

  /* Horizontal row of field controls and buttons. Field controls stretch
     (via .group-field), buttons keep their natural size; `align` only shows
     when no stretching field fills the row (e.g. a button-only footer). */
  .group-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }

  .group-row.align-left {
    justify-content: flex-start;
  }

  .group-row.align-center {
    justify-content: center;
  }

  .group-row.align-right {
    justify-content: flex-end;
  }

  /* Visually reversed row (tab order keeps declaration order). The main axis
     flips, so the justify mapping flips with it. */
  .group-row.reverse {
    flex-direction: row-reverse;
  }

  .group-row.reverse.align-right {
    justify-content: flex-start;
  }

  .group-row.reverse.align-left {
    justify-content: flex-end;
  }

  /* Rows mixing a field with buttons stretch the buttons to the field's
     height (the old project-row look); button-only rows keep natural height. */
  .group-row:has(.group-field) {
    align-items: stretch;
  }

  .group-field {
    flex: 1;
    min-width: 0;
  }
</style>
