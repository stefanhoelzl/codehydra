<!--
  NotificationHost.svelte

  Thin wrapper that:
  - Subscribes to api:notification:command IPC events
  - Calls processCommand() on the notification store
-->
<script lang="ts">
  import * as api from "$lib/api";
  import type { NotificationCommand } from "@shared/notification-types";
  import { processCommand } from "$lib/stores/notification-store.svelte.js";

  // Subscribe to notification commands from main process
  $effect(() => {
    const unsub = api.on<NotificationCommand>("notification:command", (command) => {
      processCommand(command);
    });
    return () => {
      unsub();
    };
  });
</script>
