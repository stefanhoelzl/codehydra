# Post-merge: resolve the PostHog issue

CodeHydra reports crashes to PostHog error tracking. When a session was spent fixing one of those
issues, the issue should be closed once the fix is actually on `main` — which is here.

## When this applies

Only when **this session** established which PostHog error-tracking issue the merged change fixes,
and its id (a UUID) is known from the conversation.

No PostHog issue in this session → do nothing, and report nothing. Do not go looking for a plausible
issue, and never guess an id.

## What to do

Set that issue's status to `resolved`, using whichever PostHog MCP tool this machine has:

- `mcp__posthog__update-issue-status` with the issue id and status `resolved`, or
- the PostHog plugin's single tool, `mcp__plugin_posthog_posthog__exec`, with the equivalent
  `error-tracking-issues` command.

Both names are granted in this repo's `.claude/settings.json`; ship itself grants neither.

## What to report

One line, either way:

```
PostHog: <issue-id> resolved
PostHog: <issue-id> not resolved (<what happened>)
```

## This step cannot fail the ship

The PR is already merged. A declined confirmation, an API error, an id that does not exist, an
unattended run with nobody there to approve the tool call — each is one honest line above and
nothing more. Do not retry, do not diagnose, and do not let any of it change the exit path or the
workspace-delete decision.
