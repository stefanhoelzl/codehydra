<script lang="ts">
  import { onMount } from "svelte";
  import Logo from "./Logo.svelte";
  import Icon from "./Icon.svelte";

  /**
   * Success screen component displayed briefly after setup completes.
   * Auto-transitions after 1.5 seconds by emitting the oncomplete event.
   */
  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();

  onMount(() => {
    const timer = setTimeout(() => {
      oncomplete?.();
    }, 1500);

    return () => {
      clearTimeout(timer);
    };
  });
</script>

<div class="setup-complete" role="status" aria-live="polite">
  <Logo animated={false} />
  <span class="checkmark" aria-hidden="true">
    <Icon name="check" size={48} />
  </span>
  <p>Setup complete!</p>
</div>

<style>
  .setup-complete {
    display: contents;
  }

  .setup-complete :global(img) {
    margin-bottom: 1rem;
  }

  .checkmark {
    --vscode-icon-foreground: var(--ch-success);
    margin-bottom: 1rem;
  }

  p {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
  }
</style>
