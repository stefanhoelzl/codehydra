<script lang="ts">
  import type { Project, Workspace, WorkspaceStatus } from '$lib/types/project';
  import { checkWorkspaceStatus, removeWorkspace } from '$lib/services/projectManager';

  interface Props {
    project: Project;
    workspace: Workspace;
    onClose: () => void;
    onRemoved: () => void;
    triggerElement: HTMLElement | null;
  }

  let { project, workspace, onClose, onRemoved, triggerElement }: Props = $props();

  // Refs
  let dialogRef = $state<HTMLElement | null>(null);
  let cancelButtonRef = $state<HTMLButtonElement | null>(null);

  // State
  let status = $state<WorkspaceStatus | null>(null);
  let isLoadingStatus = $state(true);
  let statusError = $state<string | null>(null);
  let isRemoving = $state(false);
  let backendError = $state<string | null>(null);

  // Fetch status on mount and focus cancel button
  $effect(() => {
    loadStatus();
    // Focus cancel button after a tick to ensure DOM is ready
    requestAnimationFrame(() => {
      cancelButtonRef?.focus();
    });
  });

  async function loadStatus() {
    isLoadingStatus = true;
    statusError = null;

    try {
      status = await checkWorkspaceStatus(project.handle, workspace.path);
    } catch (e) {
      console.error('Failed to check workspace status:', e);
      statusError = 'Failed to check workspace status';
    } finally {
      isLoadingStatus = false;
    }
  }

  async function handleRemove(deleteBranch: boolean) {
    if (isRemoving) return;

    isRemoving = true;
    backendError = null;

    try {
      await removeWorkspace(project.handle, workspace.path, deleteBranch);
      onRemoved();
      handleClose();
    } catch (e) {
      const errorStr = String(e);
      if (errorStr.includes('CannotRemoveMainWorktree')) {
        backendError = 'Cannot remove main worktree.';
      } else if (errorStr.includes('WorkspaceNotFound')) {
        backendError = 'Workspace not found.';
      } else {
        backendError = 'Could not remove workspace. Please try again.';
      }
    } finally {
      isRemoving = false;
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
      e.preventDefault();
      handleClose();
    } else if (e.key === 'Enter') {
      // Only trigger if not already removing and status is loaded
      if (!isRemoving && !isLoadingStatus) {
        e.preventDefault();
        handleRemove(true); // Delete (remove worktree AND branch)
      }
    }
  }

  // Focus trap
  function handleFocusTrap(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !dialogRef) return;

    const focusables = dialogRef.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [tabindex]:not([tabindex="-1"])'
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

<svelte:window onkeydown={handleKeydown} />

<div
  class="modal-overlay"
  onclick={handleOverlayClick}
  onkeydown={handleFocusTrap}
  role="presentation"
>
  <div
    bind:this={dialogRef}
    class="modal-content"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      // Allow Escape, Enter, and Tab keys to propagate for dialog actions and focus management
      if (e.key !== 'Escape' && e.key !== 'Enter' && e.key !== 'Tab') {
        e.stopPropagation();
      }
    }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    aria-describedby={status?.hasUncommittedChanges ? 'warning-message' : undefined}
    tabindex="-1"
  >
    <h2 id="dialog-title">Remove Workspace</h2>

    <p class="confirmation">
      Are you sure you want to remove the workspace "{workspace.name}"?
    </p>

    {#if isLoadingStatus}
      <div class="loading" role="progressbar" aria-label="Checking workspace status">
        <span class="spinner"></span>
        Checking workspace status...
      </div>
    {:else if statusError}
      <div class="error-box" role="alert">{statusError}</div>
    {:else if status?.hasUncommittedChanges}
      <div id="warning-message" class="warning-box" role="alert">
        <span class="warning-icon">Warning:</span> This workspace has uncommitted changes that will be
        lost.
      </div>
    {/if}

    {#if backendError}
      <div class="error-box" role="alert">{backendError}</div>
    {/if}

    <div class="button-row">
      <button
        bind:this={cancelButtonRef}
        type="button"
        class="btn btn-secondary"
        onclick={handleClose}
        disabled={isRemoving}
      >
        Cancel
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => handleRemove(false)}
        disabled={isRemoving || isLoadingStatus}
        aria-busy={isRemoving}
      >
        {#if isRemoving}
          <span class="spinner" role="progressbar" aria-label="Removing workspace"></span>
        {/if}
        Keep Branch
      </button>
      <button
        type="button"
        class="btn btn-destructive"
        onclick={() => handleRemove(true)}
        disabled={isRemoving || isLoadingStatus}
        aria-busy={isRemoving}
      >
        {#if isRemoving}
          <span class="spinner" role="progressbar" aria-label="Removing workspace"></span>
        {/if}
        Delete
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
    margin: 0 0 16px 0;
    font-size: 18px;
    font-weight: 500;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .confirmation {
    margin: 0 0 16px 0;
    font-size: 14px;
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    margin-bottom: 16px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 13px;
  }

  .warning-box {
    padding: 12px;
    margin-bottom: 16px;
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    border: 1px solid var(--vscode-inputValidation-warningBorder, #be8c00);
    border-radius: 4px;
    font-size: 13px;
    color: var(--vscode-editorWarning-foreground, #cca700);
  }

  .warning-icon {
    font-weight: 600;
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

  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  .btn-destructive {
    background: var(--vscode-errorForeground, #f48771);
    color: #fff;
  }

  .btn-destructive:hover:not(:disabled) {
    background: #d6735f;
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
