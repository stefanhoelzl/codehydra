---
name: appctrl
description: Launch, drive and screenshot this worktree's running CodeHydra app through Playwright (`pnpm -s appctrl`). Use for UI debugging, for verifying a UI change in the real app, or to read the app's renderer console and logs.
---

# AppCtrl: drive the running app

`pnpm -s appctrl <command>` (`scripts/appctrl.ts`) launches and drives this worktree's app. `start` spawns a background daemon that owns the app and exits with it; every other command talks to it over HTTP on `127.0.0.1`. One app per worktree.

**Before a first session, run `pnpm -s appctrl guide`** (views, selectors, shadow DOM, the sidebar, recipes). `--help` lists commands, `<command> --help` their flags.

Everything lands in `./app-data`: `logs/`, `screenshots/`, `appctrl-console.jsonl`, `appctrl-daemon.log`.

## Commands

| Command                                            | Does                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `start [--headed] [--packaged <exe>] [-- <flag>…]` | Launch (headless by default; needs `pnpm build`), return once the UI is up  |
| `start --snapshot <name>` / `start --fresh`        | Restore a snapshot / clear app-data, then launch                            |
| `stop [--snapshot <name>]` / `status`              | Quit through the app's shutdown path, then save a snapshot / is one running |
| `snapshot list\|show\|save\|restore\|delete`       | Manage snapshots of `./app-data` (save/restore need the app stopped)        |
| `screenshot [-t <view>]`                           | Write a PNG to `./app-data/screenshots/`, print the path: then Read it      |
| `dom [selector]`                                   | Accessibility tree as YAML: find selectors here first                       |
| `click <sel>` / `key <combo>`                      | Trusted input (`key Control+Shift+p`)                                       |
| `type <text> [--selector <sel>]`                   | Type into the focused element (or fill a selector)                          |
| `wait-for <sel> [--state <s>] [--timeout <ms>]`    | Wait until visible (or `attached`/`detached`/`hidden`); default 10000 ms    |
| `eval <code \| ->`                                 | Evaluate an expression (`-` = stdin), result as JSON                        |
| `expand-sidebar`                                   | Open the sidebar and wait until it is clickable                             |
| `dialog <path>…`                                   | Make the folder picker return these paths                                   |
| `resume`                                           | Emit powerMonitor `resume` (the `app:resume` path)                          |
| `targets`                                          | List the UI page and workspace iframes as JSON                              |
| `console [--level <l>] [--clear]`                  | Renderer console since `start` (last 500); works after the app is gone      |
| `logs [--scope <s>] [--level <l>] [--limit <n>]`   | App log, newest first; needs no running app                                 |

- Views (`--target`/`-t` on `screenshot`, `dom`, `click`, `type`, `key`, `eval`, `wait-for`): `workspace` (default, the visible VSCodium iframe), `ui` (the whole window), or a URL substring.
- App flags go after `--` (e.g. `-- --agent=opencode`); `log.level` and `log.format` are managed by appctrl, and every launch gets `--silent=true --notification=disabled`.
- After a code change: `stop`, `pnpm build`, `start`.

## Snapshots

Every clean exit (`stop`, or the app quit from its own UI) saves `./app-data` as a snapshot named by its time; a crash saves none. All are kept in `./app-data/snapshots/`.

- **Prepare once, iterate from it.** Get the app to the state the change needs, `stop --snapshot <name>`, then each iteration is `stop`, `pnpm build`, `start --snapshot <name>`. Skip the snapshot only for a one-off look.
- **Start from scratch** with `start --fresh -- --agent=claude`: config goes in as app flags, and a set agent skips onboarding.
- `snapshot show <name>` prints the metadata (HEAD, app flags, the snapshot it came from) and every appctrl command that built the state. app-review reads these to reuse a snapshot from development.

## Remote: on an ssh-runner (macOS, Windows)

For a macOS- or Windows-only bug, run the whole of appctrl on a runner from skill `ssh-runner` (profiles `macos` and `windows` in `.ssh-runner.yml`). The CLI, daemon and app all run there, and each command goes through `exec`: about 5 s per command.

```bash
R=~/.claude/skills/ssh-runner/ssh-runner.ts
ID=$(node $R start --profile macos | tail -1)            # or --profile windows
node $R sync $ID ./ :                                   # after every change
node $R exec $ID 'pnpm -s build && pnpm -s appctrl start --fresh -- --agent=claude'
node $R exec $ID 'pnpm -s appctrl dom -t ui'            # text output comes back as is
node $R exec $ID 'pnpm -s appctrl screenshot -t ui'     # prints a path on the runner…
node $R sync $ID :app-data/screenshots/ ./app-data/remote/<profile>/screenshots/   # …so pull, then Read
node $R stop $ID
```

- The runner's `app-data` is excluded from sync, so pushes keep it, but it is gone at `stop`. Prepare state and snapshots within one session.
- `start --fresh` wipes `app-data`: create the seed repo after it (`$PWD/app-data/seed/…` on the runner), never before. On Windows, pass it to `dialog` as `"$(cygpath -w "$S")"`.
- A fresh runner shows the first-run "Setting up CodeHydra" screen after `start`: `wait-for -t ui 'role=button[name="Open project folder"]'` before the first click.
- "Headless" is Linux-only. On macOS the app opens a real window on the runner's desktop, which is harmless and unseen; on Windows it runs in the ssh session, which has no desktop, and still renders and screenshots.
- The agent inside the app is logged out; its terminal stops at Claude's first-run screen. That is enough for UI bugs.

## Must-know

- `@vscode-elements` components have shadow DOM: CSS selectors cannot reach inside. Use `role=button[name="Create"]` / `text=Create` selectors from `dom`; type into a focused field rather than `type --selector`.
- The sidebar is a 56px rail until hovered, and headless has no cursor: `expand-sidebar` before clicking anything in it.
- In workspace views use `key` / `type`; synthetic `KeyboardEvent`s and `acquireVsCodeApi` do not work there.
- `eval` takes an expression: wrap statements in an IIFE, never a bare `return`.
- **Never open the user's real projects**: create a seed git repo in `./app-data/seed/` and `dialog` it before clicking Open Project. Never in `/tmp`: snapshots would miss it, and its worktrees would break.
