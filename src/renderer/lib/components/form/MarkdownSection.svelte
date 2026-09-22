<!--
  MarkdownSection.svelte

  Markdown section leaf: renders a markdown document (the user guide in the
  help dialog), rendered in safe mode: raw HTML other than <kbd> is escaped
  and images are dropped (see renderMarkdown). Links are
  handled here rather than by navigation: an `#anchor` scrolls to its heading
  inside the section, an http(s) link goes through window.open, which the UI
  view's window-open handler sends to the OS browser, and anything else (a
  relative link meant for the site) does nothing.
-->
<script lang="ts">
  import { renderMarkdown } from "@shared/markdown";
  import type { MarkdownSectionConfig } from "./types";

  interface Props {
    section: MarkdownSectionConfig;
  }

  const { section }: Props = $props();

  const html = $derived(renderMarkdown(section.content, { safe: true }));

  let container: HTMLDivElement | undefined = $state();

  // Written through the DOM rather than {@html}: the markdown is rendered in
  // safe mode above, and the click listener is delegated here too, since a
  // link reached by keyboard fires the same click.
  $effect(() => {
    const el = container;
    if (!el) return;
    el.innerHTML = html;
    const onClick = (event: MouseEvent): void => handleClick(el, event);
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  });

  function handleClick(el: HTMLElement, event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest("a");
    if (!link || !el.contains(link)) return;
    event.preventDefault();

    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const target = el.querySelector(`#${CSS.escape(href.slice(1))}`);
      target?.scrollIntoView({ block: "start" });
    } else if (/^https?:\/\//i.test(href)) {
      window.open(href, "_blank");
    }
  }
</script>

<div class="markdown-section" bind:this={container}></div>

<style>
  .markdown-section {
    text-align: left;
    line-height: 1.55;
    font-size: 13px;
    user-select: text;
  }

  .markdown-section :global(h1) {
    margin: 0 0 0.75rem;
    font-size: 1.5rem;
    font-weight: 500;
  }

  .markdown-section :global(h2) {
    margin: 1.75rem 0 0.5rem;
    padding-bottom: 0.25rem;
    font-size: 1.2rem;
    font-weight: 600;
    border-bottom: 1px solid var(--ch-border);
  }

  .markdown-section :global(h3) {
    margin: 1.25rem 0 0.4rem;
    font-size: 1rem;
    font-weight: 600;
  }

  .markdown-section :global(h4) {
    margin: 1rem 0 0.3rem;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .markdown-section :global(p),
  .markdown-section :global(ul),
  .markdown-section :global(ol),
  .markdown-section :global(table),
  .markdown-section :global(pre),
  .markdown-section :global(blockquote) {
    margin: 0 0 0.75rem;
  }

  .markdown-section :global(a) {
    color: var(--vscode-textLink-foreground, #3794ff);
    text-decoration: none;
  }

  .markdown-section :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-section :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    padding: 0.1em 0.3em;
    border-radius: var(--ch-radius-sm, 4px);
    background: var(--ch-input-bg);
  }

  .markdown-section :global(pre) {
    padding: 0.6rem 0.8rem;
    overflow-x: auto;
    border-radius: var(--ch-radius-md, 6px);
    background: var(--ch-input-bg);
  }

  .markdown-section :global(pre code) {
    padding: 0;
    background: none;
  }

  .markdown-section :global(kbd) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    padding: 0.05em 0.4em;
    border: 1px solid var(--ch-border);
    border-bottom-width: 2px;
    border-radius: var(--ch-radius-sm, 4px);
  }

  .markdown-section :global(table) {
    border-collapse: collapse;
  }

  .markdown-section :global(th),
  .markdown-section :global(td) {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--ch-border);
    text-align: left;
    vertical-align: top;
  }

  .markdown-section :global(blockquote) {
    padding-left: 0.8rem;
    border-left: 3px solid var(--ch-border);
    opacity: 0.85;
  }
</style>
