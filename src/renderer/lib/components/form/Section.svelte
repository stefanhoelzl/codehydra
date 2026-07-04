<!--
  Section.svelte

  The single section dispatcher: maps one section config onto its leaf
  component. Used by Form for top-level sections and (via Form's recursive
  renderItem snippet) for group items, so the section -> component routing
  lives in exactly one place — a container that grows new section types never
  duplicates these branches.

  Field leaves are controlled: they read their current value from the
  `values`/`displays` records and report raw interactions through the
  SectionHandlers bundle (with their own config object as identity). The
  schema decides which section types a given container may hold; this
  dispatcher renders whatever it is handed.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import CheckboxSection from "./CheckboxSection.svelte";
  import DropdownSection from "./DropdownSection.svelte";
  import FormButton from "./FormButton.svelte";
  import GroupSection from "./GroupSection.svelte";
  import InputSection from "./InputSection.svelte";
  import ProgressSection from "./ProgressSection.svelte";
  import RadioSection from "./RadioSection.svelte";
  import TableSection from "./TableSection.svelte";
  import TextSection from "./TextSection.svelte";
  import type { ButtonItem, FormLayout, GroupItem, SectionHandlers } from "./types";
  import type { DialogSection } from "@shared/dialog-types";

  interface Props extends SectionHandlers {
    section: DialogSection | ButtonItem;
    layout: FormLayout;
    /** Current field values keyed by field id. */
    values: Record<string, string>;
    /** Dropdown display text keyed by field id (what the combobox shows). */
    displays: Record<string, string>;
    /** Renders a group item as an ordinary section (Form's recursive snippet). */
    renderItem: Snippet<[GroupItem]>;
  }

  const {
    section,
    layout,
    values,
    displays,
    renderItem,
    onInput,
    onSelect,
    onPick,
    onType,
    onToggle,
    onAction,
    onSubmit,
  }: Props = $props();
</script>

{#if section.type === "text"}
  <TextSection {section} />
{:else if section.type === "progress"}
  <ProgressSection {section} />
{:else if section.type === "radio"}
  <RadioSection
    {section}
    value={values[section.id] ?? ""}
    {layout}
    onSelect={(optionId) => onSelect(section, optionId)}
    {onSubmit}
  />
{:else if section.type === "dropdown"}
  <DropdownSection
    {section}
    value={displays[section.id] ?? ""}
    onPick={(value) => onPick(section, value)}
    onType={(text) => onType(section, text)}
    {onSubmit}
  />
{:else if section.type === "input"}
  <InputSection
    {section}
    value={values[section.id] ?? ""}
    onInput={(value) => onInput(section, value)}
    {onSubmit}
  />
{:else if section.type === "checkbox"}
  <CheckboxSection
    {section}
    value={values[section.id] ?? ""}
    onToggle={(checked) => onToggle(section, checked)}
  />
{:else if section.type === "group"}
  <GroupSection {section} {layout} {renderItem} />
{:else if section.type === "table"}
  <TableSection {section} />
{:else if section.type === "button"}
  <FormButton button={section} onClick={() => onAction(section)} />
{/if}
