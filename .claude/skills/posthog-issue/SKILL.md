---
name: posthog-issue
description: Fetch a CodeHydra PostHog error-tracking issue and decode what each report carries — the app log (gzip+base64 in the `logs` property, not encrypted), the redacted config and state.json overrides, version/platform/crash source — into files, then read them. Use when given a PostHog issue id or `/error_tracking/<id>` URL, when a user's crash or bug report needs looking into, or when asked to "look at the PostHog issue" or decode its logs.
---

# PostHog issue

CodeHydra sends every crash and every manual bug report to PostHog error tracking as a
`$exception` event (`src/modules/error-report-module.ts`). This skill gets those events into
files you can grep. For impact and triage across issues (users affected, trends, replays) use
the PostHog plugin's `investigating-error-issue` / `triaging-error-issues` skills; they know
nothing about the payload below.

Say the issue UUID plainly in the conversation. `.ship/post-merge.md` resolves it once the fix
merges, and only if the id is in the session.

## What a report carries

| Property                 | Meaning                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `logs`                   | The app log, **gzip then base64** (`logs_format: "gzip+base64"`). Not encrypted. Up to ~900 KB of base64          |
| `logs_raw_bytes`         | Size of the log text that was kept                                                                                |
| `logs_raw_bytes_dropped` | Bytes cut from the **start** of the log to fit PostHog's 1 MB event cap; > 0 means the oldest lines are missing   |
| `config`                 | Config overrides only (keys that differ from defaults), secrets `<redacted>`                                      |
| `state`                  | `state.json` overrides, same redaction                                                                            |
| `crash_source`, `phase`  | `startup` + the failing app:start phase, or a UI-renderer source; absent for main-process crashes and bug reports |
| `$exception_types`       | Error class; `BugReport` for a manual report, whose message is the user's description (often not in English)      |
| common                   | `version`, `platform`, `arch`, `agent`, `isDevelopment` on every event                                            |

## 1. Find the issue id

It is the UUID in the issue URL (`…/error_tracking/<issue-id>`) or the `issue_id` from a
PostHog tool result. Need its title or status? `call query-error-tracking-issue` through
`mcp__plugin_posthog_posthog__exec`.

## 2. Query the events — this exact SQL

Replace `<issue-id>`; widen `INTERVAL` if the issue is older, raise `LIMIT` if you need more
reports (each can be ~1 MB). Keep the column list and order: `decode.py` checks it. Free-form
JSON is base64-encoded in SQL because PostHog returns rows as one `|`-separated table string.

```
mcp__plugin_posthog_posthog__exec
  command: call --json execute-sql {"query": "SELECT uuid, timestamp, properties.$exception_types AS types, base64Encode(toString(properties.$exception_values)) AS values_b64, properties.version AS version, properties.platform AS platform, properties.arch AS arch, properties.agent AS agent, properties.isDevelopment AS is_development, properties.crash_source AS crash_source, properties.phase AS phase, properties.logs_format AS logs_format, properties.logs_raw_bytes AS logs_raw_bytes, properties.logs_raw_bytes_dropped AS logs_raw_bytes_dropped, base64Encode(toString(properties.config)) AS config_b64, base64Encode(toString(properties.state)) AS state_b64, properties.logs AS logs FROM events WHERE event = '$exception' AND properties.$exception_issue_id = '<issue-id>' AND timestamp > now() - INTERVAL 90 DAY ORDER BY timestamp DESC LIMIT 5"}
```

Use `--json`. An empty result means no event in that window carries that id: widen the window,
or list the issue's events with `call query-error-tracking-issue-events` and swap the `WHERE`
for `uuid IN ('<event-uuid>', …)`.

## 3. Decode

Run from the repo root, with the session scratchpad as the output directory.

**Large result** — Claude Code answers `Output has been saved to <path>` and suggests reading
it in 80,000-char slices. Do not: the slices are base64 and useless to read. Pass the path:

```bash
uv run --script .claude/skills/posthog-issue/decode.py <scratchpad>/posthog <path>
```

**Small result** (it came back inline) — paste the whole JSON result into a quoted heredoc:

```bash
uv run --script .claude/skills/posthog-issue/decode.py <scratchpad>/posthog - <<'EOF'
{"query": …, "results": "uuid|timestamp|…"}
EOF
```

Never decode by hand (`base64 -d` alone gives gzip bytes; a truncated copy fails gunzip). It
prints one line per event and writes `<out>/<event-uuid>/`:

- `logs.log` — the decoded log (partial first line already dropped when the head was trimmed)
- `config.json`, `state.json` — pretty-printed overrides
- `meta.json` — the other columns, plus `messages` (the exception messages / bug description)

An error from `decode.py` names what is wrong (columns changed, truncated input, unknown
format); fix the query or input rather than working around it.

## 4. Read

Text log lines (`log.format` defaults to `text`; `src/boundaries/platform/electron-log.ts`):

```
[2026-10-13 22:17:29.590] [warn]   (dispatcher)      hook error op=app-start hook=start error=…
 timestamp (local time)    level    logger           message key=value…
```

- **Level**: `log.level` defaults to `warn`, so most user logs hold only warnings and errors.
  Check `config.json` — `"log.level": "debug"` means a full trace. Filter with
  `grep -nE '\] \[(warn|error)\]' logs.log`.
- **Logger** names are the `LoggerName` union in `src/boundaries/platform/logging-types.ts`.
- **Dispatcher** lines carry `[<6-hex id> <intent> <source>]`; grep the id to follow one
  intent through its hooks.
- The log is the rotated `.old.log` followed by the current log, so it can span several app
  runs; they show up as gaps in the timestamps (at the default `warn` level there is no
  reliable "started" line).
- The crash itself is usually near the end; for a bug report, the user's description in
  `meta.json` says what to look for, and its timestamp says when they gave up.
- Paths, project names and workspace names in logs and state are the user's; quote only what
  the diagnosis needs.
