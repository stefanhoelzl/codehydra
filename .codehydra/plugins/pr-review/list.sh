#!/usr/bin/env bash
# Prints one `workspace.create` item per open, non-draft PR not authored by the gh user, but only
# when that user owns the repository `origin` points at. Runs at the root of the default branch's
# checkout. The agent's prompt is prompt.md with its {{placeholders}} filled in, wakeup.sh
# embedded verbatim: the workspace checks out the PR's head, which need not contain this folder.
# A failing gh call (offline, rate limit) exits 75, a temporary failure.
set -euo pipefail

here="${CH_PLUGIN_DIR:-$(dirname "$0")}"

repo_json=$(gh repo view --json nameWithOwner,owner) || exit 75
me=$(gh api user --jq .login) || exit 75
owner=$(jq -r .owner.login <<<"$repo_json")
repo=$(jq -r .nameWithOwner <<<"$repo_json")

if [ "$me" != "$owner" ]; then
  echo '[]'
  exit 0
fi

prs=$(gh pr list --repo "$repo" --state open --limit 200 \
  --json number,title,url,headRefName,isDraft,author) || exit 75

jq --arg me "$me" --arg repo "$repo" \
  --rawfile prompt "$here/prompt.md" --rawfile wakeup "$here/wakeup.sh" '
  def fill($vars): reduce ($vars | to_entries[]) as $v (.; gsub("\\{\\{" + $v.key + "\\}\\}"; $v.value));
  [ .[]
    | select(.isDraft | not)
    | select(.author.login != $me)
    | . as $pr
    | ("pr/\(.number)/" + (.headRefName | gsub("[^A-Za-z0-9._/-]"; "-"))) as $name
    | ($name | .[0:100] | sub("[./-]+$"; "")) as $name
    | {
        action: "workspace.create",
        name: $name,
        key: .url,
        metadata: {
          title: "PR #\(.number): \(.title)",
          tags: { review: { color: "#d29922", description: "Pull request review" } }
        },
        prompt: ($prompt | fill({
          number: ($pr.number | tostring),
          title: $pr.title,
          url: $pr.url,
          author: $pr.author.login,
          repo: $repo,
          me: $me,
          workspace: $name,
          wakeup: $wakeup
        }))
      }
  ]' <<<"$prs"
