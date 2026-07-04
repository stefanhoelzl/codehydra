<!--
  DialogHost.svelte

  Renders one DialogView per open MODAL dialog from the ui:state snapshot
  (via the dialog-framework store, a read-only derived view). Panel-surface
  sessions are rendered by MainView as a PanelView in the content area.
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

{#each dialogs.filter((d) => d.surface === "modal") as entry (entry.id)}
  <DialogView dialogId={entry.id} config={entry.config} />
{/each}
