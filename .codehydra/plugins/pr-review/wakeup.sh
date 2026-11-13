# Wakeup script of a PR review workspace hibernated after requesting changes.
# Env: REPO (owner/name), PR (number), SHA (head reviewed), SINCE (ISO time the review was
# posted), AUTHOR (the PR author's login). Wakes when the PR is closed or merged, its head moved,
# or its author commented or reviewed after SINCE; prints nothing otherwise.
set -euo pipefail
pr=$(gh pr view "$PR" --repo "$REPO" --json state,headRefOid,comments,reviews) || exit 75
jq -c --arg sha "$SHA" --arg since "$SINCE" --arg author "$AUTHOR" --arg n "$PR" '
  ([.comments[], .reviews[]]
    | map(select(.author.login == $author and ((.createdAt // .submittedAt) > $since)))
    | length) as $replies
  | if .state != "OPEN" then
      {action: "wake", message: "PR #\($n) is now \(.state | ascii_downcase)."}
    elif .headRefOid != $sha then
      {action: "wake", message: "PR #\($n) has new commits: head moved from \($sha) to \(.headRefOid)."}
    elif $replies > 0 then
      {action: "wake", message: "The author of PR #\($n) replied (\($replies) new comment(s) or review(s))."}
    else empty end' <<<"$pr"
