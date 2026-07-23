/**
 * Reference text shown beside the `auto-workspace.sources` editor in settings.
 *
 * Sources are user-defined, so the reference is source-agnostic: it documents
 * the document shape, the template fields (with required/default), how Liquid
 * renders over the cmd's JSON, and how metadata/tags map — then shows the
 * github source as a copyable starting point. The `template` values render as
 * Liquid over whatever JSON each source's `cmd` emits.
 */

const FORMAT = `=== FORMAT ===

A multi-document YAML stream — one document per source, separated by
"---":

  name       source name (also the state-key prefix); must be unique
  type       cron (default; the only supported type)
  cmd        shell command line, run by the platform shell (sh on POSIX,
             cmd.exe on Windows). Must print a top-level JSON array of
             objects to stdout. Inherits the app environment; inline any
             secrets (kept out of bug reports).
             The syntax is the platform shell's own — the example below
             is POSIX. On Windows use cmd.exe syntax: "..." rather than
             '...' for quoting, and ^ rather than \\ to continue a line.
  template   mapping rendered once per emitted object into one workspace
             (see FIELDS)`;

const FIELDS = `=== FIELDS (keys under template) ===

  Key          Required  Default         Meaning
  name         yes       —               workspace name (also the git branch)
  key          no        rendered name   dedup identity across polls
  base         no        —               branch to fork the new worktree from
  tracking     no        —               remote branch to track (upstream set)
  project      no        —               local project path (or use git)
  git          no        —               git URL to clone as the project
  focus        no        false           true = switch to it once created
  prompt       no        "" (no prompt)  agent prompt
  agent        no        —               agent config (see below)
  metadata     no        —               title / tags / extra keys (see METADATA)

agent: { type, name, permission-mode, model: { provider, id } }
  type             claude | opencode (required to set any other agent field)
  name             named agent / subagent
  permission-mode  claude only; ignored for opencode
  model            { provider, id } — both required together`;

const LIQUID = `=== LIQUID ===

Every string leaf in template is a Liquid template. The render context
IS the JSON object your cmd emitted for that item — there is no fixed
variable list; whatever keys the object has are what you can reference.

  {{ title }}                  a top-level field
  {{ user.login }}             nested field (dot access)
  {{ title | truncate: 60 }}   liquidjs filters work
  {% if draft %}…{% endif %}   tags work too

A referenced field the object doesn't have renders empty.`;

const METADATA = `=== METADATA ===

  metadata:
    title: "{{ summary }}"           sidebar display title
    tags:
      review: { color: "#4b6de8" }   a colored tag named "review"
    <any-key>: "<any value>"         passed through as-is

- title sets the sidebar display title; when unset the row falls back
  to the branch name (template.name).
- each tags.<name> becomes a workspace tag; its { color } object is
  JSON-encoded for the tag system. Omit color for an uncolored tag.

Three different "names", easy to confuse:
  name (document)          the source id — unique, prefixes its state keys
  template.name            the workspace name and git branch
  template.metadata.title  the sidebar display title (falls back to branch)`;

const GITHUB_EXAMPLE = `=== EXAMPLE — github ===

name: github
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
  metadata:
    title: "PR #{{ number }}: {{ title }}"
    tags:
      review: { color: "#4b6de8" }
  prompt: |
    Review pull request #{{ number }} "{{ title }}" opened by {{ user.login }}.

    {{ body }}

    PR: {{ html_url }}`;

export const SOURCES_HELP = `${FORMAT}\n\n${FIELDS}\n\n${LIQUID}\n\n${METADATA}\n\n${GITHUB_EXAMPLE}`;
