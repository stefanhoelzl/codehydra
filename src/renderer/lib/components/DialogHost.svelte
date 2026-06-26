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
    /** When true, dialogs are positioned in the workspace area (sidebar stays visible). */
    workspaceArea?: boolean;
  }

  const { dialogs, workspaceArea = false }: Props = $props();
</script>

{#each dialogs.filter((d) => d.surface === "modal") as entry (entry.id)}
  <DialogView dialogId={entry.id} config={entry.config} {workspaceArea} />
{/each}
