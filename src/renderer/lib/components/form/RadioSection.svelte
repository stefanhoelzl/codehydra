<!--
  RadioSection.svelte

  Radio section leaf: a row of radio-group cards (icon + label + indicator)
  with the field's own optional label above and error helper below. The
  selection is controlled by the owner (Form): clicks, Space, and arrow-key
  navigation report the new option via onSelect; Enter reports onSubmit.

  The card row centers itself in the default "centered" layout and
  left-aligns in the "form" layout (layout prop).
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { FormLayout, RadioSectionConfig } from "./types";

  interface Props {
    section: RadioSectionConfig;
    value: string;
    layout: FormLayout;
    onSelect: (optionId: string) => void;
    onSubmit: () => void;
  }

  const { section, value, layout, onSelect, onSubmit }: Props = $props();
</script>

<div class="form-field">
  {#if section.label}
    <vscode-label>{section.label}</vscode-label>
  {/if}
  <div
    class="radio-cards"
    class:layout-form={layout === "form"}
    class:errored={!!section.error}
    role="radiogroup"
    aria-label={section.label ?? "Selection"}
    aria-describedby={section.error ? `${section.id}-error` : undefined}
  >
    {#each section.options as option, optionIndex (option.id)}
      <button
        type="button"
        class="radio-card"
        class:selected={value === option.id}
        role="radio"
        aria-checked={value === option.id}
        tabindex={value === option.id ? 0 : -1}
        disabled={section.disabled || undefined}
        data-option={option.id}
        onclick={() => {
          onSelect(option.id);
        }}
        onkeydown={(e) => {
          const opts = section.options;
          let targetIndex = -1;
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            targetIndex = optionIndex === 0 ? opts.length - 1 : optionIndex - 1;
          } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            targetIndex = optionIndex === opts.length - 1 ? 0 : optionIndex + 1;
          } else if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
            return;
          } else if (e.key === " ") {
            e.preventDefault();
            onSelect(option.id);
            return;
          }
          if (targetIndex >= 0) {
            const targetId = opts[targetIndex]!.id;
            onSelect(targetId);
            const container = e.currentTarget.closest(".radio-cards");
            setTimeout(() => {
              const card = container?.querySelector(
                `[data-option="${targetId}"]`
              ) as HTMLElement | null;
              card?.focus();
            }, 0);
          }
        }}
      >
        {#if option.icon}
          <div class="radio-card-icon">
            <Icon name={option.icon} size={32} />
          </div>
        {/if}
        <span class="radio-card-title">{option.label}</span>
        <div class="radio-card-indicator">
          {#if value === option.id}
            <Icon name="circle-filled" size={16} />
          {:else}
            <Icon name="circle-outline" size={16} />
          {/if}
        </div>
      </button>
    {/each}
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

  .radio-cards {
    display: flex;
    /* The form-field wrapper is full-width; center the shrink-wrapped card
       row in the default (centered) layout. */
    justify-content: center;
    gap: 1rem;
    margin: 0.5rem 0;
  }

  .radio-cards.layout-form {
    justify-content: flex-start;
  }

  .radio-cards.errored {
    outline: 1px solid var(--ch-danger, #f14c4c);
    outline-offset: 6px;
    border-radius: var(--ch-radius-md, 10px);
  }

  .radio-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 140px;
    padding: 1.5rem 1rem;
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-md, 10px);
    background: var(--ch-panel-background);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
    color: inherit;
    font-family: inherit;
  }

  .radio-card:hover {
    border-color: var(--ch-focus-border);
    background: var(--ch-accent-muted, var(--ch-list-hover-bg));
  }

  .radio-card:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  .radio-card:focus {
    outline: none;
    border-color: var(--ch-focus-border);
    box-shadow: 0 0 0 1px var(--ch-focus-border);
  }

  .radio-card.selected {
    border-color: var(--ch-focus-border);
    background: var(--ch-accent-muted, var(--ch-list-active-bg));
  }

  .radio-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
  }

  .radio-card-title {
    font-size: 1rem;
    font-weight: 500;
  }

  .radio-card-indicator {
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .radio-card.selected .radio-card-indicator {
    opacity: 1;
    color: var(--ch-focus-border);
  }
</style>
