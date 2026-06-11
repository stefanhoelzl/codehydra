<!--
  PanelView.svelte

  Panel surface for the declarative form framework: a non-modal, docked panel
  shown in place of the main content area (the look of NewWorkspaceView), with
  the sections + actions delegated to <Form>. Rendered by MainView for the
  active panel-surface session (see dialog-framework's panelDialog).

  Shell behaviour (renderer-owned; the backend owns the form session):
  - Docked over the content area (sidebar stays visible), z-index 1 so modal
    dialogs (z 900) stack above.
  - Escape emits a "dismiss" event; the backend decides what dismissing means
    (typically close + reopen with fresh config = clear).
  - Cmd/Ctrl+Enter fires the primary action; Enter in fields does not submit.
  - Tab/Shift+Tab is trapped at the panel boundaries so focus doesn't leak
    into the sidebar.
  - Form is keyed by dialogId: a backend close + reopen remounts it with fresh
    field values (the reset gesture).
-->
<script lang="ts">
  import type { DialogConfig, DialogUserEvent } from "@shared/dialog-types";
  import Form from "./form/Form.svelte";
  import { sendDialogEvent } from "$lib/api";
  import { trapTabKey } from "$lib/utils/focus-trap";

  interface Props {
    dialogId: string;
    config: DialogConfig;
  }

  const { dialogId, config }: Props = $props();

  let sectionRef: HTMLElement | undefined = $state();
  let formRef: Form | undefined = $state();

  /** Derive heading text from sections for the accessible name. */
  const heading = $derived.by(() => {
    const headingSection = config.sections.find((s) => s.type === "text" && s.style === "heading");
    return headingSection?.type === "text" ? headingSection.content : "Panel";
  });

  /**
   * Activate the form's primary action. Exposed so hosting code can bind
   * keyboard shortcuts (e.g. Alt+X+Enter) to the panel form's submit.
   */
  export function submitPrimary(): void {
    formRef?.submitPrimary();
  }

  // Escape -> dismiss intent to the backend; Cmd/Ctrl+Enter -> primary action;
  // Tab/Shift+Tab trapped at the panel boundaries (shared focus-trap util,
  // including vscode-elements).
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      formRef?.submitPrimary();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const dismiss: DialogUserEvent = { kind: "dismiss", dialogId };
      sendDialogEvent(dismiss);
      return;
    }
    if (sectionRef) {
      trapTabKey(event, sectionRef);
    }
  }
</script>

<section
  bind:this={sectionRef}
  class="panel-view"
  aria-label={heading}
  onkeydowncapture={handleKeydown}
>
  <div class="panel-card">
    {#key dialogId}
      <Form bind:this={formRef} {dialogId} {config} />
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
