<!--
  FieldShell.svelte

  The chrome every field-like section shares: a tight column holding the
  optional label above, the control (children), and the validation error
  below it in a <vscode-form-helper>. The tight gap keeps an error directly
  under its control (the form's section gap only applies between sections).

  The error helper's element id is `fieldErrorId(fieldId)`; controls point
  their aria-describedby at it.
-->
<script lang="ts" module>
  /** The element id of a field's error helper (for aria-describedby). */
  export function fieldErrorId(fieldId: string): string {
    return `${fieldId}-error`;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** The field's id; names the error helper (see fieldErrorId). */
    fieldId?: string;
    /** Label rendered above the control. */
    label?: string | undefined;
    /** Element id the label is `for`; omit for a label with no single target. */
    labelFor?: string | undefined;
    /** Validation error rendered below the control. Needs `fieldId`. */
    error?: string | undefined;
    /**
     * Left-align the field's text even inside a centered form (a checkbox's
     * label sits beside its box and reads wrong centered).
     */
    alignLeft?: boolean;
    children: Snippet;
  }

  const { fieldId, label, labelFor, error, alignLeft = false, children }: Props = $props();
</script>

<div class="form-field" class:align-left={alignLeft}>
  {#if label}
    <vscode-label for={labelFor}>{label}</vscode-label>
  {/if}
  {@render children()}
  {#if error && fieldId !== undefined}
    <vscode-form-helper id={fieldErrorId(fieldId)}>
      <span class="field-error">{error}</span>
    </vscode-form-helper>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }

  .form-field.align-left {
    text-align: left;
  }

  /* Per-field validation error (slotted into <vscode-form-helper>). */
  .field-error {
    color: var(--ch-danger, #f14c4c);
    font-size: 0.75rem;
  }
</style>
