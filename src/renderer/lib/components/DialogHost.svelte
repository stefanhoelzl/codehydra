<!--
  DialogHost.svelte

  Renders one DialogView per open MODAL dialog from the ui:state snapshot
  (via the dialog-framework store, a read-only derived view). Panel-surface
  sessions are rendered by MainView as a PanelView in the content area.
-->
<script lang="ts">
  import { dialogs } from "$lib/stores/dialog-framework.svelte.js";
  import DialogView from "./DialogView.svelte";

  interface Props {
    /** When true, dialogs are positioned in the workspace area (sidebar stays visible). */
    workspaceArea?: boolean;
  }

  const { workspaceArea = false }: Props = $props();
</script>

{#each [...dialogs.value.values()].filter((e) => e.surface === "modal") as entry (entry.dialogId)}
  <DialogView dialogId={entry.dialogId} config={entry.config} {workspaceArea} />
{/each}
