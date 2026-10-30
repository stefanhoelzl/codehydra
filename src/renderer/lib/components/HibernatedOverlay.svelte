<!--
  HibernatedOverlay.svelte

  Shown over the workspace pane when the active workspace is hibernated.
  Renders the saved screenshot (inline data URL from the UiState snapshot;
  null while loading or when no screenshot exists) plus a centered pause
  indicator, with how long it has slept when that is known. The onerror
  handler hides a broken image so the placeholder layer shows through.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import { describeHibernation } from "$lib/utils/hibernation-age.js";
  import { minuteNow } from "$lib/utils/minute-clock.svelte.js";

  interface Props {
    /** Inline screenshot data URL from the snapshot (null = none/loading). */
    screenshot: string | null;
    /** When it was hibernated (ISO-8601); null when unrecorded. */
    hibernatedAt?: string | null;
    /** Wake the active (hibernated) workspace. */
    onWake: () => void;
  }

  let { screenshot, hibernatedAt = null, onWake }: Props = $props();

  let imageBroken = $state(false);

  const age = $derived(describeHibernation(hibernatedAt, minuteNow()));
</script>

<div class="hibernated-overlay">
  {#if screenshot && !imageBroken}
    <img class="screenshot" src={screenshot} alt="" onerror={() => (imageBroken = true)} />
  {/if}
  <div class="dim" aria-hidden="true"></div>
  <button class="indicator" type="button" aria-label="Wake workspace" onclick={() => onWake()}>
    <span class="icon-pause"><Icon name="debug-pause" size={48} /></span>
    <span class="icon-play"><Icon name="debug-start" size={48} /></span>
    <span class="label">Hibernated</span>
    {#if age !== null}
      <span class="age">{age.relative} · {age.date}</span>
    {/if}
    <span class="hint">Click or press Alt+X H to wake up</span>
  </button>
</div>

<style>
  .hibernated-overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-workspace-left, var(--ch-sidebar-minimized-width, 20px));
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

  .age {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .hint {
    font-size: 12px;
    opacity: 0.7;
  }
</style>
