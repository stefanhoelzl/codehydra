<script lang="ts">
  import type { BaseInfo } from "@shared/api/types";
  import FilterableDropdown, { type DropdownOption } from "./FilterableDropdown.svelte";
  import Icon from "./Icon.svelte";

  interface BranchDropdownProps {
    /** Branch list to display. Owned by the parent (one fetch shared across dropdowns). */
    branches: readonly BaseInfo[];
    /** Whether the parent is still waiting for fresh branch data. */
    loading: boolean;
    /** Fetch error to display, if any. */
    error: string | null;
    value: string;
    onSelect: (branch: string) => void;
    disabled?: boolean;
    /** Id for the dropdown input (for label association). */
    id: string;
  }

  let {
    branches,
    loading,
    error,
    value,
    onSelect,
    disabled = false,
    id,
  }: BranchDropdownProps = $props();

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
      {id}
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
