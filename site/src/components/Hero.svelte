<script>
  const base = import.meta.env.BASE_URL;
</script>

<section class="hero">
  <div class="container hero-content">
    <img src="{base}logo.png" alt="CodeHydra Logo" width="128" height="128" class="hero-logo" />
    <h1 class="hero-title">
      Multi-Workspace IDE for<br />
      Parallel AI Agent Development
    </h1>
    <p class="hero-description">
      Run multiple AI coding assistants simultaneously in isolated git worktrees with real-time
      status monitoring.
    </p>
    <div class="hero-actions">
      <a href="#quickstart" class="btn btn-primary">Get Started</a>
      <a
        href="https://github.com/stefanhoelzl/codehydra"
        target="_blank"
        rel="noopener noreferrer"
        class="btn btn-secondary"
      >
        View on GitHub
      </a>
    </div>
  </div>
</section>

<style>
  .hero {
    padding: 6rem 0;
    text-align: center;
    background: linear-gradient(180deg, var(--site-bg-secondary) 0%, var(--site-bg-primary) 100%);
  }

  .hero-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .hero-logo {
    display: block;
  }

  .hero-title {
    font-size: 2rem;
    font-weight: 700;
    margin: 0;
    line-height: 1.2;
    background: linear-gradient(135deg, var(--site-gradient-start), var(--site-gradient-end));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .hero-description {
    font-size: 1.1rem;
    color: var(--site-text-secondary);
    max-width: 600px;
    margin: 0;
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
    margin-top: 1rem;
  }

  @media (min-width: 640px) {
    .hero-title {
      font-size: 2.5rem;
    }

    .hero-description {
      font-size: 1.25rem;
    }
  }

  @media (min-width: 1024px) {
    .hero-title {
      font-size: 3rem;
    }
  }
</style>
