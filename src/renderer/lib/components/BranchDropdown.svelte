<script lang="ts">
  import { listBases, type BaseInfo } from "$lib/api";

  interface BranchDropdownProps {
    projectPath: string;
    value: string;
    onSelect: (branch: string) => void;
    disabled?: boolean;
  }

  let { projectPath, value, onSelect, disabled = false }: BranchDropdownProps = $props();

  // State
  let branches = $state<BaseInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let isOpen = $state(false);
  let highlightedIndex = $state(-1);

  // Debounce state
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debouncedFilter = $state("");

  // Track local filter text separately from prop value
  // This allows typing to filter while keeping prop sync
  let localFilterOverride = $state<string | null>(null);
  const filterText = $derived(localFilterOverride ?? value);

  // IDs for ARIA
  const listboxId = $derived(`branch-listbox-${projectPath.replace(/\//g, "-")}`);

  // Load branches on mount
  $effect(() => {
    loading = true;
    error = null;

    listBases(projectPath)
      .then((result) => {
        branches = result;
        loading = false;
      })
      .catch((err) => {
        error = err instanceof Error ? err.message : "Failed to load branches";
        loading = false;
      });
  });

  // Debounce filter input
  $effect(() => {
    // Capture filterText here to establish dependency tracking
    const currentFilter = filterText;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debouncedFilter = currentFilter;
    }, 200);

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  });

  // Derived: filtered branches
  const filteredBranches = $derived.by(() => {
    if (!debouncedFilter) return branches;
    const lower = debouncedFilter.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(lower));
  });

  // Derived: local branches
  const localBranches = $derived(filteredBranches.filter((b) => !b.isRemote));

  // Derived: remote branches
  const remoteBranches = $derived(filteredBranches.filter((b) => b.isRemote));

  // Derived: all visible options (for keyboard navigation)
  const allOptions = $derived([...localBranches, ...remoteBranches]);

  // Derived: highlighted option ID
  const highlightedId = $derived.by(() => {
    const opt = allOptions[highlightedIndex];
    return opt ? `branch-option-${opt.name.replace(/\//g, "-")}` : undefined;
  });

  function handleFocus(): void {
    if (!disabled) {
      isOpen = true;
    }
  }

  function handleBlur(event: FocusEvent): void {
    // Check if focus is moving to an element within the dropdown
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    if (relatedTarget?.closest(".branch-dropdown")) {
      return;
    }
    isOpen = false;
    highlightedIndex = -1;
  }

  function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    localFilterOverride = target.value;
    highlightedIndex = -1;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const options = allOptions;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
        }
        highlightedIndex = highlightedIndex < options.length - 1 ? highlightedIndex + 1 : 0;
        break;

      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
        }
        highlightedIndex = highlightedIndex > 0 ? highlightedIndex - 1 : options.length - 1;
        break;

      case "Enter":
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          selectBranch(options[highlightedIndex]!.name);
        }
        break;

      case "Escape":
        event.preventDefault();
        isOpen = false;
        highlightedIndex = -1;
        break;

      case "Tab":
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          selectBranch(options[highlightedIndex]!.name);
        }
        isOpen = false;
        break;
    }
  }

  function selectBranch(name: string): void {
    localFilterOverride = name;
    debouncedFilter = name;
    isOpen = false;
    highlightedIndex = -1;
    onSelect(name);
  }

  function handleOptionClick(name: string): void {
    selectBranch(name);
  }
</script>

<div class="branch-dropdown">
  <input
    type="text"
    role="combobox"
    aria-expanded={isOpen}
    aria-controls={listboxId}
    aria-activedescendant={highlightedId}
    aria-autocomplete="list"
    aria-haspopup="listbox"
    value={filterText}
    {disabled}
    placeholder="Select branch..."
    onfocus={handleFocus}
    onblur={handleBlur}
    oninput={handleInput}
    onkeydown={handleKeyDown}
  />

  {#if loading}
    <div class="loading-indicator" role="status">Loading branches...</div>
  {:else if error}
    <div class="error-message" role="alert">{error}</div>
  {:else if isOpen}
    <ul id={listboxId} class="branch-listbox" role="listbox">
      {#if allOptions.length === 0}
        <li class="no-results">No branches found</li>
      {:else}
        {#if localBranches.length > 0}
          <li class="group-header" role="presentation">Local Branches</li>
          {#each localBranches as branch, i (branch.name)}
            <li
              id={`branch-option-${branch.name.replace(/\//g, "-")}`}
              role="option"
              class="branch-option"
              class:highlighted={highlightedIndex === i}
              aria-selected={highlightedIndex === i}
              onclick={() => handleOptionClick(branch.name)}
              onkeydown={(e) => e.key === "Enter" && handleOptionClick(branch.name)}
            >
              {branch.name}
            </li>
          {/each}
        {/if}

        {#if remoteBranches.length > 0}
          <li class="group-header" role="presentation">Remote Branches</li>
          {#each remoteBranches as branch, i (branch.name)}
            <li
              id={`branch-option-${branch.name.replace(/\//g, "-")}`}
              role="option"
              class="branch-option"
              class:highlighted={highlightedIndex === localBranches.length + i}
              aria-selected={highlightedIndex === localBranches.length + i}
              onclick={() => handleOptionClick(branch.name)}
              onkeydown={(e) => e.key === "Enter" && handleOptionClick(branch.name)}
            >
              {branch.name}
            </li>
          {/each}
        {/if}
      {/if}
    </ul>
  {/if}
</div>

<style>
  .branch-dropdown {
    position: relative;
    width: 100%;
  }

  input {
    width: 100%;
    padding: 6px 8px;
    background: var(--ch-input-bg);
    color: var(--ch-foreground);
    border: 1px solid var(--ch-input-border);
    border-radius: 2px;
    font-size: 13px;
  }

  input:focus {
    outline: none;
    border-color: var(--ch-focus-border);
  }

  input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading-indicator {
    padding: 8px;
    font-size: 12px;
    color: var(--ch-foreground);
    opacity: 0.7;
  }

  .error-message {
    padding: 8px;
    font-size: 12px;
    color: var(--ch-error-fg);
  }

  .branch-listbox {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 200px;
    overflow-y: auto;
    background: var(--ch-input-bg);
    border: 1px solid var(--ch-input-border);
    border-top: none;
    border-radius: 0 0 2px 2px;
    list-style: none;
    padding: 0;
    margin: 0;
    z-index: 100;
  }

  .group-header {
    padding: 6px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--ch-foreground);
    opacity: 0.6;
    background: var(--ch-background);
  }

  .branch-option {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }

  .branch-option:hover,
  .branch-option.highlighted {
    background: var(--ch-list-active-bg);
  }

  .branch-option[aria-selected="true"] {
    background: var(--ch-list-active-bg);
  }

  .no-results {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--ch-foreground);
    opacity: 0.7;
  }
</style>
