<script lang="ts">
  import { projects, type ProjectId, type BaseInfo } from "$lib/api";
  import FilterableDropdown, { type DropdownOption } from "./FilterableDropdown.svelte";

  /**
   * Selection result from the NameBranchDropdown.
   */
  export interface NameBranchSelection {
    /** The workspace/branch name */
    name: string;
    /** Suggested base branch if selecting an existing branch */
    suggestedBase?: string;
    /** true if selected from list, false if custom typed */
    isExistingBranch: boolean;
  }

  interface NameBranchDropdownProps {
    projectId: ProjectId;
    value: string;
    onSelect: (selection: NameBranchSelection) => void;
    disabled?: boolean;
    /** Optional id for the dropdown */
    id?: string;
    /** Called after Enter key is handled (after selection) */
    onEnter?: (() => void) | undefined;
    /** Called on every input change with the current text */
    onInput?: ((value: string) => void) | undefined;
    /** Whether to open dropdown on focus. Defaults to false for name field (free text). */
    openOnFocus?: boolean;
    /** Whether to focus the input on mount */
    autofocus?: boolean;
  }

  let {
    projectId,
    value,
    onSelect,
    disabled = false,
    id,
    onEnter,
    onInput,
    openOnFocus = false, // Default to false for name field - user types custom names
    autofocus = false,
  }: NameBranchDropdownProps = $props();

  // State
  let branches = $state<readonly BaseInfo[]>([]);
  let error = $state<string | null>(null);

  // Load branches on mount or when projectId changes
  $effect(() => {
    error = null;

    projects
      .fetchBases(projectId)
      .then((result: { bases: readonly BaseInfo[] }) => {
        branches = result.bases;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : "Failed to load branches";
      });
  });

  /**
   * Filter branches to only those with derives set (can create workspace from them).
   */
  const derivableBranches = $derived(branches.filter((b) => b.derives !== undefined));

  /**
   * Transform branches to DropdownOption[] with headers for local/remote groups.
   * Only includes branches with derives set.
   */
  const dropdownOptions = $derived.by((): DropdownOption[] => {
    const localBranches = derivableBranches.filter((b) => !b.isRemote);
    const remoteBranches = derivableBranches.filter((b) => b.isRemote);

    const options: DropdownOption[] = [];

    if (localBranches.length > 0) {
      options.push({ type: "header", label: "Local Branches", value: "__header_local__" });
      for (const branch of localBranches) {
        // Label is the derives value (display name), value is full ref for lookup
        options.push({ type: "option", label: branch.derives!, value: branch.name });
      }
    }

    if (remoteBranches.length > 0) {
      options.push({ type: "header", label: "Remote Branches", value: "__header_remote__" });
      for (const branch of remoteBranches) {
        // Label is the derives value (without remote prefix), value is full ref
        options.push({ type: "option", label: branch.derives!, value: branch.name });
      }
    }

    return options;
  });

  /**
   * Filter function for branches - matches by label (derives value).
   * Headers are shown only if there are matching branches in their group.
   */
  function filterBranch(option: DropdownOption, filterLowercase: string): boolean {
    if (option.type === "header") {
      // Keep headers if there are matching branches in their group
      if (option.value === "__header_local__") {
        return derivableBranches.some(
          (b) => !b.isRemote && b.derives?.toLowerCase().includes(filterLowercase)
        );
      }
      if (option.value === "__header_remote__") {
        return derivableBranches.some(
          (b) => b.isRemote && b.derives?.toLowerCase().includes(filterLowercase)
        );
      }
      return false;
    }
    return option.label.toLowerCase().includes(filterLowercase);
  }

  /**
   * Handle selection from the dropdown.
   * Looks up the branch to get the suggested base.
   */
  function handleSelect(selectedValue: string): void {
    // Find the branch that was selected
    const branch = branches.find((b) => b.name === selectedValue);

    if (branch?.derives) {
      // Selected an existing branch - conditionally include suggestedBase
      const selection: NameBranchSelection = {
        name: branch.derives,
        isExistingBranch: true,
      };
      if (branch.base !== undefined) {
        onSelect({ ...selection, suggestedBase: branch.base });
      } else {
        onSelect(selection);
      }
    } else {
      // Custom name typed (not in list)
      onSelect({
        name: selectedValue,
        isExistingBranch: false,
      });
    }
  }

  // Reference to the inner dropdown for focus delegation
  let dropdownRef: { focus: () => void } | undefined = $state();

  /**
   * Focus the input element.
   * Exported for parent components to programmatically focus this dropdown.
   */
  export function focus(): void {
    dropdownRef?.focus();
  }
</script>

<div class="name-branch-dropdown">
  {#if error}
    <div class="error-message" role="alert">{error}</div>
  {:else}
    <FilterableDropdown
      bind:this={dropdownRef}
      options={dropdownOptions}
      {value}
      onSelect={handleSelect}
      {disabled}
      placeholder="Enter name or select branch..."
      filterOption={filterBranch}
      id={id ?? `name-branch-dropdown-${projectId}`}
      allowFreeText={true}
      {onEnter}
      {onInput}
      {openOnFocus}
      {autofocus}
    />
    <!-- No optionSnippet needed - content inherits FilterableDropdown's
         .group-header and .dropdown-option styling -->
  {/if}
</div>

<style>
  .name-branch-dropdown {
    width: 100%;
  }

  .error-message {
    padding: 8px;
    font-size: 12px;
    color: var(--ch-error-fg);
  }

  /* Note: .header-text and .branch-text removed - content inherits
     FilterableDropdown's .group-header and .dropdown-option styling */
</style>
