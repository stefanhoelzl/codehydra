# Configuration, Persisted State and Logging

Developer reference for config keys (`config.json` / env / CLI), app-written state (`state.json`) and the log. The user-facing view is docs/USER_GUIDE.md (Configuration); `ch config list` is the live reference for every user setting. To add or change a key, use the `config-key` skill (`.claude/skills/config-key/SKILL.md`).

## Configuration

### Sources and precedence

All settings use dot-separated, kebab-case keys. The same key works in three places:

| Source      | Format                                         | Example               |
| ----------- | ---------------------------------------------- | --------------------- |
| config.json | key as-is                                      | `"agent": "claude"`   |
| Env var     | `CH_` prefix, `.` → `__`, `-` → `_`, UPPERCASE | `CH_LOG__LEVEL=debug` |
| CLI flag    | `--` prefix                                    | `--log.level=debug`   |

Precedence (highest wins): CLI flag > env var > config.json > computed defaults > static defaults.

`config.json` lives in the **home root** (`PathProvider.homePath`: `~/.codehydra`, the same on every OS; dev `./app-data/home`; `<_CHDEV_ROOT_DIR>/home`), apart from the data root that holds what the app writes. `Config.load()` reads it synchronously before Electron `app.ready` (documented `node:fs` exception). On load, unknown keys are stripped from the file and a renamed key's value is moved to its new name; invalid JSON is moved aside to `config.json.broken` and defaults are used. An invalid value from any source fails startup with a `PersistedValidationError` naming the key, source and valid values.

**`@<path>` values (CLI only).** A CLI value of `@<path>` is read from that file (`--some.key=@./value.txt`); `@@` escapes a literal leading `@`; one trailing newline is stripped. This is the only way to give a key a multi-line value on the command line: Windows splits arguments on whitespace before our code runs, so an inline multi-line value arrives truncated and the app refuses to start. CLI-only by design — env vars and config.json carry newlines fine. Resolved in `Config.load()` by `resolveFileReferences`; an unreadable file is an `invalid` issue, i.e. the same startup error as any bad value, naming the path.

### Where keys are defined

- Each module registers its keys with `Config.register()` in its factory and keeps the returned typed `PersistedAccessor`; keys no single module owns (`agent`, `telemetry.enabled`, `help`, `version.claude`, `version.opencode`, `download-binaries`, `sidebar.width`) are registered in `src/main.ts` and their accessors threaded in.
- Service: `src/boundaries/platform/config.ts`. Key definitions (`PersistedKeyDefinition`) and the `store*` builders: `src/boundaries/platform/store-definition.ts`.
- A key's `settingsControl` (attached by the typed builders) puts it in the settings dialog; `applies: "live" | "restart"` (absent = restart) drives the dialog's "Restart to apply" note.
- `isUserSetting` (`config.ts`) — not deprecated, has a `settingsControl`, not `help`/`download-binaries` — decides which keys the settings dialog and `ch config` both expose.

### `ch config`

`ch config get|set|reset|list` (MCP `config_*`, API server `api:config:*`, entries in `src/api/entries/config.ts`) reads and writes the **running** app's config: the `isUserSetting` keys, through the settings dialog's write path, values as strings through each key's `parse()`. `redact` keys read as `<redacted>`; `omit` keys are `<omitted>` in `list` only.

### Deprecated and renamed keys

- `deprecated: true`: the key is recognized and its on-disk value loaded read-only — `get()` returns it, `set()` throws, `reset()` deletes it from the file. Hidden from help text, overrides and the settings dialog. A clean one-shot migration source: read, seed elsewhere, `reset()`.
- `legacyNames: { "<old.key>": (legacyValue) => newValue | undefined }`: `Config.load()` translates a config.json value under an old name, rewrites the file with it under the new key and drops the old entry (one way; downgrades not supported). Env vars and CLI flags accept old names as a pure rename through the new key's `parse()`. If both names are present the new one wins (`legacy-shadowed`). An old name can be removed one release later.

### Config keys

Owner = the file that calls `register()`.

#### `agent`

Default `claude` · `src/main.ts`. Agent selection: `claude` | `opencode`. Restart. Agent-selection onboarding runs while this key is set nowhere (source `default`: not in `config.json`, `CH_AGENT` or `--agent`), not on its value.

#### `sidebar.width`

Default `288` · `src/main.ts`. Expanded sidebar width in px, bounds 250–100000 (an out-of-range hand edit fails load; 250 so a width saved before the floor rose still loads). Every value is clamped up to the sidebar's floor of 288 (`clampSidebarWidthMin`: the 272 px card plus its 8 px margins). Written by dragging the sidebar's right edge (never below 288; the renderer caps the drag at 75% of the window width); also user-editable. Live.

#### `sidebar.mode`

Default `overlay` · `presentation-module.ts`. `overlay` (collapsed strip, expands over the workspace on hover) | `docked` (always expanded; the workspace frames/overlays start at its right edge via `--ch-workspace-left`). Written by the footer dock button (`set-sidebar-mode` ui:event) and Alt+X+D; docked emits no hover events and ignores `capturing`. Live.

#### `sidebar.process-summary`

Default `off` · `presentation/process-bar.ts`. `off` | `total` | `breakdown` | `tree`. Anything but `off` shows each sidebar row's CPU and memory (`UiWorkspaceRow.processes`; none on hibernated rows) and the process bar above the footer at that level: CodeHydra's total (`processTotals`), plus its split into workspaces, code server and CodeHydra (`breakdown`), or every process as a tree (`tree`, `processTree` — sent only at that level). While on, the process monitor (`process-monitor/process-monitor-module.ts`) scans every 3 s; off, it scans only for `ch ws processes`, hibernate/delete and the tree's kill button. Written by the footer pulse button and the bar's level buttons (`set-sidebar-process-summary` ui:event) and Alt+X+P; read at every snapshot build, which starts or stops the polling to match, so a change from the settings dialog or `ch config` applies on the next push. Was a boolean: `true`/`false` (config.json, env, CLI) still read as `total`/`off` until the next write. Live.

#### `silent`

Default `false` · `presentation-module.ts`. Silence the audible chime played when an agent goes idle. `appctrl` always launches the app with `--silent=true --notification=disabled` (`DRIVER_APP_ARGS`, `scripts/appctrl.ts`). Live.

#### `notification`

Default `first-workspace` · `os-notification-module.ts`. When to raise an OS notification for a workspace whose idle-agent count went up, **while the window does not have OS focus**: `disabled` = never; `each-workspace` = one per workspace; `first-workspace` = only when nothing was idle beforehand (the moment the fleet stops being uniformly busy; re-arms once everything is busy again). Agentless/hibernated workspaces (`none`) count for neither side. Clicking focuses the window and switches to that workspace. Independent of `silent`. Triggers like the chime (any idle-count increase, first report included), so a batch reporting in while unfocused — app start, project open, wake — can notify per workspace. Read on every transition (live). `appctrl` launches with `--notification=disabled` (with `--silent=true`; `DRIVER_APP_ARGS`, `scripts/appctrl.ts`).

#### `auto-tag.new`

Default `true` · `auto-tagging-module.ts`. Tag every newly created workspace (no `existingWorkspace` — so not wakes or startup re-discovery) with a blue `new` tag, cleared on first switch. A creation the user lands on loses it to that landing switch; what survives is one created and never visited. Gates tagging only: removal always runs, so turning it off never strands a tag. Live.

#### `update`

Default `notify` · `auto-updater-module.ts`. How updates are handled: `off` = never check; `notify` = a sidebar card asks before downloading; `auto` = a detected update downloads without asking (progress card, then "Update ready"); it installs on **Restart Now** or the next quit, never by itself. In `auto` a failed download is retried at the next check until its error card is dismissed; versions dismissed in `notify` still download. The card's **Always download** button sets `auto`. Read by every check (startup, every 4 hours, resume), so a change applies at the next one; a check that finds `off` closes an open "available"/"error" card. Replaces `update.notification` (`true` → `notify`, `false` → `off`; migrated in `config.json`). Live.

#### `plugins.enabled`

Default `true` · `plugin-module/module.ts`. Run plugins (hooks and automations). The global kill switch when a plugin is broken; an automations cycle it stops is skipped whole (nothing tracked is forgotten). Per-plugin state lives in `state.json` (`plugins.state`). Live.

#### `plugins.config`

Default `""` · `plugin-module/module.ts`. Where plugins come from and their settings' values: a YAML mapping edited as text (settings textarea, `ch config set`, `ch plugin add|remove`). Entry key → `{type: local|remote|project, …, config: {<plugin>: {<setting>: value}}}`; `default` = `~/.codehydra/plugins`. Validated by `parseSourcesConfig` (`sources.ts`) on set and load. `omit: true` (holds tokens). Live.

#### `paths.bash`

Default `null` · `scripts/scripts.ts`. bash for plugin and wakeup scripts on Windows (absolute path). `null` = Git Bash next to `git` on PATH, then the usual install roots (`shells.ts`); WSL's `System32\bash.exe` is never used. Ignored elsewhere (bash from PATH). Live.

#### `poll.interval`

Default `60` · `poll-module.ts`. Seconds between the **end** of one poll (`poll:tick`: automations, wakeup scripts) and the **start** of the next (a chained timer — a slow tick never stacks). Minimum 1. Re-read when each wait is armed.

#### `poll.timeout`

Default `30` · `poll-module.ts`. Seconds a poll script (automation, wakeup script) may run before it is killed; a job may set its own. Minimum 1.

#### `version.claude`

Default `null` · `src/main.ts`. `null` = the `claude` on PATH, else a download of the latest `stable`; set = that version (exact, or `latest`/`stable` re-resolved each start), downloaded and used even over a system install. Any string; a bad one fails on the setup screen.

#### `version.opencode`

Default `null` · `src/main.ts`. OpenCode 1.x or 2.x — both server APIs are spoken, the wire picked by the resolved major. `null` = the `opencode` on PATH whose `--version` reports a supported major (1 or 2), else a download of the latest release; set = that version (exact, or `latest`), downloaded and used even over a system install. A download of another major fails on the setup screen. 2.x downloads come from npm (`@opencode/cli-<os>-<arch>`), as 2.x GitHub releases ship no binaries; `latest` follows the GitHub `releases/latest` redirect, so it stays 1.x until upstream marks a 2.x release latest, then flips with it.

#### `version.vscodium`

Default `VSCODIUM_VERSION` (`ide-server-module/vscodium.ts`) · `ide-server-module.ts`. VSCodium version override.

#### `ide-server.port`

Default 25448 packaged, else derived from the git branch (30000–65000) · `ide-server-module.ts`. Embedded IDE server (VSCodium reh-web) port, 1024–65535.

#### `terminal.priority-boost`

Default `true` · `input-priority/input-priority-module.ts`. Windows only. Runs every process a keystroke in a workspace terminal passes through at above-normal priority: the UI renderer, the IDE server, its ptyHost, every ConPTY `OpenConsole`, the terminals' shells and the agent TUIs (`input-path.ts`). Under heavy load (agents running builds on every core) each of them otherwise waits behind that load on every key, and typing lags by seconds. What a shell or agent starts stays at normal priority (Windows does not pass a raised priority on). A process snapshot every 5 s (`ProcessRunner.listProcesses`) finds new terminals; raising is one way (`ProcessRunner.increasePriority`), so turning it off applies after a restart.

#### `telemetry.enabled`

Default `true`, computed `false` in dev/unpackaged · `src/main.ts`. Enable telemetry; read by `telemetry-module` (passive events) and `error-report-module` (crash reports). Live.

#### `log.level`

Default `notice`, computed `debug` in dev · `logging-module.ts`. Level spec `<level>` or `<level>:<filter>` (levels `silly|debug|info|notice|warn|error`; e.g. `debug:git,process`).

#### `log.output`

Default `file` · `logging-module.ts`. Comma-separated destinations: `file`, `console`, or `file,console` (`storeEnumList`).

#### `log.format`

Default `text` · `logging-module.ts`. `text` or `json`.

#### `electron.flags`

Default `null` · `electron-lifecycle-module.ts`. Electron switches (e.g. `--disable-gpu`).

#### `electron.disabled-features`

Default `null` · `electron-lifecycle-module.ts`. Comma-separated Chromium features for `--disable-features`. `null` = curated defaults (`DEFAULT_DISABLED_FEATURES`); `""` = nothing disabled; any value fully replaces the defaults. Settings control: checkbox-guarded text (`guarded-text`).

#### `debug.blocking-pids`

Default `false` · `debug-module.ts`. Simulate blocking processes during workspace deletion.

#### `debug.setup`

Default `false` · `debug-module.ts`. Force the setup flow with simulated binary download progress.

#### `debug.update`

Default `null` · `debug-module.ts`. Simulate an update notification: `pending` = available + install flow, `downloaded` = ready to install (`true`, what a bare `--debug.update` parses to, = `pending`).

#### `help`

Default `false` · `src/main.ts`. Print config help and exit. Not a user setting.

#### `download-binaries`

Default `false` · `src/main.ts`. Download VSCodium and both agents (configured version, else latest; system installs ignored), then exit without starting the app. Not a user setting.

#### `paths.workspaces` (deprecated config key)

`workspaces-root/module.ts`. The workspaces folder from when it was a setting. Read-only; the app:start `migrations` hook turns an unapplied value into a migration request and resets it. The live value is the `paths.workspaces` **state** key below.

## Persisted State (state.json)

Values the **app writes at runtime** (not user-authored settings) live in `state.json` in the data dir. `StateService` (`src/boundaries/platform/state-service.ts`) is the Config sibling: same `register()`/accessor API, but a minimal async single-file load — no env/CLI overrides, no precedence, no computed defaults; a missing file yields defaults, an unreadable or unknown entry is logged and skipped. Both services compose `PersistedStore` (`persisted-store.ts`: registry, accessors, read-modify-write persistence), which **serializes its writes** (per-instance promise chain), so several owners sharing one file can't lose an update to interleaved read-modify-writes. Each write goes to `<file>.tmp` beside it and is renamed over the file, so another process (`ch` reads the API port and token from `state.json`) and a start after a crash mid-write never see a truncated file.

The `state` module (`src/modules/state-module.ts`) loads `state.json` in the `app:start` `init` hook, before modules consume their values in `start`.

### State keys

#### `telemetry.distinct-id`

`telemetry-module.ts`. Auto-generated telemetry user id. `redact: true`.

#### `telemetry.last-session`

`telemetry-module.ts`. `{ startedAt, endedAt }` of the latest session, ISO timestamps. `endedAt` is written by the `app:shutdown` `stop` hook, so it stays `null` for a session killed from outside. The next launch reports it on `app_launched`.

#### `update.dismissed-version`

`auto-updater-module.ts`. The update version the user last dismissed (silences re-notification; a newer version still surfaces).

#### `auto-workspaces`

`plugin-module/automations.ts`. Tracking map `Record<"${plugin}/${automation}/${itemKey}", {workspaceName, createdAt, projectRef?}>`, written only by `workspace.create` items with `event: false` (desired state). An entry means "already handled, skip". It is forgotten when its item leaves the automation's poll **and** its workspace is gone too (so a re-appearing item is recreated, but a script that returns a short list for one cycle — `gh` does, with exit 0, empty stderr and valid JSON — cannot orphan a live workspace into a create-and-collide loop), or when its automation no longer exists (removed, or its plugin disabled or broken). A project that is not open counts as "unknown", i.e. still existing. Entries without `projectRef` (written before projects were recorded) fall back to an any-project name search and are repaired on the next write; entries an older version recorded by `projectPath` are converted to `projectRef` by the app:start `migrations` hook (unknown projects left as they are). A new item whose name is already taken **adopts** that workspace — entry only, no metadata/wake/focus/prompt. `event: true` items write no state. No auto-deletion, no dismissal sentinel.

#### `plugins.state`

`plugin-module/module.ts` (keys: `trust.ts`). `Record<key, boolean>`, key `<type>:<entry>:<name>` (`local:default:x`, `remote:acme:x`) or `project:<projectRef>:<name>`; `true` = enabled, `false` = disabled; absent = local/remote enabled, project `ask`. Older `local:<name>`, `workspace:…` and project-path keys are converted at app:start `migrations`.

#### `sidebar.collapsed-projects`

`presentation-module.ts`. Refs of the projects whose sidebar card is collapsed to its header (a click on the header bar, or Alt+X, C). Default `[]`. A ref stays listed after its project closes, so the choice survives a reopen. Keyboard navigation (Alt+X arrows and digits) skips the workspaces of a collapsed project. Replaces `sidebar.hidden-hibernated-projects` (hibernated workspaces are now folded away by default and shown by the project's moon button or Alt+X, T — not persisted), which is dropped without migration: an old value is logged and skipped.

#### `sidebar.process-level`

`presentation/process-bar.ts`. `total` | `breakdown` | `tree`, default `total`. The process bar's last level: written whenever `sidebar.process-summary` is set to a level, read when the pulse button or Alt+X, P turns the summary back on (`UiState.sidebar.processLevel`).

#### `sidebar.process-tree-height`

`presentation/process-bar.ts`. The process tree's height as a fraction of the sidebar's, `0.1`–`0.7`, default `0.25`. Written on release of a drag on the tree's top edge (`resize-process-tree` ui:event, clamped); a double-click there resets it.

#### `api.port`

`cli-module.ts`. Port the API server bound, published so `ch` can find this instance. `0` = not running (`storeNumber` has no nullable form and the server never binds port 0).

#### `api.token`

`cli-module.ts`. Shared secret `ch` and `ch mcp` present when connecting. `redact: true`. Minted fresh each launch (one that outlived its process would authorize a connection to whatever bound the port next); cleared with `api.port` on stop.

#### `paths.workspaces`

`workspaces-root/module.ts`. The workspaces root: worktrees (`<root>/projects/<name>-<path-hash>/workspaces/`) and managed clones (`<root>/remotes/`), e.g. a Windows Dev Drive; `null` = the data root. Not a setting (it was one; see the deprecated config key). Written only at a migration's switch, resolved (`FileSystemBoundary.realpath`): git names worktrees by their real path, so an unresolved symlinked root would fail the `isChildOf(workspacesDir)` ownership test. Shown read-only in settings (`SettingsExtraRow`); **Change…** checks the folder (empty, writable, not inside a project, data or bundles root), confirms, requests, relaunches. Every reader goes through `WorkspacesRoot` (read per call).

#### `paths.workspaces-pending`

`workspaces-root/module.ts`. A requested move, run by the app:start `migrations` hook on the starting screen before any project opens (copy managed clones, `git worktree repair` their worktrees, leave every worktree in place, switch, rename screenshot dirs, delete old clones; a failure before the switch is undone). Retry / Continue (drops it) / Quit (keeps it, like a crash). Written by **Change…**.

#### `paths.workspaces-previous`

`workspaces-root/module.ts`. Workspaces directories a migration left under earlier roots (appended at its switch, never pruned). Worktrees there count as CodeHydra's own on any branch, detached included.

#### `paths.workspaces-adoptions-converted`

`workspaces-root/module.ts`. Set once the `external` tags earlier migrations wrote were converted into `paths.workspaces-previous` entries (`convert-adoptions.ts`, app:start `migrations`).

#### `paths.workspaces-current` (deprecated)

`workspaces-root/module.ts`. The root in use before it moved to `paths.workspaces`; read once by the `migrations` hook, then reset.

## Redaction

A key definition may carry `redact`, which scrubs its value in any payload that leaves the machine (e.g. bug reports). `getRedactedOverrides()` — on both `Config` and `StateService`, backed by `PersistedStore` — returns the non-default, non-deprecated values with each key's policy applied:

- `redact: true` replaces the whole value with `"<redacted>"`.
- `redact: (value, redacted) => …` returns a custom projection (the token is passed in), scrubbing only part of the value. It must not throw; `getRedactedOverrides()` fails closed to the token if it does.
- `omit: true` replaces the value with `"<omitted>"` (the key still appears, so a set value is visible) but — unlike `redact: true` — does **not** mask the settings field in the UI; for values edited in the clear that must stay out of diagnostics (e.g. `plugins.config`). `omit` wins when both are set.
- A **rejected** value (validation error) is collapsed to the bare token by `redactRejectedValue`; a custom projection is never invoked on it.

`getEffective()` is **not** redacted — local diagnostics only. Telemetry flows through the `PostHogBoundary` sink (a pure sink — it never gates and never reads Config/State; modules pass redacted overrides in): `telemetry-module` sends `config` overrides as person properties via `identify`; `error-report-module` attaches `getRedactedOverrides()` (config + state) plus compressed logs to every `$exception` — automatic crash reports and the manual bug report alike.

## Logging

### Log files

| Build   | Directory                                       |
| ------- | ----------------------------------------------- |
| Dev     | `./app-data/logs/`                              |
| Linux   | `~/.local/share/codehydra/logs/`                |
| macOS   | `~/Library/Application Support/Codehydra/logs/` |
| Windows | `%LOCALAPPDATA%\Codehydra\logs\`                |

```bash
# Debug mode (env var form of log.level=debug, log.output=console)
CH_LOG__LEVEL=debug CH_LOG__OUTPUT=console pnpm dev
```

### Line scope

Text lines carry the dispatch they were written for as a block after the logger name — `[<trace> <project>/<ws> <intent>@<module>/<hook> <origin>]` (`formatLogScope`, `log-scope.ts`; positional, empty parts left out) — so `grep 'codehydra/ws-logs'` finds one workspace's lines and `grep <trace>` one dispatch's (`parent=` on a `dispatch` line links a nested one to its parent). JSON puts the same in the `scope` object. A line about a workspace, file or directory says so with `logger.scoped({ path }).debug(…)` (or `scoped({ workspace: ref })` for a workspace known by ref) — never a `workspacePath`/`workspace`/`path` context key; the logger turns a workspace path into its name. See docs/ARCHITECTURE.md (Ambient Scope).

### Logger names

The `LoggerName` union in `src/boundaries/platform/logging-types.ts` is the source of truth; `log.level`'s filter takes these names.

| Logger            | Used by                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `process`         | Process spawning (`ExecaProcessRunner`)                                                            |
| `network`         | HTTP requests, ports                                                                               |
| `fs`              | Filesystem operations                                                                              |
| `git`             | Git operations (`SimpleGitClient`)                                                                 |
| `worktree`        | Worktree operations (`GitWorktreeProvider`)                                                        |
| `agent`           | Agent server managers and providers (Claude and OpenCode)                                          |
| `agent-resolver`  | Agent selection                                                                                    |
| `binary-download` | Binary downloads and resolution                                                                    |
| `plugins`         | PluginModule (hooks, automations), PollModule, WakeupModule, the shared script runner              |
| `api`             | IPC handlers, ApiServerModule, view/agent/workspace intent modules                                 |
| `lifecycle`       | App lifecycle API                                                                                  |
| `cli`             | CliModule (`ch` scripts, published connection details)                                             |
| `extension`       | Extension-side logs forwarded to main                                                              |
| `ext-manager`     | ExtensionModule (extension manifests)                                                              |
| `window`          | WindowManager, window and image boundaries                                                         |
| `view`            | ViewManager, view and session boundaries                                                           |
| `badge`           | BadgeManager, AppBoundary                                                                          |
| `power`           | Sleep prevention                                                                                   |
| `dialog`          | DialogBoundary                                                                                     |
| `menu`            | MenuBoundary                                                                                       |
| `notification`    | OsNotificationModule + OsNotificationBoundary                                                      |
| `app`             | Application lifecycle                                                                              |
| `dispatcher`      | Intent dispatch pipeline                                                                           |
| `config`          | Config (config.json)                                                                               |
| `state`           | StateService (state.json)                                                                          |
| `settings`        | SettingsModule (settings dialog)                                                                   |
| `ui`              | Renderer UI components (renderer loggers are `ui` or `api`)                                        |
| `presenter`       | PresentationModule (ui:event intake)                                                               |
| `shortcut`        | ShortcutController                                                                                 |
| `auto-tagging`    | AutoTaggingModule (`new` tag)                                                                      |
| `telemetry`       | TelemetryModule + PostHogBoundary                                                                  |
| `error-report`    | ErrorReportModule (crash + manual bug reports)                                                     |
| `updater`         | AutoUpdater                                                                                        |
| `cleanup`         | CleanupModule (stale data-root sweeps)                                                             |
| `lock`            | LockModule (`ch lock`)                                                                             |
| `help`            | HelpModule (`ch guide`, help dialog)                                                               |
| `workspaces-root` | WorkspacesRootModule (`paths.workspaces`, migration)                                               |
| `workspace-log`   | WorkspaceLogModule (a workspace's log in its IDE)                                                  |
| reserved          | `opencode`, `opencode-server`, `claude`, `api-server`, `mcp` — declared, no logger uses them today |
