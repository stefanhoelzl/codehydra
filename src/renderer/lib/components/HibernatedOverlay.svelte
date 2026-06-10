<!--
  HibernatedOverlay.svelte

  Shown over the workspace pane when the active workspace is hibernated.
  Renders the saved screenshot (if any) plus a centered pause indicator.
  The screenshot file may not exist; the <img> onerror handler hides the
  image and the placeholder layer shows through.
-->
<script lang="ts">
  import * as api from "$lib/api";
  import Icon from "./Icon.svelte";
  import { handleHibernateToggle } from "$lib/stores/shortcuts.svelte";
  import type { WorkspaceRef } from "$lib/api";

  interface Props {
    workspaceRef: WorkspaceRef;
  }

  let { workspaceRef }: Props = $props();

  let screenshotUrl = $state<string | null>(null);
  let imageBroken = $state(false);

  $effect(() => {
    const ref = workspaceRef;
    imageBroken = false;
    screenshotUrl = null;
    void api.workspaces
      .getScreenshot(ref.projectId, ref.workspaceName)
      .then((result) => {
        screenshotUrl = result.url;
      })
      .catch(() => {
        screenshotUrl = null;
      });
  });
</script>

<div class="hibernated-overlay">
  {#if screenshotUrl && !imageBroken}
    <img class="screenshot" src={screenshotUrl} alt="" onerror={() => (imageBroken = true)} />
  {/if}
  <div class="dim" aria-hidden="true"></div>
  <button
    class="indicator"
    type="button"
    aria-label="Wake workspace"
    onclick={() => void handleHibernateToggle()}
  >
    <span class="icon-pause"><Icon name="debug-pause" size={48} /></span>
    <span class="icon-play"><Icon name="debug-start" size={48} /></span>
    <span class="label">Hibernated</span>
    <span class="hint">Click or press Alt+X H to wake up</span>
  </button>
</div>

<style>
  .hibernated-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-sidebar-minimized-width, 20px);
    background: var(--ch-surface-0, var(--ch-background));
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .screenshot {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top left;
  }

  .dim {
    position: absolute;
    inset: 0;
    background: var(--ch-surface-0, rgba(0, 0, 0, 0.55));
    opacity: 0.7;
  }

  .indicator {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--ch-foreground);
    opacity: 0.8;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    background: transparent;
    border: none;
    padding: 8px;
    font: inherit;
    cursor: pointer;
  }

  .indicator:hover,
  .indicator:focus-visible {
    opacity: 1;
  }

  /* Pause at rest, play while hovering the indicator (= "click to wake"). */
  .icon-pause {
    display: flex;
  }

  .icon-play {
    display: none;
  }

  .indicator:hover .icon-pause {
    display: none;
  }

  .indicator:hover .icon-play {
    display: flex;
  }

  .label {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .hint {
    font-size: 12px;
    opacity: 0.7;
  }
</style>
