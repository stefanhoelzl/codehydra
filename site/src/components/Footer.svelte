<script>
  const base = import.meta.env.BASE_URL;
</script>

<footer class="footer">
  <div class="container footer-content">
    <span class="footer-text">MIT License</span>
    <span class="footer-separator">·</span>
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
</footer>

<style>
  .footer {
    background: var(--site-bg-secondary);
    border-top: 1px solid var(--site-border);
    padding: 2rem 0;
  }

  .footer-content {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.75rem;
  }

  .footer-text {
    color: var(--site-text-secondary);
  }

  .footer-separator {
    color: var(--site-border);
  }

  .footer a {
    color: var(--site-text-secondary);
  }

  .footer a:hover {
    color: var(--site-text-primary);
  }

  .github-link {
    display: flex;
    align-items: center;
  }

  .github-link:hover {
    opacity: 0.8;
  }

  .github-icon {
    width: 20px;
    height: 20px;
    filter: invert(1);
  }
</style>
