<!--
  DialogHost.svelte

  Thin wrapper that:
  - Subscribes to api:dialog:command IPC events
  - Calls processCommand() on the dialog-framework store
  - Renders one DialogView per active MODAL dialog from the store

  Panel-surface sessions are stored here too (single subscription point) but
  rendered by MainView as a PanelView in the content area.
-->
<script lang="ts">
  import * as api from "$lib/api";
  import type { DialogCommand } from "@shared/dialog-types";
  import { processCommand, dialogs } from "$lib/stores/dialog-framework.svelte.js";
  import DialogView from "./DialogView.svelte";

  interface Props {
    /** When true, dialogs are positioned in the workspace area (sidebar stays visible). */
    workspaceArea?: boolean;
  }

  const { workspaceArea = false }: Props = $props();

  // Subscribe to dialog commands from main process
  $effect(() => {
    const unsub = api.on<DialogCommand>("dialog:command", (command) => {
      processCommand(command);
    });
    return () => {
      unsub();
    };
  });
</script>

{#each [...dialogs.value.values()].filter((e) => e.surface === "modal") as entry (entry.dialogId)}
  <DialogView dialogId={entry.dialogId} config={entry.config} {workspaceArea} />
{/each}
