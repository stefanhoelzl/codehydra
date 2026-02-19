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
  <p class="hint">
    Tip: <vscode-badge>Alt+X</vscode-badge> for keyboard shortcuts
  </p>
</div>

<style>
  .setup-complete {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .checkmark {
    --vscode-icon-foreground: var(--ch-success);
  }

  p {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 500;
  }

  .hint {
    font-size: 0.875rem;
    font-weight: 400;
    opacity: 0.7;
  }
</style>
