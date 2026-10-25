# Plugin module

User scripts attached to CodeHydra: YAML manifests contributing **hooks** and **automations**. Contract for plugin authors: docs/USER_GUIDE.md (Plugins). Design rationale: docs/ARCHITECTURE.md (Plugins). Each file below opens with a header comment that is its spec — read it before changing the file.

## Files

- `module.ts` — `PluginModule`: registers `plugins.enabled`, `plugins.config` (config) and `plugins.state` (state); binds the hooks; runs scripts; `api` behind `ch plugin …` (`src/api/entries/plugin.ts`).
- `discovery.ts` — finding plugins in a source; `manifest.ts` — strict zod manifest schema; `plugin-config.ts` — a manifest's `config:` settings and their values.
- `sources.ts` — parses `plugins.config` (`parseSourcesConfig`), edits its text keeping comments (`ch plugin add|remove`); `remotes.ts` — git sources.
- `hook-map.ts` — the hook contract (entries, input/output schemas, hook-point bindings); `hook-output.ts` — parsing a hook's stdout; `output-sink.ts` — hook output to the workspace IDE's `CodeHydra Plugins` output channel, buffered until its sidekick connects.
- `automations.ts` — what automation items mean (workspace reconciliation, `auto-workspaces` state); `items.ts` — item schemas; `template-render.ts` — Liquid for `ch plugin render`.
- `trust.ts` — enabled/disabled/ask, the trust dialog; `errors.ts` — the error book (`ch plugin errors`).
- Outside this directory: `src/modules/scripts/` (`script-runner.ts`, `shells.ts`, `run-log.ts`, `failure-cards.ts` — shared with poll and wakeup scripts), `src/modules/poll-module.ts`, `src/api/adapters/plugin-actions.ts` + `plugin-actions-map.ts`.

## Sources and names

- A plugin is `<name>.yaml` or `<name>/plugin.yaml` in a **source**:
  - **local**: `~/.codehydra/plugins` (entry `default`, `PathProvider.homePath("plugins")`) and folders `plugins.config` lists. Every project, enabled by default, hooks + automations.
  - **remote**: git repositories `plugins.config` lists. Same as local.
  - **project**: a worktree's `.codehydra/plugins`. That worktree only, hooks only (an `automations:` section is ignored with a warning), trusted per plugin.
- Name `<type>:<entry>:<plugin>`: `local:default:x`, `local:work:x`, `remote:acme:x`, `project:<project name>:x`. Parsed by splitting at the first and last `:` (a project name may hold one, a plugin name never does).
- `plugins.config` is one YAML-valued setting, a mapping of entries `{type: local|remote|project, …, config: {<plugin>: {<setting>: value}}}`. A `project` entry adds no plugins, only values for a repository's plugins. `omit: true` (holds tokens).
- Remote (`remotes.ts`): under `<data>/plugins/remotes/<entry>-<url-hash>/` a bare `repo.git/`, one detached checkout per commit in `trees/<commit>/`, and `current.json`. Fetched at app start (`app:started`, background), when an entry is new or its ref changed, and on `ch plugin add|update` — never otherwise. A running script leases its tree (`acquire`); a fetch checks out beside the old tree and switches `current`; a tree neither current nor leased is pruned.
- Settings: a manifest's `config:` declares flat scalars; values come from the plugin's entry in `plugins.config`, delivered only as `CH_CONFIG_<NAME>` env (upper-cased, `-` → `_`; never stdin, which is logged; inherited `CH_CONFIG_*` dropped). A value that does not fit makes the plugin unable to run.

## Manifest

- A multi-document YAML stream; each document has `shell` (`bash` default | `powershell` | `cmd`) and `platform` (`linux` | `windows` | `macos`, default all). Every matching document applies, in file order.
- Strict zod schemas are the docs: an unknown key fails the whole plugin. `ch plugin schema` prints them as JSON Schema (`--items`: the automation item schema).

## Hooks

`hooks.<entry>: <script>`. The name is the blocking rule: an `on-` entry is fire-and-forget (output ignored); every other blocks and exchanges JSON (stdin in, stdout out). `OPEN_WORKSPACE_HOOKS` / `DELETE_WORKSPACE_HOOKS` are exhaustive over the operations' hook points (`null` = not exposed) and bound with `bindHookPoints`, so a new hook point fails to compile until decided.

- `after-worktree-created` — `open-workspace : provision`, new worktrees only. May return `title` / `tags`. Best-effort: failure is loud, the workspace still opens.
- `before-workspace-opened` — `open-workspace : prepare`, every open. May return `env`, delivered in memory only to the agent terminal, `opencode serve` and editor terminals, never a file. `_CH_*` keys dropped here (`RESERVED_ENV_PREFIX`). Layered over `WORKSPACE_ENV_DEFAULTS` (`GIT_OPTIONAL_LOCKS=0`, only when not already in the app's env). Best-effort.
- `before-worktree-deleted` — `delete-workspace : pre-delete`; may refuse with `{"blocked":true,"reason":…}`; fails closed (a broken script also stops the deletion). Its `preflight` handler claims the `repo-hook` deletion-panel row.
- `on-workspace-opened` — observes `workspace:created` (every open).
- Several plugins on one entry run sequentially — the user's sources in `plugins.config` order (default first), each by name, then the repository's by name, each plugin's documents in file order — and merge: `env` / `tags` per key later-wins, last `title`, first refusal stops.
- No hook timeout: a blocking run registers with the presenter (`trackRunningHook`), which offers Cancel; the deletion panel cancels via `cancelRunningHooks`. Cancel kills the process tree and counts as failure. `app:shutdown` → `stop` cancels every hook run in flight (`on-` included) and starts no new ones.

## Automations

- `automations.<name>: <script>` (local and remote plugins only), identity `<plugin>/<name>`. Run every poll tick (`poll.interval`) as `poll:tick` jobs: the plugin module collects them and acts on their items; `poll-module.ts` runs them and owns their failures (timeout `poll.timeout`, exit 75 = temporary, run logs, failure cards; `ch plugin errors` reads them back).
- The script prints a JSON array of items `{action, …that operation's input}`. `action` is the discriminator over the registry operations the exhaustive `plugin-actions-map.ts` allows; item schemas (`items.ts`) are the registry's input schemas made strict (an unknown field refuses the item).
- `plugin-actions.ts` invokes actions as an app-global caller; a `workspace` input resolves like `--workspace`.
- `workspace.create` items add `event` (default `false`: desired state, tracked by `key` in `auto-workspaces`; `true`: fire every time printed), `key` (default `name`), `metadata`.
- `ch plugin render <template> [items]` (`plugin.render`; items default to stdin) is the opt-in Liquid filter.

## Running scripts (`src/modules/scripts/`)

- `script-runner.ts`: body → temp file, GitHub-Actions shell flags, `ch` on PATH, `CH_PLUGIN_DIR` (folder plugins) / `CH_WORKSPACE_DIR` (hooks), JSON stdin newline-terminated, rest of the app's env inherited. Windows bash = `paths.bash` or Git Bash (`shells.ts`), never WSL.
- Each run writes `<data>/logs/plugins/<type>/<entry>/<plugin>/<kind>/<hook-or-automation>/<ts>-<hex>.<ok|failed>.log` (project plugins: `project/<project dir>/…`) — header, stdin, stderr, stdout, never env. Retention per entry: newest 10 failures, newest 1 success (`run-log.ts`). Script output never reaches the app log.
- Error book (`errors.ts`): **problems** (a plugin cannot run: bad manifest, bad settings, missing shell) and **failures** (last failed run of a hook or remote fetch). `ch plugin errors --all` adds past failures: kept failed run logs plus log-less ones since start. One card per failing entry (`failure-cards.ts`), raised per distinct message, closed when the entry clears, with a `keepOpen` **Open log** button (OS default app).

## Trust

- `trust.ts`, persisted in state `plugins.state`: `Record<key, boolean>`; absent = local/remote `enabled`, project `ask`. Project keys use the project's ref (`project:<projectRef>:<name>`), not its name.
- Asked when a plugin would actually run, whatever triggered it: one checkbox dialog per project listing every plugin at `ask` — **Remember** stores checked/unchecked as enabled/disabled, **Just this time** runs the checked ones and stores nothing.
- Legacy `.codehydra/hooks` is not read.
