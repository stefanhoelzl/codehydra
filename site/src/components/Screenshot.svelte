<script>
  const base = import.meta.env.BASE_URL;
</script>

<section class="screenshot">
  <div class="container">
    <video autoplay loop muted playsinline class="screenshot-img" poster="{base}screenshot.png">
      <source
        src="https://github.com/user-attachments/assets/82b56a86-3dee-42a6-90d3-e2a002949f7a"
        type="video/mp4"
      />
      <img
        src="{base}screenshot.png"
        alt="CodeHydra showing multiple workspaces with AI agents running in parallel"
        class="screenshot-img"
      />
    </video>
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
