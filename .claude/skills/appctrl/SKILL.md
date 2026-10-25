---
name: appctrl
description: Launch, drive and screenshot this worktree's running CodeHydra app through Playwright (`pnpm -s appctrl`). Use for UI debugging, for verifying a UI change in the real app, or to read the app's renderer console and logs.
---

# AppCtrl: drive the running app

`pnpm -s appctrl <command>` (`scripts/appctrl.ts`) launches and drives this worktree's app. `start` spawns a background daemon that owns the app and exits with it; every other command talks to it over HTTP on `127.0.0.1`. One app per worktree.

**Before a first session, run `pnpm -s appctrl guide`** (views, selectors, shadow DOM, the sidebar, recipes). `--help` lists commands, `<command> --help` their flags.

Everything lands in `./app-data`: `logs/`, `screenshots/`, `appctrl-console.jsonl`, `appctrl-daemon.log`.

## Commands

| Command                                            | Does                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `start [--headed] [--packaged <exe>] [-- <flag>…]` | Launch (headless by default; needs `pnpm build`), return once the UI is up |
| `stop` / `status`                                  | Quit through the app's shutdown path / is one running                      |
| `screenshot [-t <view>]`                           | Write a PNG to `./app-data/screenshots/`, print the path: then Read it     |
| `dom [selector]`                                   | Accessibility tree as YAML: find selectors here first                      |
| `click <sel>` / `key <combo>`                      | Trusted input (`key Control+Shift+p`)                                      |
| `type <text> [--selector <sel>]`                   | Type into the focused element (or fill a selector)                         |
| `wait-for <sel> [--state <s>] [--timeout <ms>]`    | Wait until visible (or `attached`/`detached`/`hidden`); default 10000 ms   |
| `eval <code \| ->`                                 | Evaluate an expression (`-` = stdin), result as JSON                       |
| `expand-sidebar`                                   | Open the sidebar and wait until it is clickable                            |
| `dialog <path>…`                                   | Make the folder picker return these paths                                  |
| `resume`                                           | Emit powerMonitor `resume` (the `app:resume` path)                         |
| `targets`                                          | List the UI page and workspace iframes as JSON                             |
| `console [--level <l>] [--clear]`                  | Renderer console since `start` (last 500); works after the app is gone     |
| `logs [--scope <s>] [--level <l>] [--limit <n>]`   | App log, newest first; needs no running app                                |

- Views (`--target`/`-t` on `screenshot`, `dom`, `click`, `type`, `key`, `eval`, `wait-for`): `workspace` (default, the visible VSCodium iframe), `ui` (the whole window), or a URL substring.
- App flags go after `--` (e.g. `-- --agent=opencode`); `log.level` and `log.format` are managed by appctrl, and every launch gets `--silent=true --notification=disabled`.
- After a code change: `stop`, `pnpm build`, `start`.

## Must-know

- `@vscode-elements` components have shadow DOM: CSS selectors cannot reach inside. Use `role=button[name="Create"]` / `text=Create` selectors from `dom`; type into a focused field rather than `type --selector`.
- The sidebar is 20px and clipped until hovered, and headless has no cursor: `expand-sidebar` before clicking anything in it.
- In workspace views use `key` / `type`; synthetic `KeyboardEvent`s and `acquireVsCodeApi` do not work there.
- `eval` takes an expression: wrap statements in an IIFE, never a bare `return`.
- **Never open the user's real projects**: create a temp git repo and `dialog` it before clicking Open Project.
