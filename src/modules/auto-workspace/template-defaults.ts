/**
 * Default Liquid templates seeded into a newly-created auto-workspace template
 * file (via the settings file picker's "create" flow). Keyed by source name.
 *
 * Each is a minimal, valid starting point: front-matter (name/tracking) plus a
 * prompt body, using the fields each source exposes on its poll item's `data`
 * (see github-source.ts / youtrack-source.ts). Users are expected to refine
 * these — they are scaffolding, not a finished workflow.
 */

/** GitHub PR data exposes number, title, html_url, user.login, body, head.ref, base.ref, clone_url. */
const GITHUB_TEMPLATE = `---
name: {{ title }}
tracking: {{ html_url }}
---
Review pull request #{{ number }} "{{ title }}" opened by {{ user.login }}.

{{ body }}

PR: {{ html_url }}
`;

/** YouTrack issue data exposes idReadable, summary, description, project.name, reporter.fullName. */
const YOUTRACK_TEMPLATE = `---
name: {{ summary }}
tracking: {{ idReadable }}
---
Work on {{ idReadable }} "{{ summary }}" in {{ project.name }}.

{{ description }}
`;

export const TEMPLATE_DEFAULTS: Readonly<Record<string, string>> = {
  github: GITHUB_TEMPLATE,
  youtrack: YOUTRACK_TEMPLATE,
};
