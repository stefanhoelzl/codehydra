<section class="screenshot">
  <div class="container">
    <div class="screenshot-placeholder">
      <span class="screenshot-icon">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      </span>
      <p>Screenshots coming soon</p>
    </div>
  </div>
</section>

<style>
  .screenshot {
    background: var(--site-bg-secondary);
  }

  .screenshot-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 4rem 2rem;
    background: var(--site-bg-card);
    border: 2px dashed var(--site-border);
    border-radius: 12px;
    text-align: center;
  }

  .screenshot-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--site-text-secondary);
  }

  .screenshot-icon svg {
    width: 48px;
    height: 48px;
  }

  .screenshot-placeholder p {
    margin: 0;
    color: var(--site-text-secondary);
    font-size: 1.1rem;
  }
</style>
