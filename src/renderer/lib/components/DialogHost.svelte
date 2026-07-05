<!--
  DialogHost.svelte

  Renders one DialogView per open dialog of kind "modal" (the blocking popups)
  from the ui:state snapshot. The non-blocking kinds — "modeless" (creation) and
  "panel" (deletion) — are rendered by MainView as PanelViews instead.
-->
<script lang="ts">
  import type { UiDialog } from "@shared/ui-state";
  import DialogView from "./DialogView.svelte";

  interface Props {
    /** Open dialog sessions from the snapshot (modal + panel). */
    dialogs: readonly UiDialog[];
  }

  const { dialogs }: Props = $props();
</script>

{#each dialogs.filter((d) => d.kind === "modal") as entry (entry.id)}
  <DialogView dialogId={entry.id} config={entry.config} />
{/each}
