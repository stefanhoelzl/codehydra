<!--
  PanelView.svelte

  Panel surface for the declarative form framework: a non-modal, docked panel
  shown in place of the main content area (the look of NewWorkspaceView), with
  the sections + actions delegated to <Form>. Rendered by MainView for the
  active panel-surface session (see dialog-framework's panelDialog).

  Shell behaviour (renderer-owned; the backend owns the form session):
  - Docked over the content area (sidebar stays visible), z-index 1 so modal
    dialogs (z 900) stack above.
  - Keyboard (Escape -> dismiss, Cmd/Ctrl+Enter -> primary, Tab trap) is owned
    by Form — shared with the modal surface.
  - When the last modal stacked above the panel closes, the panel re-places
    focus on the form's autofocus control (focus would otherwise be lost to
    <body>, leaving the keyboard flow dead).
  - Form is keyed by dialogId: a backend close + reopen remounts it with fresh
    field values (the reset gesture).
-->
<script lang="ts">
  import type { DialogConfig } from "@shared/dialog-types";
  import Form from "./form/Form.svelte";
  import { dialogs } from "$lib/stores/dialog-framework.svelte";

  interface Props {
    dialogId: string;
    config: DialogConfig;
  }

  const { dialogId, config }: Props = $props();

  let formRef: Form | undefined = $state();

  /** Derive heading text from sections for the accessible name. */
  const heading = $derived.by(() => {
    const headingSection = config.sections.find((s) => s.type === "text" && s.style === "heading");
    return headingSection?.type === "text" ? headingSection.content : "Panel";
  });

  // Refocus the form when the last modal above the panel closes (modals steal
  // focus while open; on close the panel is the active surface again).
  const modalAbove = $derived(
    [...dialogs.value.values()].some((entry) => entry.surface === "modal")
  );
  let hadModalAbove = false;
  $effect(() => {
    if (hadModalAbove && !modalAbove) formRef?.refocus();
    hadModalAbove = modalAbove;
  });
</script>

<section class="panel-view" aria-label={heading}>
  <div class="panel-card">
    {#key dialogId}
      <Form bind:this={formRef} {dialogId} {config} surface="panel" />
    {/key}
  </div>
</section>

<style>
  .panel-view {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--ch-sidebar-minimized-width, 20px);
    background: var(--ch-surface-0, var(--ch-background));
    display: flex;
    align-items: center;
    justify-content: center;
    overflow-y: auto;
    z-index: 1;
  }

  .panel-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(640px, 90%);
    padding: 24px;
    text-align: center;
    background: var(--ch-surface-1, var(--ch-background));
    border: 1px solid var(--ch-input-border);
    border-radius: var(--ch-radius-md, 8px);
    box-shadow: var(--ch-shadow);
  }
</style>
