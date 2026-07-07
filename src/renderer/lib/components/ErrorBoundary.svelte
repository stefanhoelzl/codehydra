<!--
  ErrorBoundary.svelte

  A reusable wall around a UI subtree. Wraps Svelte's <svelte:boundary> so a
  throw during rendering / effects / $derived recomputation is CONTAINED to this
  region — the boundary swaps its content for a fallback instead of letting the
  error propagate to window and reach the main-process crash guard (which would
  otherwise report + surface a quit-only dialog).

  Two reporting hops, both over existing channels (no new IPC):
  - logger.error → the renderer `log` event, so it lands in the log file that is
    attached to bug / crash reports.
  - a deferred re-throw → the main-process uncaught-exception path (CDP
    Runtime.exceptionThrown), which reports it to telemetry. That path is
    non-fatal for uncaught exceptions (see error-report-module), so the app
    keeps running while this boundary shows its fallback.

  IMPORTANT: <svelte:boundary> only catches errors thrown DURING rendering /
  effects. Errors from event handlers or async work (setTimeout, promises) are
  NOT caught here — those must be handled at their source (e.g. cancel timers on
  destroy) and, as a last resort, by the main-process crash guard.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { createLogger } from "$lib/logging";

  interface Props {
    /** Names the walled-off region in logs / telemetry (e.g. "dialog:abc"). */
    label: string;
    /** The subtree to protect. */
    children: Snippet;
    /**
     * Optional custom fallback, rendered in place of the subtree after a catch.
     * Receives the error and a `reset` that re-creates the subtree. A minimal
     * default is used when omitted.
     */
    fallback?: Snippet<[unknown, () => void]>;
  }

  const { label, children, fallback }: Props = $props();

  const logger = createLogger("ui");

  function onerror(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`UI boundary "${label}" caught an error`, {
      message: err.message,
      stack: err.stack ?? null,
    });
    // Re-surface asynchronously so the main-process crash guard reports it to
    // telemetry via the existing uncaught-exception path — non-fatal there, so
    // the app survives while this boundary shows its fallback. Deferred so it
    // does not re-enter the boundary while it is still handling the error.
    setTimeout(() => {
      throw err;
    }, 0);
  }
</script>

<svelte:boundary {onerror}>
  {@render children()}

  {#snippet failed(error, reset)}
    {#if fallback}
      {@render fallback(error, reset)}
    {:else}
      <div class="ch-boundary-fallback" role="alert">
        <p>Something went wrong here.</p>
        <button type="button" onclick={reset}>Try again</button>
      </div>
    {/if}
  {/snippet}
</svelte:boundary>

<style>
  .ch-boundary-fallback {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: var(--ch-foreground);
  }

  .ch-boundary-fallback button {
    padding: 4px 12px;
    color: var(--ch-button-foreground, var(--vscode-button-foreground, #ffffff));
    background: var(--ch-button-background, var(--vscode-button-background, #0e639c));
    border: none;
    border-radius: var(--ch-radius-sm, 4px);
    cursor: pointer;
  }
</style>
