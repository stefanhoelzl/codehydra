#!/usr/bin/env bash
# Prints one `workspace.create` item per open, non-draft PR not authored by the gh user, but only
# when that user owns the repository `origin` points at. Runs at the root of the default branch's
# checkout. The agent's prompt is prompt.md with its {{placeholders}} filled in, wakeup.sh
# embedded verbatim: the workspace checks out the PR's head, which need not contain this folder.
# A failing gh call (offline, rate limit) exits 75, a temporary failure.
# Needs only gh: its --jq filters do the shaping (no standalone jq, which Git for Windows lacks),
# reading their inputs from the environment ($ENV) since gh --jq takes no --arg.
set -euo pipefail

here="${CH_PLUGIN_DIR:-$(dirname "$0")}"

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 75
owner=$(gh repo view --json owner --jq .owner.login) || exit 75
me=$(gh api user --jq .login) || exit 75

if [ "$me" != "$owner" ]; then
  echo '[]'
  exit 0
fi

ME="$me" REPO="$repo" PROMPT="$(cat "$here/prompt.md")" WAKEUP="$(cat "$here/wakeup.sh")" \
  gh pr list --repo "$repo" --state open --limit 200 \
  --json number,title,url,headRefName,isDraft,author --jq '
  def fill($vars): reduce ($vars | to_entries[]) as $v (.; gsub("[{][{]" + $v.key + "[}][}]"; $v.value));
  $ENV.ME as $me | $ENV.REPO as $repo
  | [ .[]
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
        prompt: ($ENV.PROMPT | fill({
          number: ($pr.number | tostring),
          title: $pr.title,
          url: $pr.url,
          author: $pr.author.login,
          repo: $repo,
          me: $me,
          workspace: $name,
          wakeup: $ENV.WAKEUP
        }))
      }
  ]' || exit 75
