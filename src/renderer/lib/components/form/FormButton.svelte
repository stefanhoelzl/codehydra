<!--
  FormButton.svelte

  Declarative button leaf (buttons appear inside group sections). A labeled
  button shows busyLabel (or label) while busy; an icon-only button spins its
  icon. Disabled/busy click suppression is the owner's concern (Form's button
  handler) — this leaf only reports the click.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { ButtonItem } from "./types";

  interface Props {
    button: ButtonItem;
    onClick: () => void;
  }

  const { button, onClick }: Props = $props();
</script>

<vscode-button
  class:icon-button={!button.label}
  secondary={button.variant === "secondary" || undefined}
  disabled={button.disabled || button.busy || undefined}
  data-autofocus={button.autofocus || undefined}
  data-primary={button.variant === "primary" || undefined}
  aria-label={button.label ?? button.title}
  onclick={onClick}
  {...button.title ? { title: button.title } : {}}
>
  {#if button.icon}
    <span class="button-icon" class:icon-only={!button.label}>
      <Icon name={button.icon} spin={!!button.busy && !button.label} />
    </span>
  {/if}
  {#if button.label}
    {button.busy ? (button.busyLabel ?? button.label) : button.label}
  {/if}
</vscode-button>

<style>
  /* Icon rendered inside a labeled button gets breathing room before the
     text; icon-only buttons don't need it. */
  .button-icon {
    display: inline-flex;
    align-items: center;
  }

  .button-icon:not(.icon-only) {
    margin-right: 0.3rem;
  }

  /* Icons slotted into buttons follow the button's text color instead of the
     muted global --vscode-icon-foreground, which is barely visible on the
     filled primary background. The button chrome itself is untouched. */
  vscode-button {
    --vscode-icon-foreground: var(--vscode-button-foreground, #ffffff);
  }

  vscode-button[secondary] {
    --vscode-icon-foreground: var(--vscode-button-secondaryForeground, #cccccc);
  }
</style>
