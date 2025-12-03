<script lang="ts">
  import { fade } from 'svelte/transition';
  import { codehydraShortcutActive } from '$lib/stores/keyboardNavigation';
  import { CHIME_SHORTCUTS } from '$lib/config/keybindings';
</script>

{#if $codehydraShortcutActive}
  <div class="overlay" role="status" aria-live="polite" transition:fade={{ duration: 150 }}>
    <span class="shortcut">
      <span class="key">{CHIME_SHORTCUTS.navigateUp.label}</span>
      <span class="desc">{CHIME_SHORTCUTS.navigateUp.description}</span>
    </span>
    <span class="separator"></span>
    <span class="shortcut">
      <span class="key">{CHIME_SHORTCUTS.createWorkspace.label}</span>
      <span class="desc">{CHIME_SHORTCUTS.createWorkspace.description}</span>
    </span>
    <span class="separator"></span>
    <span class="shortcut">
      <span class="key">{CHIME_SHORTCUTS.removeWorkspace.label}</span>
      <span class="desc">{CHIME_SHORTCUTS.removeWorkspace.description}</span>
    </span>
    <span class="separator"></span>
    <span class="shortcut">
      <span class="key">{CHIME_SHORTCUTS.jumpToWorkspace.label}</span>
      <span class="desc">{CHIME_SHORTCUTS.jumpToWorkspace.description}</span>
    </span>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(30, 30, 30, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 8px;
    padding: 10px 20px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    z-index: 999;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .shortcut {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .key {
    font-weight: 600;
    color: rgba(255, 255, 255, 1);
  }

  .desc {
    color: rgba(255, 255, 255, 0.7);
  }

  .separator {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.2);
  }
</style>
