<!--
  SettingRow.svelte

  One auto-populated settings entry. The label and its control(s) sit side by
  side ([label] [control]); the description and any inline note (e.g. "Restart
  to apply") sit below, spanning the row. Controls are the real field sections
  rendered through Form's recursive Section snippet, so their values flow
  through the form unchanged.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "../Icon.svelte";
  import type { ButtonItem, SettingRowSectionConfig } from "./types";
  import type { DialogSection } from "@shared/dialog-types";

  interface Props {
    section: SettingRowSectionConfig;
    /** Form's recursive section snippet, used to render the wrapped controls. */
    renderItem: Snippet<[DialogSection | ButtonItem]>;
    /** Reset this setting to its default. Rendered only when section.resetId is set. */
    onReset: () => void;
    /** Trigger the row's inline action (e.g. a file picker). Rendered only when section.action is set. */
    onRowAction: () => void;
  }

  const { section, renderItem, onReset, onRowAction }: Props = $props();

  /** Help panel (fields/front-matter reference) starts collapsed. */
  let helpOpen = $state(false);
  const helpId = $derived(`${section.fields[0]?.id ?? section.label}-help`);
</script>

<div class="setting-row" style={section.indent ? `padding-left: ${section.indent}rem` : undefined}>
  <div class="setting-main">
    <div class="setting-label-cell">
      <span class="setting-label">{section.label}</span>
      {#if section.badge}
        <span class="setting-badge">{section.badge}</span>
      {/if}
    </div>
    {#if !section.helpPanel}
      <div class="setting-controls">
        {#each section.fields as field, index (field.id + index)}
          {@render renderItem(field)}
        {/each}
      </div>
    {/if}
    {#if section.action}
      <button type="button" class="setting-action" onclick={onRowAction}>
        {#if section.action.icon}
          <Icon name={section.action.icon} size={14} />
        {/if}
        {section.action.label}
      </button>
    {/if}
    <button
      type="button"
      class="setting-reset"
      class:hidden={!section.resetId}
      aria-label="Reset to default"
      title="Reset to default"
      disabled={!section.resetId}
      onclick={onReset}
    >
      <Icon name="discard" size={14} />
    </button>
  </div>
  {#if section.helpPanel}
    <!-- Full-width editor below the label, with the fields/front-matter
         reference collapsed behind a toggle beneath the textarea. -->
    <div class="setting-editor">
      <div class="setting-controls">
        {#each section.fields as field, index (field.id + index)}
          {@render renderItem(field)}
        {/each}
      </div>
      <button
        type="button"
        class="setting-help-toggle"
        aria-expanded={helpOpen}
        aria-controls={helpId}
        onclick={() => (helpOpen = !helpOpen)}
      >
        <Icon name={helpOpen ? "chevron-down" : "chevron-right"} size={14} />
        <Icon name="question" size={14} />
        <span>{section.helpLabel ?? "Reference"}</span>
      </button>
      {#if helpOpen}
        <pre id={helpId} class="setting-help">{section.helpPanel}</pre>
      {/if}
    </div>
  {/if}
  {#if section.description}
    <p class="setting-description">{section.description}</p>
  {/if}
  {#if section.note}
    <p class="setting-note">
      <Icon name="info" size={12} />
      {section.note}
    </p>
  {/if}
</div>

<style>
  .setting-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    /* Separate adjacent entries: bottom padding + a faint divider make the
       boundary between two settings easy to see. */
    padding-bottom: 0.85rem;
    border-bottom: 1px solid var(--ch-border);
  }

  /* [label] [control] on one row: the label takes a fixed share on the left,
     the control(s) fill the rest on the right. */
  .setting-main {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  /* Editor stacked above its help panel, spanning the full row width below the
     label. */
  .setting-editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .setting-editor .setting-controls {
    width: 100%;
    min-width: 0;
  }

  /* Disclosure toggle for the reference panel, sitting under the textarea. */
  .setting-help-toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 2px 6px;
    font-size: 0.8rem;
    color: var(--ch-foreground);
    opacity: 0.7;
    background: transparent;
    border: none;
    border-radius: var(--ch-radius-sm, 6px);
    cursor: pointer;
  }

  .setting-help-toggle:hover {
    opacity: 1;
    background: var(--ch-list-hover-bg, rgba(255, 255, 255, 0.08));
  }

  /* Reference text (available fields, output keys, example) below the editor. */
  .setting-help {
    width: 100%;
    min-width: 0;
    max-height: 40vh;
    margin: 0;
    padding: 0.5rem;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ch-foreground);
    opacity: 0.7;
    background: var(--ch-list-hover-bg, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-sm, 6px);
  }

  .setting-label-cell {
    flex: 0 0 40%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .setting-label {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  /* Help rows render the editor on its own full-width line below, so their
     label row has no control column — let the label span it (keeping the reset
     button pinned right). */
  .setting-main:not(:has(.setting-controls)) .setting-label-cell {
    flex: 1 1 auto;
  }

  /* Source badge (env / cli): a small muted tag. */
  .setting-badge {
    padding: 0 6px;
    font-size: 0.7rem;
    line-height: 1.4;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--ch-foreground);
    opacity: 0.6;
    background: var(--ch-list-hover-bg, rgba(255, 255, 255, 0.08));
    border-radius: var(--ch-radius-sm, 6px);
  }

  .setting-description {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.7;
  }

  .setting-controls {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }

  /* Reset-to-default, pinned to the row's right edge. Kept in the layout even
     when inactive (visibility: hidden) so control widths don't jump row to row. */
  .setting-reset {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 6px;
    color: var(--ch-foreground);
    background: transparent;
    border: none;
    border-radius: var(--ch-radius-sm, 6px);
    cursor: pointer;
    opacity: 0.7;
  }

  .setting-reset:hover {
    opacity: 1;
    background: var(--ch-list-hover-bg);
  }

  .setting-reset.hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* Inline row action (e.g. "Browse…" file picker), pinned right, before reset. */
  .setting-action {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 2px 10px;
    font-size: 0.8rem;
    color: var(--ch-foreground);
    background: var(--ch-list-hover-bg, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-sm, 6px);
    cursor: pointer;
  }

  .setting-action:hover {
    background: var(--ch-list-active-bg, rgba(255, 255, 255, 0.12));
  }

  .setting-note {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin: 0;
    font-size: 0.75rem;
    color: var(--ch-warning-fg, #cca700);
  }
</style>
