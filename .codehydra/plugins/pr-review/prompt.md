Review pull request #{{number}} "{{title}}" by {{author}} with me: {{url}}

This workspace (`{{workspace}}`) exists only for this review. Work through the steps below in order. Never write to GitHub (labels, title, review, merge) except where a step says to, and only after I have answered.

## 1. Check out the PR

The worktree starts on `main`. Replace it with the PR's head (the PR may come from a fork):

```sh
git fetch origin pull/{{number}}/head && git reset --hard FETCH_HEAD
```

Note the head SHA (`git rev-parse HEAD`); you need it later.

## 2. Read the PR

Read the description, the diff against `main` (`git diff origin/main...HEAD`), the conversation and the CI status (`gh pr view {{number}} --repo {{repo}} --comments`, `gh pr checks {{number}} --repo {{repo}}`). Read the code around the changes too, and the repo's AGENTS.md files and docs that apply to it.

## 3. Summarize it

Post a summary of about one screen:

- what the PR does for users
- how it does it: the main files and modules it touches
- its size (files, lines added/removed, commits)
- CI status
- whether it follows the AGENTS.md rules and updates `docs/USER_GUIDE.md` where users can see the change

## 4. Label and title

Before any decision, ask me two questions with your ask-user tool (AskUserQuestion in Claude Code), each with your recommendation first:

1. **Label**: `enhancement` (user-facing feature), `bug` (user-facing fix) or `internal` (no user-facing change). The label puts the PR in the release notes' Features or Bug Fixes section, or leaves it out.
2. **Title**: keep it, or rename it. Judge the current title against `.ship/pr-title.md` and offer your proposed titles as options.

Apply my answers right away: `gh pr edit {{number}} --repo {{repo}} --add-label <label>` (remove a different one of those three labels if it has one) and `--title "<title>"`.

## 5. Decisions, one at a time

List the PR's decisions, numbered. A decision is a choice a reviewer could reasonably have made differently: behavior, API or contract, architecture, naming, tests. Any break of an AGENTS.md rule is one too. Skip trivia.

Then take them one at a time with the ask-user tool and wait for my answer before the next. For each one, give:

- what was chosen, where (`file:line`)
- the alternatives
- your assessment
- your recommended verdict, as the first option: **agree**, **question** (something to ask the author) or **push back** (something to change)

When my answer is a question or a push-back, note what I want said to the author.

## 6. Draft the review

Once every decision is answered, draft one GitHub review:

- an inline comment for each question and push-back, on the line it is about, in my voice, short and friendly
- a short overall body
- the verdict: **request changes** if anything was pushed back; **approve** if I agreed with everything; with only questions, ask me whether to approve or just comment (a comment-only review waits for the author like 7a)

Show me the whole draft and ask me to post, edit or drop it. Post it only after I confirm, as one review through the API (`gh api repos/{{repo}}/pulls/{{number}}/reviews` with `commit_id`, `event`, `body` and `comments[]`).

## 7a. Requested changes (or commented): hibernate until the author reacts

Hibernate this workspace with the wakeup script below. Pass its text unchanged as `--wakeup`, and its variables with `--env`: `REPO={{repo}}`, `PR={{number}}`, `SHA=<the head SHA you reviewed>`, `SINCE=<the review's submitted_at, from the API response>`, `AUTHOR={{author}}`.

```sh
{{wakeup}}
```

It wakes the workspace with a message when the PR is closed or merged, gets new commits, or the author replies. When you are woken:

- **closed or merged**: tell me, and leave the workspace for me to delete
- **new commits or a reply**: fetch the new head (step 1's commands), then go through what changed since the review the same way as step 5: my earlier push-backs and questions first (resolved or not), then any new decisions. Continue with step 6.

## 7b. Approved: merge it

1. Take the ship lock, which queues this merge behind my own `/ship` runs: `ch lock take ship --scope project --reason "merge PR #{{number}}"`. Run it as a background call; it can wait a long time.
2. If the branch is behind `main`, update it: `gh pr update-branch {{number}} --repo {{repo}} --rebase`.
3. `gh pr merge {{number}} --repo {{repo}} --rebase --auto`.
4. Wait in a background call until the PR is merged, or auto-merge stops (CI fails, conflict):
   `while sleep 30; do s=$(gh pr view {{number}} --repo {{repo}} --json state,autoMergeRequest --jq '.state + " " + (.autoMergeRequest != null | tostring)') || continue; [ "$s" = "OPEN true" ] || break; done; echo "$s"`
5. Release the lock: `ch lock release ship`.
6. **Merged**: check that `gh pr view {{number}} --repo {{repo}} --json state` says `MERGED`, then delete this workspace with `ch ws delete --ignore-warnings`. A rebase merge gives `main` new commit ids, so the local branch looks unmerged; with the PR merged that warning is wrong.
7. **Anything fails** (CI red, conflict, the branch cannot be updated because the fork does not allow maintainer edits): release the lock, cancel auto-merge (`gh pr merge {{number}} --repo {{repo}} --disable-auto`), tell me what failed, and wait for me.
