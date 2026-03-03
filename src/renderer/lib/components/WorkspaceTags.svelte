<script lang="ts">
  import { extractTags } from "@shared/api/types";

  interface WorkspaceTagsProps {
    metadata: Readonly<Record<string, string>>;
  }

  let { metadata }: WorkspaceTagsProps = $props();

  const tags = $derived(extractTags(metadata));
</script>

{#if tags.length > 0}
  <div class="workspace-tags" aria-label="Tags">
    {#each tags as tag (tag.name)}
      <span class="tag-pill" style:--tag-color={tag.color ?? null}>
        {tag.name}
      </span>
    {/each}
  </div>
{/if}

<style>
  .workspace-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 8px 2px;
  }

  .tag-pill {
    --_color: var(--tag-color, var(--ch-foreground));
    display: inline-block;
    font-size: 10px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 8px;
    border: 1px solid var(--_color);
    background: color-mix(in srgb, var(--_color) 50%, transparent);
    color: var(--ch-foreground);
    white-space: nowrap;
    font-weight: 500;
  }
</style>
