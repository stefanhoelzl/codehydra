/**
 * Example Liquid templates shown (read-only) in the settings help panel as a
 * copyable starting point. Keyed by source name.
 *
 * Each is a minimal, valid starting point: front-matter (name) plus a prompt
 * body, using the fields each source exposes on its poll item's `data` (see
 * github-source.ts / youtrack-source.ts). Users are expected to refine these —
 * they are scaffolding, not a finished workflow.
 */

/** GitHub PR data exposes number, title, html_url, user.login, body, head.ref, base.ref, clone_url. */
const GITHUB_TEMPLATE = `---
name: {{ title }}
---
Review pull request #{{ number }} "{{ title }}" opened by {{ user.login }}.

{{ body }}

PR: {{ html_url }}
`;

/** YouTrack issue data exposes idReadable, summary, description, project.name, reporter.fullName. */
const YOUTRACK_TEMPLATE = `---
name: {{ summary }}
---
Work on {{ idReadable }} "{{ summary }}" in {{ project.name }}.

{{ description }}
`;

/**
 * Front-matter keys a rendered template may set (shared across sources). The
 * body after the `---` front-matter block becomes the agent prompt.
 */
const OUTPUT_KEYS = `Output — front-matter keys the template may set (--- ... ---):
  name                    workspace name (required)
  base                    branch to fork the new worktree from
  tracking                remote branch to check out with upstream set
                          (e.g. origin/feature-x), instead of forking base
  focus                   true = switch to the workspace once it is created
  project                 local project path  (or use git)
  git                     git URL to clone as the project
  agent.type              backend arm (e.g. claude, opencode, default)
  agent.name              named launch config
  agent.permission-mode   agent permission mode
  agent.model.provider    model provider id
  agent.model.id          model id
  metadata.title          sidebar display title (defaults to branch name)
  metadata.tags.<name>    a colored tag, value e.g. {"color":"#e74c3c"}
  metadata.<key>          any other custom workspace metadata
The text after the front-matter becomes the agent prompt (empty = skip).`;

/** Per-source Liquid input variables available inside the template. */
const GITHUB_FIELDS = `Available fields (from the GitHub pull request):
  number        PR number
  title         PR title
  html_url      PR URL
  body          PR description
  user.login    author login
  head.ref      source branch
  base.ref      target branch
  clone_url     repository clone URL
  (the full GitHub PR JSON is available too — see
   https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)`;

const YOUTRACK_FIELDS = `Available fields (from the YouTrack issue):
  idReadable            human id (e.g. PROJ-123)
  summary               issue summary
  description           issue description
  reporter.login        reporter login
  reporter.fullName     reporter full name
  project.name          project name
  project.shortName     project short name
  created / updated / resolved
  customFields[]        .name and .value.name`;

function helpPanel(fields: string, example: string): string {
  return `${fields}\n\n${OUTPUT_KEYS}\n\nExample:\n${example}`;
}

/**
 * Reference text shown beside the inline template editor in settings: the input
 * fields a source exposes, the front-matter keys a template may set, and the
 * built-in default as a copyable example. Keyed by source name.
 */
export const TEMPLATE_HELP: Readonly<Record<string, string>> = {
  github: helpPanel(GITHUB_FIELDS, GITHUB_TEMPLATE),
  youtrack: helpPanel(YOUTRACK_FIELDS, YOUTRACK_TEMPLATE),
};
