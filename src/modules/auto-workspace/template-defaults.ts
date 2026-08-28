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
  type       the trigger: cron (default; the only supported type)
  mode       what the cmd emits: workspaces (default) or events
             (see MODES)
  cmd        shell command line, run by the platform shell (sh on POSIX,
             cmd.exe on Windows). Must print a top-level JSON array of
             objects to stdout. Inherits the app environment; inline any
             secrets (kept out of bug reports).
             The syntax is the platform shell's own — the example below
             is POSIX. On Windows use cmd.exe syntax: "..." rather than
             '...' for quoting, and ^ rather than \\ to continue a line.
  template   mapping rendered once per emitted object into one workspace
             (see FIELDS)`;

const MODES = `=== MODES ===

Both modes poll on the same timer. What differs is what the cmd's
objects mean.

mode: workspaces (default) — the cmd emits the workspaces that SHOULD
exist, and each poll reconciles against that list:
  - an item not seen before creates a workspace
  - an item already handled is skipped (tracked by its key)
  - an item that disappears is forgotten, so if it comes back the
    workspace is created again
Nothing is ever auto-deleted; deleting a workspace by hand is final
while its item is still listed.

mode: events — the cmd emits things that HAPPENED, and each object
fires exactly once. Nothing is tracked, so the cmd must emit only what
it has not emitted before (mark it read, pop the queue, keep its own
cursor) — an object emitted twice fires twice. Per event, the project
is opened and template.name is matched against its workspaces:
  - no match       -> create it, exactly like workspaces mode
  - match          -> re-apply metadata, then wake it if hibernated,
                      or switch to it if focus: true
  - being deleted  -> skipped
An existing workspace gets NO prompt — a prompt only reaches an agent
when it launches. Use metadata (a tag, an updated title) to say what
happened. A failed event is logged and gone; there is no retry.`;

const FIELDS = `=== FIELDS (keys under template) ===

  Key          Required  Default         Meaning
  name         yes       —               workspace name (also the git branch)
  key          no        rendered name   dedup identity across polls
                                         (workspaces mode only; events
                                         mode matches on name)
  base         no        —               branch to fork the new worktree from
                                         (only when the item creates)
  tracking     no        —               remote branch to track (upstream set)
                                         (only when the item creates)
  project      no        —               local project path (or use git)
  git          no        —               git URL to clone as the project
  focus        no        false           true = switch to it once created
                                         (events mode: also on a match)
  prompt       no        "" (no prompt)  agent prompt (only when it creates)
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
      review: { color: "#4b6de8", label: "🔍" }
    <any-key>: "<any value>"         passed through as-is

- title sets the sidebar display title; when unset the row falls back
  to the branch name (template.name).
- each tags.<name> becomes a workspace tag; its object is JSON-encoded
  for the tag system. color, label and description are all optional:
    color        renders the tag as a pill; without one it is bare text
    label        shown instead of the name (any UTF-8, e.g. an emoji)
    description  hover text, shown instead of the name in the tooltip

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

const EVENTS_EXAMPLE = `=== EXAMPLE — events ===

Unread GitHub notifications. The second command is the ack: it marks
them read, so the same notification is never emitted twice.

name: gh-notify
type: cron
mode: events
cmd: |
  gh api /notifications \\
    --jq '[.[]|{reason,title:.subject.title,url:.subject.url,
           number:(.subject.url|split("/")|last),
           clone_url:(.repository.clone_url)}]'
  gh api -X PUT /notifications >/dev/null
template:
  name: "pr-{{ number }}"
  project: "{{ clone_url }}"
  metadata:
    title: "PR #{{ number }} — {{ reason }}"
    tags:
      nudge: { color: "#c47f2a" }
  prompt: |
    {{ reason }} on "{{ title }}".

    {{ url }}

The first notification about PR #42 creates the workspace with that
prompt. A later one finds it: the title and tag are refreshed, and it
is woken if it was hibernated.`;

export const SOURCES_HELP = `${FORMAT}\n\n${MODES}\n\n${FIELDS}\n\n${LIQUID}\n\n${METADATA}\n\n${GITHUB_EXAMPLE}\n\n${EVENTS_EXAMPLE}`;
