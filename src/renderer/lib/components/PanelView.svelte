<!--
  PanelView.svelte

  Renderer for the two non-blocking dialog kinds — "modeless" (creation ground
  state) and "panel" (deletion progress/failed) — with the sections + actions
  delegated to <Form>. Rendered by MainView; DialogHost handles blocking modals.

  Shell behaviour (renderer-owned; the backend owns the form session):
  - "modeless" (creation) is a centered floating card with NO backdrop — the
    layer is fully transparent and pointer-transparent, sitting ABOVE the
    sidebar (a popup on top of the UI), so the sidebar and content behind stay
    crisp and clickable. (No blur/dim: the sidebar is interactive, so dimming it
    would misleadingly read as disabled.)
  - "panel" (deletion) REPLACES the workspace view: an OPAQUE layer that masks
    the torn-down / reconnecting code-server frame behind it, sitting BELOW the
    sidebar so the sidebar (gutter or hover-expanded) renders on top and stays
    navigable. It is not dimming a live view — the view is gone; the opacity
    just keeps the empty/reconnecting frame from flickering through.
  - Blocking modals (z 1000) stack above both.
  - Keyboard (Escape, Cmd/Ctrl+Enter -> primary, Tab trap) is owned by Form.
  - When the last blocking modal stacked above closes, the panel re-places focus
    on the form's autofocus control (focus would otherwise be lost to <body>).
  - Form is keyed by dialogId: a backend close + reopen remounts it with fresh
    field values (the reset gesture).
-->
<script lang="ts">
  import type { DialogConfig, DialogKind } from "@shared/dialog-types";
  import Form from "./form/Form.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";

  interface Props {
    // dialogId/config are optional to survive the teardown flush: when the
    // owning dialog leaves the ui:state snapshot, MainView's `xDialog?.config`
    // getter yields `undefined` for the frame between the dialog disappearing
    // and this component being destroyed. Rendering nothing that frame beats
    // dereferencing undefined and throwing (which the crash guard would report).
    dialogId: string | undefined;
    config: DialogConfig | undefined;
    /** "modeless" (creation, above sidebar) or "panel" (deletion, below sidebar). */
    kind: Extract<DialogKind, "modeless" | "panel">;
    /** Whether a blocking modal is open above (drives refocus on close). */
    modalAbove: boolean;
  }

  const { dialogId, config, kind, modalAbove }: Props = $props();

  let formRef: Form | undefined = $state();

  /** Derive heading text from sections for the accessible name. */
  const heading = $derived.by(() => {
    const headingSection = config?.sections.find((s) => s.type === "text" && s.style === "heading");
    return headingSection?.type === "text" ? headingSection.content : "Panel";
  });

  // Refocus the form when the last modal above the panel closes (modals steal
  // focus while open; on close the panel is the active surface again).
  let hadModalAbove = false;
  $effect(() => {
    if (hadModalAbove && !modalAbove) formRef?.refocus();
    hadModalAbove = modalAbove;
  });
</script>

<section
  class="panel-view"
  class:above={kind === "modeless"}
  class:below={kind === "panel"}
  aria-label={heading}
>
  <div class="panel-card">
    {#if config && dialogId}
      <!-- Wall off the form: a render error in the panel's form degrades to a
           fallback instead of escaping to the crash guard. -->
      <ErrorBoundary label="panel:{kind}">
        {#key dialogId}
          <Form bind:this={formRef} {dialogId} {config} {kind} />
        {/key}
      </ErrorBoundary>
    {/if}
  </div>
</section>

<style>
  .panel-view {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* "modeless" (creation ground state): a popup on top, above the expanded
     sidebar (--ch-z-sidebar-expanded: 950), with NO backdrop and
     pointer-transparent so the sidebar/content behind stay crisp and clickable;
     only the card captures pointer events. */
  .panel-view.above {
    z-index: 960;
    pointer-events: none;
  }

  /* "panel" (deletion): replaces the workspace view. An OPAQUE layer painted
     above the frames (which carry no z-index) but BELOW the sidebar — z-index 0
     sits under the sidebar's collapsed gutter (--ch-z-sidebar-minimized: 1) and
     its expanded drawer (--ch-z-sidebar-expanded: 950), so the sidebar renders
     on top and stays navigable. Opaque + pointer-capturing so the torn-down /
     reconnecting frame behind neither flickers through nor takes clicks. */
  .panel-view.below {
    z-index: 0;
    background: var(--ch-background);
    pointer-events: auto;
  }

  .panel-card {
    pointer-events: auto;
    max-height: 85vh;
    overflow-y: auto;
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
