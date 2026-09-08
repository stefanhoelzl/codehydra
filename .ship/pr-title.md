# PR title policy

A `feat:` / `fix:` PR title in this repo is **not** an internal label. It is published verbatim to
users.

`.github/workflows/release.yaml` creates the nightly release with `gh release create
--generate-notes`, and `.github/release.yml` sorts PRs into categories by the same labels `/ship`
applies — `enhancement` → **Features**, `bug` → **Bug Fixes**, `internal` excluded. Every merged
user-facing PR therefore appears in the release body, and that body reaches users through the
auto-updater.

## The rendering

This is the line the audience reads. Show it in each option's `preview`:

```
### Features
* feat: Desktop notifications when an agent needs you by @stefanhoelzl in https://github.com/stefanhoelzl/codehydra/pull/123
```

The category already comes from the label, so `feat:` / `fix:` is redundant in the rendered line.
Ship's prefix is fixed and this file cannot drop it — which is precisely why what follows the prefix
must read as a clean sentence on its own.

## Rules

1. **Name an observable outcome**, not a mechanism: what a user can now do, or what they no longer
   experience. If the title only makes sense to someone who knows the code, it is the wrong title.
2. **No internal vocabulary.** Module and component names, `ide-server`, `wrapper`, `boundary`,
   `intent`, `hook`, `module`, `dispatcher`, `mechanism` — none of it means anything to a reader of
   the release notes. Ship's PR **body** is where all of it belongs.
3. **No developer framing.** `flaky`, `refactor`, `regression`, `race`, `edge case` describe the
   engineering, not the experience.
4. **Describe the new behaviour, not the old bug.** "X no longer happens" is fine; "X was broken" is
   a bug report, and by the time anyone reads the release notes it is not true any more.
5. **Sentence case after the prefix**, no trailing period.
6. **No issue or PR numbers, no scope parentheses.** The rendered line already carries the link.

If you cannot derive the user-visible outcome from the diff, do not invent one — ask, as ship's own
step 6.2 says. "I could not tell" and "there is no user-visible outcome" are different answers, and
the second one means the PR is `internal`.

## Worked examples, from this repo

Titles that read well in the release notes:

| Title                                                               | Why                                     |
| ------------------------------------------------------------------- | --------------------------------------- |
| `fix: Waking a workspace no longer reloads it immediately`          | says exactly what the user stops seeing |
| `fix: Dialogs no longer lose focus to surfaces opening behind them` | observable, no internals                |
| `feat: Desktop notifications when an agent needs you`               | a capability, in the user's words       |
| `feat: Show number of hibernated workspaces per project`            | concrete and visible                    |

Titles that went out and should not be copied:

| Title                                                                       | What went wrong                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `fix: allows to terminate orphan ide-servers instead of quitting codehydra` | `ide-server` is internal vocabulary, and it describes the mechanism |
| `feat: general mechanism for auto-workspaces`                               | "mechanism" is not an outcome — nothing here says what a user gets  |
| `feat: wrapper for background tasks to keep workspace idle`                 | names the implementation instead of the effect                      |
| `fix: workspace branch cleanup was flaky`                                   | states the old behaviour, in developer vocabulary                   |
| `feat: inject system prompt to teach agents how to use CodeHydra`           | "inject system prompt" is internal                                  |
