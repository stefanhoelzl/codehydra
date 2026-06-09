<script lang="ts">
  import FilterableDropdown, { type DropdownOption } from "./FilterableDropdown.svelte";
  import { projects } from "$lib/stores/projects.svelte.js";
  import type { ProjectId } from "$lib/api";

  interface ProjectDropdownProps {
    value: ProjectId;
    onSelect: (projectId: ProjectId) => void;
    disabled?: boolean;
    /** Whether to focus the input on mount */
    autofocus?: boolean;
  }

  let { value, onSelect, disabled = false, autofocus = false }: ProjectDropdownProps = $props();

  /**
   * Transform projects to DropdownOption[].
   * All projects are selectable options (no headers).
   * Uses project.id as value for v2 API compatibility.
   */
  const dropdownOptions = $derived.by((): DropdownOption[] => {
    return projects.value.map((project) => ({
      type: "option" as const,
      label: project.name,
      value: project.id, // Use project ID, not path
    }));
  });

  /**
   * Get the display value (project name) from the project ID.
   */
  const displayValue = $derived.by(() => {
    const project = projects.value.find((p) => p.id === value);
    return project?.name ?? "";
  });

  /**
   * Handle selection - cast to ProjectId for type safety.
   */
  function handleSelect(selectedValue: string): void {
    onSelect(selectedValue as ProjectId);
  }
</script>

<div class="project-dropdown">
  <FilterableDropdown
    options={dropdownOptions}
    value={displayValue}
    onSelect={handleSelect}
    {disabled}
    placeholder="Select project..."
    id="project-dropdown"
    {autofocus}
  />
</div>

<style>
  .project-dropdown {
    width: 100%;
  }
</style>
