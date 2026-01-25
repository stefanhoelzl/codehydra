<script lang="ts">
  const base = import.meta.env.BASE_URL;
</script>

<article class="docs-content">
  <header class="docs-header">
    <h1>Getting Started</h1>
    <p class="docs-lead">Run multiple AI agents in parallel, each in its own isolated workspace.</p>
  </header>

  <nav class="docs-toc">
    <h2>Contents</h2>
    <ol>
      <li><a href="#why-codehydra">Why CodeHydra?</a></li>
      <li><a href="#quick-start">Quick Start</a></li>
      <li><a href="#core-concepts">Core Concepts</a></li>
      <li><a href="#using-codehydra">Using CodeHydra</a></li>
      <li><a href="#mcp-integration">Advanced: MCP Integration</a></li>
    </ol>
  </nav>

  <section id="why-codehydra">
    <h2>Why CodeHydra?</h2>
    <p>
      Ever had an AI agent make changes to files you were actively working on? Or waited for one
      task to finish before starting the next? CodeHydra solves these problems by giving each AI
      agent its own isolated workspace.
    </p>

    <img
      src="{base}screenshot.png"
      alt="CodeHydra showing multiple workspaces with AI agents running in parallel"
      class="screenshot"
    />

    <p>
      Imagine starting your morning by spinning up three workspaces: one for the sprint task, one
      for that refactoring you've been meaning to do, and one for the AI to investigate a flaky
      test. All running in parallel, none stepping on each other's toes.
    </p>
    <ul>
      <li>
        <strong>No more conflicts</strong> &mdash; Each agent works in its own git branch with its own
        files
      </li>
      <li><strong>No more waiting</strong> &mdash; Run multiple tasks simultaneously</li>
      <li><strong>No more context switching</strong> &mdash; Jump between workspaces instantly</li>
    </ul>
  </section>

  <section id="quick-start">
    <h2>Quick Start</h2>

    <h3>Installation</h3>
    <p>Run CodeHydra with npx or uvx:</p>
    <div class="code-block">
      <code>npx codehydra@latest</code>
    </div>
    <div class="code-block">
      <code>uvx --refresh codehydra</code>
    </div>
    <p>
      Or download from <a href="https://github.com/stefanhoelzl/codehydra/releases"
        >GitHub Releases</a
      >.
    </p>

    <p>
      On first launch, CodeHydra will guide you through opening a project and creating your first
      workspace. Want to run multiple agents? Just create more workspaces &mdash; each one gets its
      own worktree and agent session.
    </p>
  </section>

  <section id="core-concepts">
    <h2>Core Concepts</h2>

    <div class="concept-box">
      <h4>Project</h4>
      <p>
        A git repository opened in CodeHydra. Projects are containers that hold your workspaces.
      </p>
    </div>

    <div class="concept-box">
      <h4>Workspace</h4>
      <p>
        An isolated development environment with its own branch, files, and AI agent session.
        Workspaces are backed by git worktrees, so changes in one never affect another.
      </p>
    </div>

    <h3>Agent Status</h3>
    <p>The sidebar shows each workspace's agent status at a glance:</p>

    <div class="status-grid">
      <div class="status-item">
        <span class="status-indicator status-none"></span>
        <div>
          <strong>None</strong>
          <p>No agent active</p>
        </div>
      </div>
      <div class="status-item">
        <span class="status-indicator status-idle"></span>
        <div>
          <strong>Idle</strong>
          <p>Ready for input</p>
        </div>
      </div>
      <div class="status-item">
        <span class="status-indicator status-busy"></span>
        <div>
          <strong>Busy</strong>
          <p>Working on a task</p>
        </div>
      </div>
    </div>

    <p>
      You'll hear a sound when an agent finishes its task, so you can stay productive without
      constantly checking the screen.
    </p>
  </section>

  <section id="using-codehydra">
    <h2>Using CodeHydra</h2>

    <h3>Managing Workspaces</h3>
    <ul>
      <li>
        <strong>Create</strong> &mdash; Click <strong>+</strong> or press <kbd>Enter</kbd> in shortcut
        mode
      </li>
      <li>
        <strong>Switch</strong> &mdash; Click a workspace or use <kbd>1</kbd>-<kbd>0</kbd> to jump directly
      </li>
      <li>
        <strong>Delete</strong> &mdash; Hover and click the delete icon, or press <kbd>Delete</kbd>
      </li>
    </ul>

    <h3>Keyboard Shortcuts</h3>
    <p>
      Press <kbd>Alt</kbd>+<kbd>X</kbd> to enter shortcut mode, then:
    </p>

    <table class="shortcuts-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><kbd>↑</kbd> / <kbd>↓</kbd></td>
          <td>Navigate workspaces</td>
        </tr>
        <tr>
          <td><kbd>←</kbd> / <kbd>→</kbd></td>
          <td>Navigate idle workspaces</td>
        </tr>
        <tr>
          <td><kbd>1</kbd>-<kbd>9</kbd>, <kbd>0</kbd></td>
          <td>Jump to workspace 1-10</td>
        </tr>
        <tr>
          <td><kbd>Enter</kbd></td>
          <td>Create workspace</td>
        </tr>
        <tr>
          <td><kbd>Delete</kbd></td>
          <td>Remove workspace</td>
        </tr>
        <tr>
          <td><kbd>Escape</kbd></td>
          <td>Exit shortcut mode</td>
        </tr>
      </tbody>
    </table>
  </section>

  <section id="mcp-integration">
    <h2>Advanced: MCP Integration</h2>
    <p>
      CodeHydra exposes an MCP server that lets AI agents interact with workspaces programmatically.
      This enables powerful workflows where agents can:
    </p>
    <ul>
      <li>Query workspace info (name, branch, uncommitted changes)</li>
      <li>Create new workspaces and send them initial prompts</li>
      <li>Execute VS Code commands (save files, format code, navigate)</li>
      <li>Clean up by deleting workspaces when done</li>
    </ul>
    <p>
      You don't need to learn any special syntax. Just describe what you want in plain language:
    </p>
    <ul>
      <li>"What branch is this workspace on?"</li>
      <li>"Create a new workspace called 'feature-auth' from main"</li>
      <li>"Save all open files"</li>
    </ul>
  </section>
</article>

<style>
  .docs-content {
    max-width: 800px;
    margin: 0 auto;
  }

  .docs-header {
    margin-bottom: 0.5rem;
  }

  .docs-header h1 {
    font-size: 2rem;
    margin: 0 0 0.25rem 0;
    background: linear-gradient(135deg, var(--site-gradient-start), var(--site-gradient-end));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .docs-lead {
    font-size: 1.1rem;
    color: var(--site-text-secondary);
    margin: 0;
  }

  /* Table of contents */
  .docs-toc {
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 0.5rem;
  }

  .docs-toc h2 {
    font-size: 0.85rem;
    margin: 0 0 0.4rem 0;
    color: var(--site-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .docs-toc ol {
    margin: 0;
    padding-left: 1.25rem;
  }

  .docs-toc li {
    margin: 0.15rem 0;
  }

  /* Sections - override global padding, use top margins on headings instead */
  section {
    margin: 0;
    padding: 0;
  }

  h2 {
    font-size: 1.5rem;
    margin: 2rem 0 0 0;
  }

  h3 {
    font-size: 1.2rem;
    margin: 1.25rem 0 0.35rem 0;
  }

  h4 {
    font-size: 1rem;
    margin: 0.35rem 0 0.15rem 0;
  }

  p {
    margin: 0 0 0.35rem 0;
  }

  p:last-child {
    margin-bottom: 0;
  }

  ul,
  ol {
    margin: 0 0 0.35rem 0;
    padding-left: 1.25rem;
  }

  ul:last-child,
  ol:last-child {
    margin-bottom: 0;
  }

  li {
    margin: 0.15rem 0;
  }

  /* Screenshot */
  .screenshot {
    display: block;
    width: 100%;
    border-radius: 8px;
    border: 1px solid var(--site-border);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    margin: 1rem 0;
  }

  /* Code block */
  .code-block {
    background: var(--site-bg-code);
    border: 1px solid var(--site-border);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0;
    overflow-x: auto;
  }

  .code-block code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9rem;
    color: var(--site-text-primary);
  }

  /* Concept boxes */
  .concept-box {
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0.75rem 0;
  }

  .concept-box h4 {
    margin: 0 0 0.2rem 0;
    color: var(--site-gradient-start);
  }

  .concept-box p {
    margin: 0;
    color: var(--site-text-secondary);
    font-size: 0.9rem;
  }

  /* Status indicators */
  .status-grid {
    display: grid;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }

  .status-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 6px;
    padding: 0.5rem;
  }

  .status-indicator {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 4px;
  }

  .status-none {
    background: #6b7280;
  }

  .status-idle {
    background: #22c55e;
  }

  .status-busy {
    background: #ef4444;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .status-item strong {
    display: block;
    margin-bottom: 0.15rem;
  }

  .status-item p {
    margin: 0;
    color: var(--site-text-secondary);
    font-size: 0.9rem;
  }

  /* Keyboard styling */
  kbd {
    background: var(--site-bg-card);
    border: 1px solid var(--site-border);
    border-radius: 4px;
    padding: 0.15rem 0.4rem;
    font-family: inherit;
    font-size: 0.85rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.25rem 0 0 0;
    font-size: 0.9rem;
  }

  th,
  td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--site-border);
  }

  th {
    background: var(--site-bg-card);
    font-weight: 600;
  }

  td {
    background: var(--site-bg-secondary);
  }

  .shortcuts-table td:first-child {
    white-space: nowrap;
  }

  /* Responsive adjustments */
  @media (min-width: 640px) {
    .docs-header h1 {
      font-size: 3rem;
    }

    .status-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }
</style>
