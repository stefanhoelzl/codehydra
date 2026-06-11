<script lang="ts">
  interface IconProps {
    /** Codicon name (e.g., "check", "warning", "close") */
    name: string;
    /** Icon size in pixels (default 16, matches vscode-icon default) */
    size?: number;
    /** Enables rotation animation */
    spin?: boolean;
  }

  let { name, size = 16, spin = false }: IconProps = $props();
</script>

<vscode-icon {name} {size} {spin} aria-hidden="true"></vscode-icon>
