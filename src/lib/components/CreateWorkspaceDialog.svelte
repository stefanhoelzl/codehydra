<script lang="ts">
  import type { Project, BranchInfo, Workspace } from '$lib/types/project';
  import { listBranches, fetchBranches, createNewWorkspace } from '$lib/services/projectManager';

  interface Props {
    project: Project;
    onClose: () => void;
    onCreated: (workspace: Workspace) => void;
    triggerElement: HTMLElement | null;
  }

  let { project, onClose, onCreated, triggerElement }: Props = $props();

  // Refs
  let dialogRef: HTMLElement | null = $state(null);
  let nameInputRef: HTMLInputElement | null = $state(null);
  let filterInputRef: HTMLInputElement | null = $state(null);
  let dropdownTriggerRef: HTMLButtonElement | null = $state(null);

  // Form state
  let name = $state('');
  let selectedBranch = $state('');
  let branches = $state<BranchInfo[]>([]);
  let isCreating = $state(false);
  let isLoadingBranches = $state(true);
  let isFetchingRemotes = $state(false);
  let backendError = $state<string | null>(null);
  let dropdownOpen = $state(false);
  let filterText = $state('');
  let highlightedIndex = $state(-1);

  // Extract branch names for uniqueness check
  let existingNames = $derived(
    new Set([
      ...branches.map((b) => {
        // For remote branches, strip prefix (e.g., origin/feat/auth -> feat/auth)
        if (b.isRemote) {
          const parts = b.name.split('/');
          return parts.slice(1).join('/');
        }
        return b.name;
      }),
      ...project.workspaces.map((w) => w.name),
    ])
  );

  // Validation
  function validateName(value: string): string | null {
    if (!value.trim()) return null;

    // Security: no path traversal
    if (value.includes('..')) {
      return 'Name cannot contain ".."';
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/.test(value)) {
      return 'Must start with letter/number, can contain letters, numbers, hyphens, underscores, slashes, dots';
    }

    if (value.length > 100) {
      return 'Name must be 100 characters or less';
    }

    if (existingNames.has(value)) {
      // Determine if it's local or remote for better message
      const matchingBranch = branches.find((b) => {
        if (b.isRemote) {
          return b.name.split('/').slice(1).join('/') === value;
        }
        return b.name === value;
      });
      if (matchingBranch) {
        return matchingBranch.isRemote
          ? `A remote branch '${matchingBranch.name}' with this name exists`
          : `A local branch with this name already exists`;
      }
      return 'A workspace with this name already exists';
    }

    return null;
  }

  let nameError = $derived(validateName(name));
  let isValid = $derived(name.trim() !== '' && !nameError && selectedBranch !== '' && !isCreating);

  // Filtered branches based on filter text
  let filteredBranches = $derived(
    filterText
      ? branches.filter((b) => b.name.toLowerCase().includes(filterText.toLowerCase()))
      : branches
  );

  let localBranches = $derived(filteredBranches.filter((b) => !b.isRemote));
  let remoteBranches = $derived(filteredBranches.filter((b) => b.isRemote));

  // Flat list of all filtered branches for keyboard navigation
  let allFilteredBranches = $derived([...localBranches, ...remoteBranches]);

  // Reset highlighted index when filter changes
  $effect(() => {
    const _trackFilter = filterText;
    if (_trackFilter !== undefined) {
      highlightedIndex = -1;
    }
  });

  // Clear backend error when user modifies inputs
  $effect(() => {
    // Track dependencies by using them
    const _trackedName = name;
    const _trackedBranch = selectedBranch;
    if (_trackedName || _trackedBranch) {
      backendError = null;
    }
  });

  // Auto-select remote branch when name matches
  $effect(() => {
    const trimmedName = name.trim();
    if (trimmedName && branches.length > 0) {
      const matchingRemote = branches.find(
        (b) => b.isRemote && b.name.split('/').slice(1).join('/') === trimmedName
      );
      if (matchingRemote) {
        selectedBranch = matchingRemote.name;
      }
    }
  });

  // Focus name input when dialog mounts
  $effect(() => {
    if (nameInputRef) {
      setTimeout(() => nameInputRef?.focus(), 50);
    }
  });

  // Initialize on mount
  $effect(() => {
    loadBranches();
    startBackgroundFetch();
  });

  async function loadBranches() {
    isLoadingBranches = true;
    try {
      branches = await listBranches(project.handle);

      // Default to main workspace's branch
      const mainBranch = project.workspaces[0]?.branch;
      if (mainBranch && branches.some((b) => b.name === mainBranch)) {
        selectedBranch = mainBranch;
      } else if (branches.length > 0) {
        // Prefer local branches
        const firstLocal = branches.find((b) => !b.isRemote);
        selectedBranch = firstLocal?.name ?? branches[0].name;
      }
    } catch (e) {
      console.error('Failed to load branches:', e);
    } finally {
      isLoadingBranches = false;
    }
  }

  async function startBackgroundFetch() {
    isFetchingRemotes = true;

    try {
      await fetchBranches(project.handle);
      // Refresh branches after fetch
      await loadBranches();
    } catch (e) {
      // Silently ignore - branches might be stale but dialog still works
      console.warn('Background fetch failed:', e);
    } finally {
      isFetchingRemotes = false;
    }
  }

  async function handleSubmit() {
    if (!isValid || isCreating) return;

    isCreating = true;
    backendError = null;

    try {
      const workspace = await createNewWorkspace(project.handle, name.trim(), selectedBranch);
      onCreated(workspace);
      handleClose();
    } catch (e) {
      // Map backend errors to user-friendly messages
      const errorStr = String(e);
      if (errorStr.includes('BranchNotFound') || errorStr.includes('Branch not found')) {
        backendError = 'The selected branch no longer exists. Please refresh and try again.';
      } else if (
        errorStr.includes('WorkspaceAlreadyExists') ||
        errorStr.includes('already exists')
      ) {
        backendError = 'A workspace with this name already exists.';
      } else {
        backendError = 'Could not create workspace. Please try again.';
      }
    } finally {
      isCreating = false;
    }
  }

  function handleClose() {
    onClose();
    // Return focus to trigger element
    triggerElement?.focus();
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (dropdownOpen) {
        dropdownOpen = false;
        e.preventDefault();
      } else {
        e.preventDefault();
        handleClose();
      }
    }
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && isValid) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function selectBranch(branchName: string) {
    selectedBranch = branchName;
    dropdownOpen = false;
    filterText = '';
    highlightedIndex = -1;
    // Return focus to the trigger
    dropdownTriggerRef?.focus();
  }

  function openDropdownAndFocusFilter() {
    dropdownOpen = true;
    highlightedIndex = -1;
    // Focus the filter input after dropdown opens
    setTimeout(() => filterInputRef?.focus(), 0);
  }

  function handleDropdownKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (!dropdownOpen) {
        e.preventDefault();
        openDropdownAndFocusFilter();
      }
    } else if (e.key === 'Escape' && dropdownOpen) {
      e.preventDefault();
      dropdownOpen = false;
      filterText = '';
      highlightedIndex = -1;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdownOpen) {
        openDropdownAndFocusFilter();
      } else {
        // Navigate options
        navigateOptions(e.key === 'ArrowDown' ? 1 : -1);
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Alphanumeric key - open dropdown and start filtering
      if (!dropdownOpen) {
        openDropdownAndFocusFilter();
      }
      // The character will be typed into the filter input since we're focusing it
    }
  }

  function handleFilterKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigateOptions(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < allFilteredBranches.length) {
        selectBranch(allFilteredBranches[highlightedIndex].name);
      } else if (allFilteredBranches.length > 0) {
        // Select first option if nothing highlighted
        selectBranch(allFilteredBranches[0].name);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dropdownOpen = false;
      filterText = '';
      highlightedIndex = -1;
      dropdownTriggerRef?.focus();
    }
  }

  function navigateOptions(direction: number) {
    const total = allFilteredBranches.length;
    if (total === 0) return;

    if (highlightedIndex === -1) {
      // Nothing highlighted yet
      highlightedIndex = direction > 0 ? 0 : total - 1;
    } else {
      highlightedIndex = (highlightedIndex + direction + total) % total;
    }

    // Scroll the highlighted option into view
    scrollHighlightedIntoView();
  }

  function scrollHighlightedIntoView() {
    setTimeout(() => {
      const highlighted = document.querySelector('.dropdown-option.highlighted');
      highlighted?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  // Focus trap
  function handleFocusTrap(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !dialogRef) return;

    const focusables = dialogRef.querySelectorAll<HTMLElement>(
      'input, select, button, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
</script>

<div
  class="modal-overlay"
  onclick={handleOverlayClick}
  onkeydown={(e) => {
    handleKeydown(e);
    handleFocusTrap(e);
  }}
  role="presentation"
>
  <div
    bind:this={dialogRef}
    class="modal-content"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
  >
    <h2 id="dialog-title">Create Workspace</h2>

    <div class="form-group">
      <label for="workspace-name">Name</label>
      <input
        id="workspace-name"
        type="text"
        bind:this={nameInputRef}
        bind:value={name}
        onkeydown={handleNameKeydown}
        aria-invalid={!!nameError}
        aria-describedby={nameError ? 'name-error' : undefined}
        disabled={isCreating}
        class:error={nameError}
      />
      {#if nameError}
        <div id="name-error" class="field-error">{nameError}</div>
      {/if}
    </div>

    <div class="form-group">
      <label for="base-branch">
        Base Branch
        {#if isFetchingRemotes}
          <span class="spinner" role="progressbar" aria-label="Fetching remote branches"></span>
        {/if}
      </label>
      {#if isLoadingBranches}
        <div class="loading">Loading branches...</div>
      {:else}
        <div class="dropdown-container">
          <button
            type="button"
            class="dropdown-trigger"
            bind:this={dropdownTriggerRef}
            onclick={() => {
              if (dropdownOpen) {
                dropdownOpen = false;
                filterText = '';
                highlightedIndex = -1;
              } else {
                openDropdownAndFocusFilter();
              }
            }}
            onkeydown={handleDropdownKeydown}
            disabled={isCreating}
            aria-label="Select base branch"
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
          >
            <span class="dropdown-value">{selectedBranch || 'Select a branch'}</span>
            <span class="dropdown-arrow">{dropdownOpen ? '\u25B2' : '\u25BC'}</span>
          </button>

          {#if dropdownOpen}
            <div class="dropdown-menu" role="listbox">
              <input
                type="text"
                class="dropdown-filter"
                placeholder="Filter branches..."
                bind:this={filterInputRef}
                bind:value={filterText}
                onclick={(e) => e.stopPropagation()}
                onkeydown={handleFilterKeydown}
              />
              <div class="dropdown-options">
                {#if localBranches.length > 0}
                  <div class="dropdown-group-label">Local Branches</div>
                  {#each localBranches as branch, i (branch.name)}
                    <button
                      type="button"
                      class="dropdown-option"
                      class:selected={selectedBranch === branch.name}
                      class:highlighted={highlightedIndex === i}
                      data-highlighted={highlightedIndex === i ? 'true' : undefined}
                      onclick={() => selectBranch(branch.name)}
                      role="option"
                      aria-selected={selectedBranch === branch.name}
                    >
                      {branch.name}
                    </button>
                  {/each}
                {/if}
                {#if remoteBranches.length > 0}
                  <div class="dropdown-group-label">Remote Branches</div>
                  {#each remoteBranches as branch, i (branch.name)}
                    <button
                      type="button"
                      class="dropdown-option"
                      class:selected={selectedBranch === branch.name}
                      class:highlighted={highlightedIndex === localBranches.length + i}
                      data-highlighted={highlightedIndex === localBranches.length + i
                        ? 'true'
                        : undefined}
                      onclick={() => selectBranch(branch.name)}
                      role="option"
                      aria-selected={selectedBranch === branch.name}
                    >
                      {branch.name}
                    </button>
                  {/each}
                {/if}
                {#if filteredBranches.length === 0}
                  <div class="dropdown-empty">No branches found</div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if backendError}
      <div class="error-box" role="alert">{backendError}</div>
    {/if}

    <div class="button-row">
      <button type="button" class="btn btn-secondary" onclick={handleClose} disabled={isCreating}>
        Cancel
      </button>
      <button
        type="button"
        class="btn btn-primary"
        onclick={handleSubmit}
        disabled={!isValid || isCreating}
        aria-busy={isCreating}
      >
        {#if isCreating}
          <span class="spinner" role="progressbar" aria-label="Creating workspace"></span>
          Creating...
        {:else}
          OK
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: var(--vscode-editor-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 8px;
    padding: 24px;
    min-width: 400px;
    max-width: 500px;
  }

  h2 {
    margin: 0 0 20px 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  input[type='text'] {
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    box-sizing: border-box;
  }

  input[type='text']:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  input[type='text'].error {
    border-color: var(--vscode-inputValidation-errorBorder, #be1100);
  }

  input[type='text']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .field-error {
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-errorForeground, #f48771);
  }

  .loading {
    padding: 8px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 13px;
  }

  .dropdown-container {
    position: relative;
  }

  .dropdown-trigger {
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
  }

  .dropdown-trigger:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .dropdown-trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dropdown-value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown-arrow {
    margin-left: 8px;
    font-size: 10px;
  }

  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: var(--vscode-dropdown-background, #3c3c3c);
    border: 1px solid var(--vscode-dropdown-border, #454545);
    border-radius: 4px;
    max-height: 250px;
    overflow: hidden;
    z-index: 1001;
    display: flex;
    flex-direction: column;
  }

  .dropdown-filter {
    margin: 8px;
    padding: 6px 10px;
    font-size: 12px;
    background: var(--vscode-input-background, #2d2d2d);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    box-sizing: border-box;
    width: calc(100% - 16px);
  }

  .dropdown-filter:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .dropdown-options {
    overflow-y: auto;
    flex: 1;
  }

  .dropdown-group-label {
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground, #888);
    text-transform: uppercase;
  }

  .dropdown-option {
    width: 100%;
    padding: 6px 12px;
    font-size: 13px;
    background: transparent;
    color: var(--vscode-dropdown-foreground, #cccccc);
    border: none;
    cursor: pointer;
    text-align: left;
    display: block;
  }

  .dropdown-option:hover,
  .dropdown-option.highlighted {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }

  .dropdown-option.selected {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  .dropdown-option.selected.highlighted {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
  }

  .dropdown-empty {
    padding: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 13px;
  }

  .error-box {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    border-radius: 4px;
    font-size: 13px;
    color: var(--vscode-inputValidation-errorForeground, #f48771);
  }

  .button-row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 20px;
  }

  .btn {
    padding: 8px 16px;
    font-size: 13px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.2s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, #fff);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #026ec1);
  }

  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
