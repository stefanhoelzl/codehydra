<!--
  DialogHost.svelte

  Renders one DialogView per open dialog of kind "modal" (the blocking popups)
  from the ui:state snapshot. The non-blocking kinds — "modeless" (creation) and
  "panel" (deletion) — are rendered by MainView as PanelViews instead.

  Modals stack above everything else and above each other, so the topmost one
  (last in open order) owns focus; the ones below it stop placing focus until
  it closes. Same rule as MainView's panels — see $lib/utils/focus-owner.
-->
<script lang="ts">
  import type { UiDialog } from "@shared/ui-state";
  import { topmostModalId } from "$lib/utils/focus-owner";
  import DialogView from "./DialogView.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";

  interface Props {
    /** Open dialog sessions from the snapshot (modal + panel). */
    dialogs: readonly UiDialog[];
  }

  const { dialogs }: Props = $props();

  const topModal = $derived(topmostModalId(dialogs));
</script>

{#each dialogs.filter((d) => d.kind === "modal") as entry (entry.id)}
  <!-- Per-dialog wall: a render error in one modal shows a fallback for that
       modal only, leaving the rest of the UI live and navigable. -->
  <ErrorBoundary label="dialog:{entry.id}">
    <DialogView dialogId={entry.id} config={entry.config} focusOwned={topModal === entry.id} />
  </ErrorBoundary>
{/each}
