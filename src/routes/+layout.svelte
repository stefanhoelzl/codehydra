<script lang="ts">
  import '@vscode-elements/elements/dist/bundled.js';
</script>

<slot />

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(
      --vscode-font-family,
      -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      Roboto,
      sans-serif
    );
  }

  :global(#svelte) {
    width: 100%;
    height: 100%;
  }
</style>
