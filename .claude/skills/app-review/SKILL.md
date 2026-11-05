---
name: app-review
description: Open this worktree's CodeHydra app in a real window, set up so the user can review the current change by hand, and hand over a short list of what to check. Use when the user asks to review, try or see the current change in the app, or runs `/app-review`. For the agent verifying a UI change itself, use `appctrl` instead.
---

# App review: prepare the app, then hand it over

The user reviews; you prepare. Read the change, get the app to the state that shows it, open a headed window on that state, say what to check, and end your turn.

Commands run from the worktree root. Driving the app uses skill `appctrl`: read it, and run `pnpm -s appctrl guide` if this is your first session.

## 1. Read the change

The change is everything since the branch left `origin/main`, plus uncommitted edits, which is what `pnpm build` puts in the app:

```bash
git diff "$(git merge-base origin/main HEAD)"
git status --short   # untracked files are not in the diff
```

Decide whether the running app can show it:

- **Only docs, tests or CI**: say there is nothing to review in the app and stop. Do not build, and leave any running app alone.
- **Only through `ch` or the logs**: continue; the checklist lists the commands to try and what to look for.
- **Otherwise**: continue, and work out which screen, dialog or flow the change reaches.

## 2. Stop and build

Stop a running app without asking, then build, on every run:

```bash
pnpm -s appctrl status   # if running: pnpm -s appctrl stop
pnpm -s build
```

## 3. Restore, or prepare

`app-data/snapshot/` holds the last preparation of this worktree:

| Path              | Holds                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `files/`          | `app-data` as preparation left it, seed repos included                                             |
| `prepared-for.md` | What it was prepared for: the change and surface, the seed, app flags, the last UI steps to replay |

Read `prepared-for.md`. Compare it with the change from step 1:

- **The seed still reaches the changed surface**: restore, then go to step 4. A later commit on the same feature usually fits; a change that moved to another surface does not.

  ```bash
  bash .claude/skills/app-review/snapshot.sh restore
  ```

- **It does not, or there is no snapshot**: clear, then prepare below.

  ```bash
  bash .claude/skills/app-review/snapshot.sh clear
  ```

Both overwrite whatever the worktree's `app-data` holds. Do not ask first. Everything in `app-data` counts as state except the short exclusion list in `snapshot.sh`; a new folder is saved and restored without a change there.

### Prepare

Skip first-run onboarding, then launch headless so no window gets in the user's way:

```bash
mkdir -p app-data/home app-data/seed
echo '{"agent":"claude"}' > app-data/home/config.json   # add config keys the change needs
R="$PWD/app-data/seed/sample"
git init -q "$R" && git -C "$R" -c user.name=review -c user.email=review@example.invalid commit -q --allow-empty -m init
pnpm -s appctrl start   # add `-- <flag>…` if the change needs app flags; record them
```

- **Seed only what the change needs.** One project and one workspace is the default. Seed repos go in `app-data/seed/`, never `/tmp`: the snapshot would miss them and their worktrees would break. Never open a real project.
- **Open a project**: `dialog "$R"`, `expand-sidebar`, `click -t ui 'role=button[name="Open project folder"]'`.
- **Create a workspace**: `click -t ui 'role=combobox[name="Enter name or select branch..."]'`, `type -t ui <name>`, `key -t ui Enter`. For another one, click `role=button[name="New workspace"]` first. Its agent terminal takes about 10 seconds to appear.
- **Claude's folder trust prompt** comes up in a new workspace, with **No, exit** preselected: a bare Enter ends the agent. Screenshot first, then `key ArrowDown`, `key Enter`. Only ever accept it for seed repos.
- **Prompt real agents** whenever it makes the state more realistic (`type`, then `key Enter`), without asking. They run on the user's real account with their real settings, including auto mode, and even a one-word prompt loads about 40k tokens of context: keep prompts short and inside the seed repo. Wait until they are idle before stopping.

When the state is right, check `logs --level warn` and `console --level error`, and put anything new in the handover. The `Unknown config key` warnings for `inspect`, `remote-debugging-port` and `no-sandbox` are expected.

Then stop and snapshot. The app must be stopped: the snapshot is only consistent then.

```bash
pnpm -s appctrl stop
bash .claude/skills/app-review/snapshot.sh save
```

Write `app-data/snapshot/prepared-for.md`: the change and surface it was prepared for, the seed, app flags, and the UI steps to replay.

## 4. Open the window

Headless is a startup flag, so a running app cannot switch: this is a second launch. Projects, workspaces and agent conversations carry over. Open dialogs and an expanded sidebar do not, so replay those steps now.

```bash
pnpm -s appctrl start --headed   # with the flags from prepared-for.md
```

Give it about 10 seconds to reopen the project, replay the last UI steps, and screenshot to confirm it shows what the checklist describes. If you used `expand-sidebar` only to reach something, collapse it again (recipe in `appctrl guide`).

## 5. Hand over

Tell the user:

- What is set up: the seed, and where the window is.
- A short list of what to check, each with the action and the expected result. Tie each one to the diff; do not pad it.
- Anything new from the logs, and anything this setup cannot show. Every appctrl launch has `--silent=true --notification=disabled`, so sounds and OS notifications can't be reviewed.

Then **end your turn**. Leave the app open: it runs until the user closes the window or the next run replaces it.

## 6. Findings

Findings come back in chat. You may read the live app (`logs`, `console`, `screenshot`) to understand one, but do not click around in the window the user is using. Change code only when asked. To see a fix, run this skill again.

The session's warnings and errors land in `app-data/logs/`, which the `/ship` Application log gate reads.
