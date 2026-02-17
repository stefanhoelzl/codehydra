<section class="abstract" aria-label="Why CodeHydra">
  <div class="container">
    <div class="comparison">
      <div class="card">
        <h2 class="card-header">Without CodeHydra</h2>
        <ul class="card-list">
          <li>Agents interfere with each other's changes</li>
          <li>Impossible to test each agent's work independently</li>
          <li>Can't review changes in isolation</li>
        </ul>
      </div>

      <div class="card card--with">
        <h2 class="card-header gradient-text">With CodeHydra</h2>
        <ul class="card-list">
          <li>Each agent gets its own fully isolated workspace</li>
          <li>Code, test, and present results independently</li>
          <li>Get notified when an agent needs attention</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<style>
  .abstract {
    padding: 4rem 0;
  }

  .comparison {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }

  .card {
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 12px;
    padding: 2rem;
  }

  .card-header {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--site-text-primary);
    margin: 0 0 1.25rem;
  }

  .gradient-text {
    background: linear-gradient(135deg, var(--site-gradient-start), var(--site-gradient-end));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .card-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .card-list li {
    color: var(--site-text-secondary);
    line-height: 1.5;
  }

  @media (min-width: 640px) {
    .comparison {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
