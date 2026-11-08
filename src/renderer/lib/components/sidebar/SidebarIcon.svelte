<!--
  SidebarIcon.svelte

  The sidebar's own line icons (16x16, stroked in the current color). The
  sidebar keeps its own icon set instead of codicons so that it looks the
  same in every VS Code theme.
-->
<script lang="ts" module>
  export type SidebarIconName =
    | "search"
    | "plus"
    | "gear"
    | "help"
    | "docked"
    | "undocked"
    | "speaker"
    | "speaker-muted"
    | "trash"
    | "warn"
    | "branch"
    | "chev"
    | "moon"
    | "alarm"
    | "cloud"
    | "info"
    | "xcircle"
    | "close"
    | "refresh"
    | "pulse"
    | "cpu"
    | "memory"
    | "processes"
    | "level-total"
    | "level-breakdown"
    | "level-tree";
</script>

<script lang="ts">
  interface Props {
    name: SidebarIconName;
    /** Extra classes (the caller's scoped CSS sizes and colors the icon). */
    class?: string;
    size?: number;
  }

  const { name, class: className = "", size }: Props = $props();
</script>

<svg
  class="sb-icon {className}"
  viewBox="0 0 16 16"
  aria-hidden="true"
  style:width={size === undefined ? null : `${size}px`}
  style:height={size === undefined ? null : `${size}px`}
>
  {#if name === "search"}
    <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" />
  {:else if name === "plus"}
    <path d="M8 3v10M3 8h10" />
  {:else if name === "gear"}
    <path d="M2.5 5h11M2.5 11h11" /><circle cx="6" cy="5" r="1.7" class="knob" /><circle
      cx="10.5"
      cy="11"
      r="1.7"
      class="knob"
    />
  {:else if name === "help"}
    <circle cx="8" cy="8" r="6" /><path
      d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.3M8 11.4v.1"
    />
  {:else if name === "docked"}
    <rect x="2" y="3" width="12" height="10" rx="2" /><path
      d="M2.6 3.6h3.4v8.8H2.6z"
      class="fill"
    /><path d="M6 3v10" />
  {:else if name === "undocked"}
    <rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" />
  {:else if name === "speaker"}
    <!-- A speaker cone with two sound waves: the idle chime plays. -->
    <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" /><path
      d="M10.5 6a2.5 2.5 0 0 1 0 4M12 4.2a5 5 0 0 1 0 7.6"
    />
  {:else if name === "speaker-muted"}
    <!-- The speaker cone with a cross: the idle chime is muted. -->
    <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" /><path d="M10.5 6.2l3.3 3.6M13.8 6.2l-3.3 3.6" />
  {:else if name === "trash"}
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  {:else if name === "warn"}
    <path d="M8 2.5 14 13.5H2z" /><path d="M8 7v3M8 12v.1" />
  {:else if name === "branch"}
    <circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle
      cx="11"
      cy="5.5"
      r="1.5"
    /><path d="M5 5.5v5M11 7c0 2.5-6 1.5-6 3.5" />
  {:else if name === "chev"}
    <path d="M6 4l4 4-4 4" />
  {:else if name === "moon"}
    <path d="M12.8 9.8A5.2 5.2 0 0 1 6.2 3.2a5.2 5.2 0 1 0 6.6 6.6z" />
  {:else if name === "alarm"}
    <circle cx="8" cy="8.8" r="5" /><path
      d="M8 6.3v2.6l1.7 1.1M2.4 4.2 4.4 2.4M13.6 4.2l-2-1.8M4.4 13.2l-1 1.2M11.6 13.2l1 1.2"
    />
  {:else if name === "cloud"}
    <path d="M4.6 12.5h6.9a3 3 0 0 0 .3-6 4 4 0 0 0-7.6.9 2.6 2.6 0 0 0 .4 5.1z" />
  {:else if name === "info"}
    <circle cx="8" cy="8" r="6" /><path d="M8 7.3v4M8 4.9v.1" />
  {:else if name === "xcircle"}
    <circle cx="8" cy="8" r="6" /><path d="M6 6l4 4M10 6l-4 4" />
  {:else if name === "close"}
    <path d="M4 4l8 8M12 4l-8 8" />
  {:else if name === "refresh"}
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  {:else if name === "pulse"}
    <path d="M1.5 8.5h3l1.8-4 3 8 1.9-4h3.3" />
  {:else if name === "cpu"}
    <rect x="4" y="4" width="8" height="8" rx="1.5" /><path
      d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"
    />
  {:else if name === "memory"}
    <rect x="1.5" y="4" width="13" height="6.5" rx="1" /><path
      d="M4 10.5v2M6.5 10.5v2M9.5 10.5v2M12 10.5v2M4.5 6.5v1.5M8 6.5v1.5M11.5 6.5v1.5"
    />
  {:else if name === "processes"}
    <path d="M8 2.5l5.5 3-5.5 3-5.5-3z" /><path d="M2.5 8.5l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3" />
  {:else if name === "level-total"}
    <!-- One bar: the single total row. -->
    <rect x="2" y="5.5" width="12" height="5" rx="1.5" />
  {:else if name === "level-breakdown"}
    <!-- Three bars of different lengths over a sum line: the breakdown rows. -->
    <path d="M2.5 3.5h7M2.5 6.5h11M2.5 9.5h5" /><path d="M2.5 13h11" />
  {:else if name === "level-tree"}
    <!-- A root with nested children: the process tree. -->
    <path d="M3 3h4M4.5 3v9.5h3M4.5 8h3M9.5 8h4M9.5 12.5h4" />
  {/if}
</svg>

<style>
  .sb-icon {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .knob {
    fill: var(--ch-sb-shell);
  }

  .fill {
    fill: currentColor;
    stroke: none;
  }
</style>
