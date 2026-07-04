<!--
  DialogView.svelte

  Modal surface for the declarative dialog framework.
  Renders the chrome — faded logo backdrop + centered card — and delegates the
  sections + actions to <Form>, which owns the keyboard contract (Escape ->
  click the cancel-role button, else no-op on this modal surface;
  Cmd/Ctrl+Enter -> primary, Tab trap). One DialogView is rendered per active
  dialog by DialogHost.
-->
<script lang="ts">
  import type { DialogConfig } from "@shared/dialog-types";
  import Logo from "./Logo.svelte";
  import Form from "./form/Form.svelte";

  interface Props {
    dialogId: string;
    config: DialogConfig;
  }

  const { dialogId, config }: Props = $props();

  /** Derive heading text from sections for aria-label. */
  const heading = $derived.by(() => {
    const headingSection = config.sections.find((s) => s.type === "text" && s.style === "heading");
    return headingSection?.type === "text" ? headingSection.content : "Dialog";
  });

  /**
   * A form-layout dialog with a trailing button-only group (the settings dialog)
   * hands its own scrolling body + pinned footer, so the card drops its padding
   * and clips instead of scrolling as a whole.
   */
  const scrollLayout = $derived.by(() => {
    if (config.layout !== "form") return false;
    const last = config.sections[config.sections.length - 1];
    return last?.type === "group" && last.items.every((i) => i.type === "button");
  });
</script>

<div class="dialog-view" role="dialog" aria-label={heading}>
  <div class="backdrop" aria-hidden="true">
    <Logo />
  </div>
  <div class="card" class:scroll-layout={scrollLayout}>
    <Form {dialogId} {config} />
  </div>
</div>

<style>
  /* Full-window modal: a translucent scrim over the whole viewport (the sidebar
     stays visible, dimmed behind it) with the card centered. Pointer-capturing,
     so it blocks interaction beneath (true modal). z-index sits above the
     expanded sidebar (--ch-z-sidebar-expanded: 950) so it is not painted under
     it. Mirrors the canonical modal chrome in Dialog.svelte. */
  .dialog-view {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ch-overlay-bg);
    backdrop-filter: var(--ch-overlay-blur, blur(8px));
    z-index: 1000;
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
    /* Cap tall dialogs (e.g. the settings form) at 80% of the viewport and
       scroll inside; short dialogs stay their natural height. The card is
       centered vertically by .dialog-view. */
    max-height: 80%;
    overflow-y: auto;
    padding: 2rem;
    text-align: center;
    background: color-mix(in srgb, var(--ch-surface-1, var(--ch-background)) 90%, transparent);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-lg, 14px);
    box-shadow: var(--ch-shadow);
  }

  /* Scroll-layout (settings): the Form owns a scrolling body + pinned footer,
     so the card is a flush flex column that clips rather than scrolls itself.
     Wider than the default card — it holds denser [label] [control] [reset]
     rows. */
  .card.scroll-layout {
    max-width: 750px;
    padding: 0;
    overflow: hidden;
    text-align: left;
    display: flex;
    flex-direction: column;
  }
</style>
