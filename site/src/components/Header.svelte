<script>
  const base = import.meta.env.BASE_URL;
</script>

<nav class="header">
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <div class="container header-content">
    <a href={base} class="logo">
      <img src="{base}logo.png" alt="CodeHydra Logo" width="32" height="32" />
      <span>CodeHydra</span>
    </a>
    <div class="header-nav">
      <a href="{base}docs.html" class="nav-link">Docs</a>
      <a
        href="https://github.com/stefanhoelzl/codehydra"
        target="_blank"
        rel="noopener noreferrer"
        class="github-link"
        aria-label="View on GitHub"
      >
        <img src="{base}github.svg" alt="" class="github-icon" aria-hidden="true" />
      </a>
    </div>
  </div>
</nav>

<style>
  .header {
    position: sticky;
    top: 0;
    background: var(--site-bg-primary);
    border-bottom: 1px solid var(--site-border);
    z-index: 50;
  }

  .header-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 60px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--site-text-primary);
    font-weight: 600;
    font-size: 1.1rem;
  }

  .logo:hover {
    text-decoration: none;
  }

  .logo img {
    display: block;
  }

  .header-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .nav-link {
    color: var(--site-text-secondary);
    padding: 0.5rem 1rem;
    border-radius: 6px;
    transition: background-color 0.2s;
    font-weight: 500;
  }

  .nav-link:hover {
    background: var(--site-bg-card);
    text-decoration: none;
    color: var(--site-text-primary);
  }

  .github-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--site-text-secondary);
    padding: 0.5rem 1rem;
    border-radius: 6px;
    transition: background-color 0.2s;
  }

  .github-icon {
    width: 24px;
    height: 24px;
    filter: invert(1);
  }

  .github-link:hover {
    background: var(--site-bg-card);
    text-decoration: none;
    color: var(--site-text-primary);
  }
</style>
