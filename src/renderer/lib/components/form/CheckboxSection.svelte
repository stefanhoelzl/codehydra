<!--
  CheckboxSection.svelte

  Checkbox section leaf: a single checkbox with its label beside the box
  (native checkbox convention — FieldSection.label is NOT rendered above).
  The value is controlled by the owner (Form) as the string "true"/"false";
  toggles report the new checked state via onToggle.
-->
<script lang="ts">
  import type { CheckboxSectionConfig } from "./types";

  interface Props {
    section: CheckboxSectionConfig;
    /** Current value from Form's field record: "true" or "false". */
    value: string;
    onToggle: (checked: boolean) => void;
  }

  const { section, value, onToggle }: Props = $props();

  function handleChange(event: Event): void {
    const target = event.target as HTMLElement & { checked: boolean };
    onToggle(target.checked);
  }
</script>

<div class="form-field">
  <vscode-checkbox
    id={section.id}
    label={section.label ?? ""}
    checked={value === "true"}
    disabled={section.disabled || undefined}
    data-autofocus={section.autofocus || undefined}
    aria-describedby={section.error ? `${section.id}-error` : undefined}
    onchange={handleChange}
  ></vscode-checkbox>
  {#if section.error}
    <vscode-form-helper id="{section.id}-error">
      <span class="field-error">{section.error}</span>
    </vscode-form-helper>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    text-align: left;
  }

  .field-error {
    color: var(--ch-danger, #f14c4c);
    font-size: 0.75rem;
  }
</style>
