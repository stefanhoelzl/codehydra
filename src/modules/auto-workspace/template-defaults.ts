/**
 * Reference text shown beside the `auto-workspace.sources` editor in settings.
 *
 * Sources are user-defined, so the reference is source-agnostic: it documents
 * the document shape and the template keys, then shows the migrated github /
 * youtrack sources as copyable starting points. The `template` values render as
 * Liquid over whatever JSON each source's `cmd` emits.
 */

const FORMAT = `Format — a multi-document YAML stream, one document per source
(separated by "---"):

  name       source name (also the state-key prefix); must be unique
  type       cron (default; the only supported type)
  cmd        shell command line, run via sh -c / cmd /c. Must print a
             top-level JSON array of objects to stdout. Inherits the
             app environment; inline any secrets (kept out of bug reports).
  template   mapping rendered once per emitted object — every string leaf
             is a Liquid template over that object's JSON:
    name                 workspace name (required)
    key                  dedup identity (defaults to the rendered name)
    base                 branch to fork the new worktree from
    tracking             remote branch to check out with upstream set
    focus                true = switch to the workspace once created
    project              local project path  (or use git)
    git                  git URL to clone as the project
    agent: { type, name, permission-mode, model: { provider, id } }
    metadata: { title, tags: { <name>: { color } }, <key>: <value> }
    prompt               agent prompt (empty = no prompt)`;

const GITHUB_EXAMPLE = `name: github
type: cron
cmd: |
  gh api graphql -f q='is:open is:pr review-requested:@me' \\
    -f query='query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{number title url body headRefName baseRefName author{login} repository{url}}}}}' \\
    --jq '[.data.search.nodes[]|{number,title,html_url:.url,body,user:{login:.author.login},head:{ref:.headRefName},base:{ref:.baseRefName},clone_url:(.repository.url+".git")}]'
template:
  name: "{{ title }}"
  key: "{{ html_url }}"
  base: "{{ base.ref }}"
  project: "{{ clone_url }}"
  prompt: |
    Review pull request #{{ number }} "{{ title }}" opened by {{ user.login }}.

    {{ body }}

    PR: {{ html_url }}`;

const YOUTRACK_EXAMPLE = `name: youtrack
type: cron
cmd: |
  curl -s -G -H "Authorization: Bearer perm:XXXX" \\
    --data-urlencode "query=for:me State: {In Progress}" \\
    --data-urlencode "fields=id,idReadable,summary,description,project(name)" \\
    "https://youtrack.example.com/api/issues"
template:
  name: "{{ summary }}"
  key: "https://youtrack.example.com/api/issues/{{ id }}"
  prompt: |
    Work on {{ idReadable }} "{{ summary }}" in {{ project.name }}.

    {{ description }}`;

export const SOURCES_HELP = `${FORMAT}\n\nExample — github:\n${GITHUB_EXAMPLE}\n\nExample — youtrack:\n${YOUTRACK_EXAMPLE}`;
