<script lang="ts">
  let copiedCommand: string | null = $state(null);

  async function copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      copiedCommand = command;
      setTimeout(() => {
        copiedCommand = null;
      }, 2000);
    } catch {
      // Clipboard API not available or permission denied
    }
  }
</script>

<section id="quickstart" class="quickstart" tabindex="-1">
  <div class="container">
    <h2>Get Started</h2>

    <div class="commands">
      <div class="command">
        <code>npx codehydra</code>
        <button
          class="copy-btn"
          onclick={() => copyCommand("npx codehydra")}
          aria-label="Copy npx command"
        >
          {#if copiedCommand === "npx codehydra"}
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
              />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
              />
              <path
                d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
              />
            </svg>
          {/if}
        </button>
      </div>
      <div class="command">
        <code>uvx codehydra</code>
        <button
          class="copy-btn"
          onclick={() => copyCommand("uvx codehydra")}
          aria-label="Copy uvx command"
        >
          {#if copiedCommand === "uvx codehydra"}
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
              />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
              />
              <path
                d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
              />
            </svg>
          {/if}
        </button>
      </div>
    </div>

    <p class="download-note">
      Or download from
      <a href="https://github.com/stefanhoelzl/codehydra/releases">GitHub Releases</a>
    </p>
  </div>
</section>

<style>
  .quickstart {
    background: var(--site-bg-primary);
  }

  .quickstart:focus {
    outline: none;
  }

  .quickstart h2 {
    text-align: center;
    font-size: 1.25rem;
    margin: 0 0 0.75rem 0;
    background: linear-gradient(135deg, var(--site-gradient-start), var(--site-gradient-end));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .commands {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-width: 280px;
    margin: 0 auto;
  }

  .command {
    display: flex;
    align-items: center;
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
  }

  .command code {
    flex: 1;
    font-size: 0.9rem;
    color: var(--site-text-primary);
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--site-text-secondary);
    transition:
      color 0.2s,
      background-color 0.2s;
  }

  .copy-btn:hover {
    background: var(--site-bg-secondary);
    color: var(--site-text-primary);
  }

  .copy-btn:focus-visible {
    outline: 2px solid var(--site-focus);
    outline-offset: 2px;
  }

  .copy-btn svg {
    width: 16px;
    height: 16px;
  }

  .download-note {
    text-align: center;
    margin-top: 0.5rem;
    color: var(--site-text-secondary);
    font-size: 0.8rem;
  }

  .download-note a {
    color: var(--site-gradient-start);
    text-decoration: none;
  }

  .download-note a:hover {
    text-decoration: underline;
  }
</style>
