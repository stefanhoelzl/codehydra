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
        <p>Run multiple AI agents simultaneously, each in its own isolated workspace</p>
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
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </span>
          Real-time Status
        </h3>
        <p>Monitor agent status (idle/busy/waiting) with visual indicators and app badge</p>
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
        <p>Full code-server integration with extensions, themes, and settings</p>
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
          Multi-Agent Support
        </h3>
        <p>Built-in OpenCode and Claude Code integration with real-time status monitoring</p>
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
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          </span>
          MCP Server
        </h3>
        <p>Model Context Protocol server exposes workspace API to AI agents</p>
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
                d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 0 1 .276-.837l1.61-1.61a2.404 2.404 0 0 1 1.705-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"
              />
            </svg>
          </span>
          IDE Integration
        </h3>
        <p>VS Code extension API for commands, workspace control, and automation</p>
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
        <p>Shortcut mode for lightning-fast workspace navigation</p>
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
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </span>
          Voice Dictation
        </h3>
        <p>Speech-to-text extension for dictating prompts to AI agents</p>
      </div>
    </div>
    <div class="platform-row">
      <span class="platform-badge">
        <img src="{base}linux.svg" alt="" class="platform-icon" aria-hidden="true" />
        Linux
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
