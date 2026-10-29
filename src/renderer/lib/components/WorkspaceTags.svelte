<!--
  WorkspaceTags.svelte

  A workspace's tags as the sidebar shows them on a row's second line: each in
  its label (else its name), a pill in its color when it has one, and its
  description on hover. Shared by the sidebar rows and the workspace search.
-->
<script lang="ts">
  import type { WorkspaceTag } from "@shared/api/types";

  interface Props {
    tags: readonly WorkspaceTag[];
  }

  const { tags }: Props = $props();
</script>

{#each tags as tag (tag.name)}
  {@const shown = tag.label ?? tag.name}
  {@const tip = tag.description ?? tag.name}
  <span
    class="ws-tag"
    class:colored={tag.color !== undefined}
    style:--tag-color={tag.color ?? null}
    title={tip === shown ? undefined : tip}>{shown}</span
  >
{/each}

<style>
  /* Inline tag on the row's second line (branch + tags scroll together).
     Bare by default so a label that is just an emoji wears no chrome; the branch
     beside it is dimmed to 0.6, and that contrast is what separates them. */
  .ws-tag {
    display: inline-block;
    font-size: 10px;
    line-height: 1;
    color: var(--ch-foreground);
    white-space: nowrap;
    font-weight: 500;
  }

  /* A color is what makes a tag a pill. */
  .ws-tag.colored {
    --_color: var(--tag-color, var(--ch-foreground));
    padding: 2px 6px;
    border-radius: 8px;
    border: 1px solid var(--_color);
    background: color-mix(in srgb, var(--_color) 50%, transparent);
  }
</style>
