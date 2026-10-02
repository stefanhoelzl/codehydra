<!--
  CheckboxSection.svelte

  Checkbox section leaf: a single checkbox with its label beside the box
  (native checkbox convention — FieldSection.label is NOT rendered above).
  The value is controlled by the owner (Form) as the string "true"/"false";
  toggles report the new checked state via onToggle.
-->
<script lang="ts">
  import FieldShell, { fieldErrorId } from "./FieldShell.svelte";
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

<FieldShell fieldId={section.id} error={section.error} alignLeft>
  <vscode-checkbox
    id={section.id}
    label={section.label ?? ""}
    checked={value === "true"}
    disabled={section.disabled || undefined}
    data-autofocus={section.autofocus || undefined}
    aria-describedby={section.error ? fieldErrorId(section.id) : undefined}
    onchange={handleChange}
  ></vscode-checkbox>
</FieldShell>
