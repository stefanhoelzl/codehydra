<script lang="ts">
  import { projects, on, type ProjectId, type BaseInfo } from "$lib/api";
  import FilterableDropdown, { type DropdownOption } from "./FilterableDropdown.svelte";
  import Icon from "./Icon.svelte";

  interface BranchDropdownProps {
    projectId: ProjectId;
    value: string;
    onSelect: (branch: string) => void;
    disabled?: boolean;
  }

  let { projectId, value, onSelect, disabled = false }: BranchDropdownProps = $props();

  // State
  let branches = $state<readonly BaseInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let hasValidatedInitialValue = $state(false);

  // Load cached branches immediately, then wait for bases-updated event
  $effect(() => {
    const currentProjectId = projectId;
    loading = true;
    error = null;

    // Fetch cached branches immediately for display
    projects
      .fetchBases(currentProjectId)
      .then((result: { bases: readonly BaseInfo[] }) => {
        branches = result.bases;
        // Keep loading=true until bases-updated event arrives
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : "Failed to load branches";
        loading = false;
      });

    // Subscribe to bases-updated event for when fresh data arrives
    const unsubscribe = on<{ projectId: ProjectId; bases: readonly BaseInfo[] }>(
      "project:bases-updated",
      (event) => {
        if (event.projectId === currentProjectId) {
          branches = event.bases;
          loading = false;
        }
      }
    );

    return () => {
      unsubscribe();
    };
  });

  // Reset validation flag when value prop changes from parent
  // This allows re-validation if parent updates value dynamically
  $effect(() => {
    // Track value to create dependency
    void value;
    // Reset flag so validation runs again with new value
    hasValidatedInitialValue = false;
  });

  // Validate initial value exists in branches after loading
  $effect(() => {
    // Only validate once after branches load
    if (loading || hasValidatedInitialValue) return;
    hasValidatedInitialValue = true;

    // If value is set but doesn't exist in branches, clear it
    if (value && !branches.some((b) => b.name === value)) {
      onSelect(""); // Notify parent the value is invalid
    }
  });

  /**
   * Transform branches to DropdownOption[] with headers for local/remote groups.
   */
  const dropdownOptions = $derived.by((): DropdownOption[] => {
    const localBranches = branches.filter((b) => !b.isRemote);
    const remoteBranches = branches.filter((b) => b.isRemote);

    const options: DropdownOption[] = [];

    if (localBranches.length > 0) {
      options.push({ type: "header", label: "Local Branches", value: "__header_local__" });
      for (const branch of localBranches) {
        options.push({ type: "option", label: branch.name, value: branch.name });
      }
    }

    if (remoteBranches.length > 0) {
      options.push({ type: "header", label: "Remote Branches", value: "__header_remote__" });
      for (const branch of remoteBranches) {
        options.push({ type: "option", label: branch.name, value: branch.name });
      }
    }

    return options;
  });

  /**
   * Filter function for branches - matches by name.
   * Headers are always included (handled by FilterableDropdown).
   */
  function filterBranch(option: DropdownOption, filterLowercase: string): boolean {
    if (option.type === "header") {
      // Keep headers if there are matching branches in their group
      if (option.value === "__header_local__") {
        return branches.some((b) => !b.isRemote && b.name.toLowerCase().includes(filterLowercase));
      }
      if (option.value === "__header_remote__") {
        return branches.some((b) => b.isRemote && b.name.toLowerCase().includes(filterLowercase));
      }
      return false;
    }
    return option.label.toLowerCase().includes(filterLowercase);
  }

  /**
   * Get the display value for the input.
   * Shows the branch name if selected, otherwise empty.
   */
  const displayValue = $derived(value);
</script>

<div class="branch-dropdown">
  <div class="input-wrapper">
    <FilterableDropdown
      options={dropdownOptions}
      value={displayValue}
      {onSelect}
      {disabled}
      placeholder="Select branch..."
      filterOption={filterBranch}
      id={`branch-dropdown-${projectId}`}
    >
      {#snippet optionSnippet(option)}
        {#if option.type === "header"}
          <span class="header-text">{option.label}</span>
        {:else}
          <span class="branch-text">{option.label}</span>
        {/if}
      {/snippet}
    </FilterableDropdown>
    {#if loading}
      <div class="loading-spinner" role="status" aria-label="Loading branches">
        <Icon name="loading" spin />
      </div>
    {/if}
  </div>
  {#if error}
    <div class="error-message" role="alert">{error}</div>
  {/if}
</div>

<style>
  .branch-dropdown {
    width: 100%;
  }

  .input-wrapper {
    position: relative;
    width: 100%;
  }

  .loading-spinner {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--ch-foreground);
    opacity: 0.7;
  }

  .error-message {
    padding: 4px 0 0;
    font-size: 12px;
    color: var(--ch-error-fg);
  }

  .header-text {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .branch-text {
    font-size: 13px;
  }
</style>
