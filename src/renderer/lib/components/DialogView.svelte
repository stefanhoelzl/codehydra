<!--
  DialogView.svelte

  Modal surface for the declarative dialog framework.
  Renders the chrome — faded logo backdrop + centered card — and delegates the
  sections + actions to <Form>, which owns the keyboard contract (Escape ->
  dismiss, Cmd/Ctrl+Enter -> primary, Tab trap). One DialogView is rendered
  per active dialog by DialogHost.
-->
<script lang="ts">
  import type { DialogConfig } from "@shared/dialog-types";
  import Logo from "./Logo.svelte";
  import Form from "./form/Form.svelte";

  interface Props {
    dialogId: string;
    config: DialogConfig;
    /** When true, offset left to keep sidebar visible. */
    workspaceArea?: boolean;
  }

  const { dialogId, config, workspaceArea = false }: Props = $props();

  /** Derive heading text from sections for aria-label. */
  const heading = $derived.by(() => {
    const headingSection = config.sections.find((s) => s.type === "text" && s.style === "heading");
    return headingSection?.type === "text" ? headingSection.content : "Dialog";
  });
</script>

<div class="dialog-view" class:workspace-area={workspaceArea} role="dialog" aria-label={heading}>
  <div class="backdrop" aria-hidden="true">
    <Logo size={128} />
  </div>
  <div class="card">
    <Form {dialogId} {config} />
  </div>
</div>

<style>
  .dialog-view {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--ch-surface-0, var(--ch-background));
    z-index: 900;
  }

  .dialog-view.workspace-area {
    left: var(--ch-sidebar-minimized-width, 20px);
  }

  .backdrop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: var(--ch-logo-backdrop-opacity, 0.15);
    pointer-events: none;
  }

  .card {
    position: relative;
    max-width: 500px;
    width: 100%;
    padding: 2rem;
    text-align: center;
    background: color-mix(in srgb, var(--ch-surface-1, var(--ch-background)) 90%, transparent);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-lg, 14px);
    box-shadow: var(--ch-shadow);
  }
</style>
