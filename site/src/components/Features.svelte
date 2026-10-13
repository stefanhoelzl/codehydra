<script>
  const base = import.meta.env.BASE_URL;
</script>

<section class="features">
  <div class="container">
    <div class="feature-grid">
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
          </span>
          Parallel Workspaces
        </h3>
        <p>One task, one git worktree, one agent — as many side by side as you like</p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </span>
          Git Worktrees
        </h3>
        <p>Each workspace is a git worktree — lightweight, isolated, shares history</p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </span>
          MCP and CLI Support
        </h3>
        <p>
          Agents and scripts create, switch and delete workspaces through MCP, the ch CLI or the VS
          Code extension API
        </p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <rect x="3" y="3" width="8" height="8" rx="2" />
              <path d="M7 11v4a2 2 0 0 0 2 2h4" />
              <rect x="13" y="13" width="8" height="8" rx="2" />
            </svg>
          </span>
          Plugins &amp; Automations
        </h3>
        <p>
          Scripts turn pull requests — or anything a script can list — into workspaces, and hook
          into every workspace's life
        </p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              <path d="M19 3v4" />
              <path d="M21 5h-4" />
            </svg>
          </span>
          Hibernate &amp; Wake
        </h3>
        <p>
          Park a workspace to free its editor and agent; a wakeup script wakes it when CI passes
        </p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </span>
          Real-time Status
        </h3>
        <p>A green dot when an agent is done, so you don't have to watch it — plus an app badge</p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <path
                d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
              />
              <path d="M20 3v4" />
              <path d="M22 5h-4" />
              <path d="M4 17v2" />
              <path d="M5 18H3" />
            </svg>
          </span>
          Claude Code &amp; OpenCode
        </h3>
        <p>Both built in; pick one per workspace</p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </span>
          VS Code Powered
        </h3>
        <p>Full VSCodium integration with extensions, themes, and settings</p>
      </div>
      <div class="feature-card">
        <h3>
          <span class="feature-icon">
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
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.001" />
              <path d="M10 8h.001" />
              <path d="M14 8h.001" />
              <path d="M18 8h.001" />
              <path d="M8 12h.001" />
              <path d="M12 12h.001" />
              <path d="M16 12h.001" />
              <path d="M7 16h10" />
            </svg>
          </span>
          Keyboard Driven
        </h3>
        <p>Alt+X shortcut mode for lightning-fast workspace navigation</p>
      </div>
    </div>
    <div class="platform-row">
      <span class="platform-badge">
        <img src="{base}linux.svg" alt="" class="platform-icon" aria-hidden="true" />
        Linux
      </span>
      <span class="platform-badge">
        <img src="{base}macos.svg" alt="" class="platform-icon" aria-hidden="true" />
        macOS
      </span>
      <span class="platform-badge">
        <img src="{base}windows.svg" alt="" class="platform-icon" aria-hidden="true" />
        Windows
      </span>
    </div>
  </div>
</section>

<style>
  .features {
    background: var(--site-bg-primary);
  }

  .feature-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }

  .feature-icon svg {
    width: 24px;
    height: 24px;
  }

  .platform-row {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid var(--site-border);
  }

  .platform-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--site-text-secondary);
    font-size: 1rem;
  }

  .platform-icon {
    width: 24px;
    height: 24px;
    filter: invert(1);
  }
</style>
