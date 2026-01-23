<script>
  const base = import.meta.env.BASE_URL;
</script>

<section class="screenshot">
  <div class="container">
    <img
      src="{base}screenshot.png"
      alt="CodeHydra showing multiple workspaces with AI agents running in parallel"
      class="screenshot-img"
    />
  </div>
</section>

<style>
  .screenshot {
    background: var(--site-bg-secondary);
  }

  .screenshot-img {
    display: block;
    width: 100%;
    max-width: 1000px;
    margin: 0 auto;
    border-radius: 8px;
    border: 1px solid var(--site-border);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  }
</style>
