---
status: DESIGN
last_updated: 2026-08-27
reviewers: []
---

# CLI

## Overview

- **Problem**: CodeHydra's operations are reachable only from inside an agent's MCP client or
  the sidekick extension. There is no way to drive CodeHydra from a shell — a human terminal,
  a script, a git hook, or an agent's Bash tool. Worse, the two surfaces that do exist have
  already drifted: they disagree on coverage _and_ on behavior.
- **Solution**: A single **operation registry** becomes the source of truth for every operation.
  MCP, the plugin server and a new `ch` CLI are generic adapters over it. The HTTP MCP server
  is retired in favor of `ch mcp`, a stdio MCP mode of the same binary.
- **Risks**:
  - Big-bang rollout changes both agent backends' launch paths at once
    (mitigated: e2e coverage of the packaged build; every behavior change enumerated below)
  - Widening the documented Public API (accepted deliberately, enumerated below)
  - `agentLifecycle` must stay plugin-only: a forged `"close"` would resume worktree
    removal while the agent's process tree is still live (mitigated: exposure restricted —
    see Exposure)
- **Alternatives Considered**:
  - CLI as an MCP client over the existing HTTP endpoint → rejected: leaves the plugin
    server as a second hand-written surface, so drift continues
  - A fourth generic HTTP RPC surface for the CLI → rejected: reusing the plugin wire
    means one network surface generated from the registry
  - Separate, independently designed CLI → rejected: this is exactly how the current
    drift was produced

**Not to be confused with** `planning/API_REGISTRY_REFACTOR.md`, which covered the
renderer↔main IPC facade of the pre-dispatcher era. The renderer Private API
(`projects` / `workspaces` / `ui` / `lifecycle`) is **out of scope** here.

## The drift this fixes

Measured against `src/modules/mcp-module.ts:525` and `src/modules/plugin-server-module.ts:721-940`:

| Operation                                                                                            | MCP tool | Plugin channel |
| ---------------------------------------------------------------------------------------------------- | :------: | :------------: |
| get/set metadata, get status, get agent session, restart agent, delete, execute command, create, log |   yes    |      yes       |
| hibernate, wake, project_list, ui_show_message, report_bug                                           |   yes    |       no       |
| openSystemPath, agentLifecycle                                                                       |    no    |      yes       |

And three behavioral disagreements on the _same_ operation:

- `keepBranch` default is inverted — MCP `.default(false)` (`mcp-module.ts:801`) vs plugin
  `req.keepBranch ?? true` (`plugin-server-module.ts:826`).
- Delete completion — MCP awaits the terminal progress event and reports real failures
  (`mcp-module.ts:838-880`); plugin does `void handle` and returns `{started:true}`.
- Create project resolution — plugin infers `projectPath` via `INTENT_RESOLVE_WORKSPACE`;
  MCP requires it as a mandatory argument.

## Architecture

```
Electron main process
└── dispatcher
    └── src/api/  OPERATION REGISTRY  ← single source of truth
         │  { name, input (zod), handler, description, instructions, expose }
         │
         ├─▶ mcp adapter      generic loop → stdio MCP, served by `ch mcp`
         ├─▶ plugin adapter   generic loop → Socket.IO  (existing port)
         └─▶ cli adapter      generic loop → Socket.IO, non-exclusive client kind

out-of-process
   claude / opencode  ──stdio──▶ ch mcp ──WebSocket──▶ plugin port
   sidekick extension ──────────────────WebSocket──▶ plugin port
   ch (human/script)  ──────────────────WebSocket──▶ plugin port
```

No adapter contains per-operation code. Adding a registry entry adds an MCP tool, a plugin
channel and a CLI subcommand at once.

### Registry entry

```ts
{
  name: "workspace.delete",
  input: z.object({ workspacePath: opt, keepBranch: …, ignoreWarnings: …, wait: … }),
  handler: (ctx, args) => dispatcher.dispatch({ … }),
  description:  "Delete a workspace and its worktree.",      // one line: CLI help + MCP summary
  instructions: "<long LLM-facing prose>",                    // MCP appends; `ch <cmd> --help` shows
  expose: {
    mcp:    { tool: "workspace_delete" },
    plugin: { channel: "api:workspace:delete" },
    cli:    { path: ["ws", "delete"] },
  },
}
```

`pick` and `defaults` are available per adapter for deliberate divergences (see Row 5).

### Entry kinds: command vs event

Entries carry `kind: "command" | "event"`. The distinction is **semantic, not transport shape**:

- **command** — an instruction to do something. May return data (`ws status`) or nothing
  (`log`, `ws status set`). A void result does not make it an event.
- **event** — a report of an occurrence the sender _witnessed_, which each receiver interprets
  for itself. `agentLifecycle` is the only one: `"open"` becomes WrapperStart for Claude and
  `markActive` for OpenCode, and `"close"` additionally resolves the teardown waiter. Its
  payload field is literally named `event`.

|                | command                                                     | event                     |
| -------------- | ----------------------------------------------------------- | ------------------------- |
| Meaning        | do this                                                     | this happened             |
| Result         | data, or void                                               | never                     |
| Plugin adapter | ack; `log` stays fire-and-forget as today                   | plain `socket.on`, no ack |
| CLI adapter    | exit code reflects outcome; `wait` applies where meaningful | not exposed — see below   |
| `ch --help`    | listed                                                      | absent                    |

Both kinds are **inbound** to CodeHydra. An event is not an outbound notification.

**Exposure follows from kind for events.** An event can only be sent truthfully by the observer
that witnessed the occurrence, so it is restricted to that observer's adapter — today the
sidekick, hence plugin-only. Commands carry an explicit `expose` and are open to every adapter.

### Ack is a transport decision, not part of the entry

A void result does not imply fire-and-forget. The registry entry declares only whether the
command returns data; each adapter decides how to acknowledge.

- **Plugin**: the sidekick holds a long-lived connection, so `api:log` can skip the ack — it is
  high-volume and the caller has nothing to do with a result. An optimization the persistent
  connection allows, and what exists today.
- **CLI**: **always acks, including void commands.** `ch log info "x"` is a short-lived process;
  `socket.emit()` followed by process exit can drop the packet, because Socket.IO does not flush
  synchronously. The ack is the only reliable delivery signal, and it is what makes exit 0 mean
  _delivered_ rather than _queued_. Same for `ch ws status set`.
- **MCP**: always acks — the protocol requires a response to every `tools/call`.

The plugin server's existing "fire-and-forget - special case" comments (`plugin-server-module.ts:922,
936`) cover both `api:log` and `api:workspace:agentLifecycle`, but for different reasons: the
first is a void command optimized for a persistent connection, the second an event. The
registry separates the two.

Losing an event is tolerated by design: teardown races the `"close"` event against a 5s timeout
and falls back to process cleanup (`AGENT_CLOSE_TIMEOUT_MS`, `:133`).

## Decisions

### Wire and identity

- **Wire**: the existing plugin Socket.IO server, extended with a **non-exclusive CLI client
  kind**. CLI sockets never enter the `connections` map, so they cannot displace the sidekick
  (`plugin-server-module.ts:581-587`) or strand a teardown (`:568`).
- **Workspace-less connections** are permitted for CLI clients, so app-global commands
  (`project list`, `report-issue`) work outside any worktree. Workspace-scoped commands then
  fail with exit code 4.
- **Auth**: a random token generated at `app:start` and stored in `state.json`. Required for
  CLI clients only; the sidekick handshake is unchanged. Protection equals filesystem
  permissions on the user's own data dir.
- **Workspace identity**: server-side resolution becomes **prefix-tolerant** — the longest
  workspace path that prefixes the caller's cwd wins, replacing today's exact match
  (`git-worktree-workspace-module.ts:138`). `--workspace` overrides.

### MCP moves to stdio

The HTTP MCP server is **retired**. `ch mcp` is a stdio MCP server.

- Claude: `mcp.template.json` becomes a stdio entry.
- OpenCode: `McpLocalConfig` (`@opencode-ai/sdk` types.gen.d.ts:946) — `type: "local"`,
  `command: string[]`, `environment: {}`.
- Both configs are app-written, so they pass the node path, workspace path, port and token
  **explicitly**. `ch mcp` never reads `state.json` and never needs `PATH`.

Deleted: the `node:http` MCP server, the per-session transport map, MCP port allocation, the
`X-Workspace-Path` header, `_CH_MCP_PORT`, and `mcp.template.json` port substitution.

This reverses `planning/MCP_SERVER.md`'s original rejection of STDIO ("requires spawning
per-workspace, doesn't fit the attach model"). That trade is accepted: one node process per
agent session buys the deletion above and a single shipped artifact.

### Discovery

`cli-module` writes the resolved plugin port and auth token to `state.json` at `app:start`.
`ch` resolves its own realpath → `dataRoot` → `state.json`. `--data-dir` targets another
instance. A stale entry after a crash surfaces as connection refused (exit code 3).

`config.json` is not used: CLAUDE.md reserves it for user-authored settings, and
`StateService` is the sibling for values the app writes at runtime.

### Scripts and packaging

- `requiredScripts` gains **template** support, rendered with Liquid
  (`src/utils/liquid/liquid-renderer.ts`, already a dependency). `{{ ideNode }}` collides with
  nothing in sh or cmd, unlike the `${VAR}` form used for `mcp.template.json` — `${…}` _is_
  shell syntax. script-module's converge-in-place, lock-retry and chmod logic is unchanged.
- `ideNode` reaches cli-module through a **`nodePath` capability** that ide-server-module
  `provides` and cli-module `requires`. It is derivable at `before-ready`:
  `resolveIdeServerPaths()` (`ide-server-module.ts:254`) is pure.
- `ch-bg`, `ch-claude`, `ch-opencode` become **thin shims** that exec `ch bg|claude|opencode`.
  The files must remain on disk: `claudeCode.claudeProcessWrapper` takes a bare path
  (`main.ts:507` → `ide-server-module.ts:998`).
- **`isBackgroundWrapped` must change in the same commit.** It is `/\bch-bg\b/`
  (`claude/types.ts:162`), which does not match `ch bg npm run dev`. Without the fix every
  wrapped shell silently starts keeping the workspace busy again.
  New form: `/\bch-bg\b|\bch\s+bg\b/`.
- **PATH**: NSIS registers `ch` on Windows. Linux ships an AppImage and macOS a `dir` bundle —
  neither has an installer, so both are documented ("add `<dataRoot>/bin` to your PATH").
- **OpenCode env fix**: `opencode serve` is spawned with the Electron main env
  (`opencode/server-manager.ts:247`), so `binDir` is not on its PATH — its bash tool can reach
  neither `ch` nor `ch-bg` today. The spawn env gains `binDir` on PATH plus
  `_CH_WORKSPACE_PATH`.

### CLI behavior

- **Output**: TTY-aware — human-readable when interactive, JSON when piped.
  `--json` / `--no-json` force either.
- **Exit codes**: `0` ok · `1` command failed · `2` usage error · `3` cannot reach CodeHydra ·
  `4` not in a workspace. Message on stderr; a JSON error object in JSON mode.
- **Global flags** on every command: `--workspace`, `--input '<json>'`, `--json`/`--no-json`,
  `--data-dir`.
- `--input` guarantees anything expressible via MCP is expressible via CLI.

## Command surface

```
ch
├── ws                          workspace scope · target = cwd's worktree, or --workspace
│   ├── status                  workspace_get_status
│   ├── status set <idle|busy>  one-shot nudge → agent:update-status
│   ├── title <TITLE> | --clear composed → set_metadata key `title`
│   ├── create                  workspace_create
│   ├── delete                  workspace_delete         --keep-branch --ignore-warnings --no-wait
│   ├── hibernate | wake        workspace_hibernate | workspace_wake
│   ├── metadata get | set      workspace_get_metadata | workspace_set_metadata
│   ├── tag ls | set | rm       composed → metadata with the `tags.` prefix
│   ├── agent session           workspace_get_agent_session
│   ├── agent restart           workspace_restart_agent_server
│   ├── agent open | close      composed → codehydra.openAgent | codehydra.closeAgent
│   ├── vscode-command <cmd>    workspace_execute_command   raw, --args '<json>'
│   ├── notify <msg>            composed ← ui_show_message  --level info|warning|error --option …
│   ├── status-bar <msg|--clear>   composed ← ui_show_message  --hint
│   ├── ask <msg>               composed ← ui_show_message  --option … (quick pick) or free text
│   ├── browser <url>           composed → simpleBrowser.show + Uri
│   ├── diff <a> <b>            composed → vscode.diff + two Uris
│   ├── goto <file>[:line[:col]]   composed → vscode.open + Selection
│   ├── preview <md>            composed → markdown.showPreview + Uri
│   ├── reveal <path>           openSystemPath --app explorer
│   └── launch <path>           openSystemPath --app default
├── project list                project_list
├── log <level> <msg>           log
├── report-issue <description>  report_bug
├── mcp                         stdio MCP server mode
├── bg <cmd…>                   passthrough (ch-bg)
├── claude [args…]              claude wrapper
└── opencode [args…]            opencode wrapper
```

`ch ws status-bar` is named that way because `ch ws status` is the workspace-status command.

`ch ws agent session` returns `{port, sessionId} | null` — the address of the workspace's
_agent's own_ HTTP server, so a caller can talk to the agent directly rather than through
CodeHydra (`docs/API.md:112-122`). OpenCode: the SDK server. Claude: the bridge/hook server
(`_CH_BRIDGE_PORT`) plus the current session id. `null` while hibernated or not yet started.

`ch ws title` is sugar over `set_metadata` with key `title`; `--clear` sets `null`, reverting
the sidebar row to the branch name. `readTitle` (`shared/api/types.ts:164`) already treats a
blank value as absent.

### `ch ws status set` — a one-shot nudge, by design

It dispatches `agent:update-status` with a synthesized `AggregatedAgentStatus`
(`{status:"busy", counts:{idle:0,busy:1}}` or the idle equivalent). There is **no override
mechanism**: the value stands until the agent provider next pushes a status change.

That is useful rather than futile because the provider only pushes _on change_
(`agent-module.ts:147`, inside `provider.onStatusChange`). While an agent is idle — turn
ended, waiting on the user — nothing fires, so a nudge to `busy` sticks until the agent next
does something. Called mid-turn it is overwritten by the next hook event, which is the
expected and accepted behavior.

Rejected: a sticky per-workspace override consulted during aggregation. It would need storage,
an explicit clear, precedence rules against the provider's real value, and sidebar affordance
for "this is pinned" — and a forgotten override would pin a workspace busy indefinitely.

**Composed commands are registry entries**, so each is also an MCP tool. This takes the tool
count from 14 to roughly 24. Keep `description` to one line and push detail into
`instructions` to limit per-turn context. The composed commands are precisely where agents
currently hand-craft `$vscode` wrappers by hand (`docs/API.md:652-780`), which is the
error-prone case they exist to remove.

## Divergence resolutions

| #   | Divergence                                | Resolution                                                                                                                                                                                                    |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `keepBranch` default inverted             | **`false` everywhere.** `api:workspace:delete` has **no caller** — the sidekick's `workspace` namespace ends at `create` (`extension.ts:401-470`) and nothing in the repo emits it, so nothing real regresses |
| 2   | Delete blocking vs fire-and-forget        | Shared `wait` param, **default `true` everywhere**; `--no-wait` / `wait:false` opts out                                                                                                                       |
| 3   | `ignoreWarnings` MCP-only                 | Added to the shared entry; plugin gains it, default `false`                                                                                                                                                   |
| 4   | `create.projectPath` required vs inferred | **Optional**; inferred via `INTENT_RESOLVE_WORKSPACE` when absent                                                                                                                                             |
| 5   | Initial prompt shape                      | **Rich `{prompt, agent?, model?}` everywhere.** MCP gains agent/model — reverses today's deliberate restriction, so `SERVER_INSTRUCTIONS` (`mcp-module.ts:158-160`) and the prompt files must be rewritten    |
| 6   | Optional `workspacePath` targeting        | Added to metadata/hibernate/wake/delete on every adapter                                                                                                                                                      |

## Exposure

Every registry entry is exposed on **all three** adapters, with exactly one exception.
The plugin API gains hibernate, wake, project_list, ui_show_message, report_bug and the
composed commands (purely additive); MCP and CLI gain openSystemPath.

**`agentLifecycle` is plugin-only.** It is the sidekick reporting an observed VSCodium terminal
event, and it is load-bearing twice over:

1. _It brackets the status stream._ Status derives from signals that exist only while the agent
   runs (for Claude, hook events). Nothing else says the agent started or is gone —
   `"open"` → WrapperStart, `"close"` → WrapperEnd. Without `"close"` a workspace whose agent
   terminal was shut reports its last hook-derived status forever instead of `none`. For
   OpenCode it is the only available signal: the SDK server deliberately outlives the TUI, so
   `tuiAttached` is knowable only from the terminal event.
2. _It is the completion signal for teardown._ Before removing a worktree, CodeHydra asks the
   sidekick to close the agent terminal and waits for the `"close"` event
   (`plugin-server-module.ts:338-416`), because `codehydra.closeAgent` resolves as soon as it is
   invoked, not when the terminal is gone.

A CLI client sending a fake `"close"` would resolve the teardown waiter early and resume
worktree removal while the agent's whole process tree is still live in that directory — the
exact failure that code was written to prevent.

Note the pairing: `ch ws agent open|close` are the **commands** that actually open and close the
tab (`codehydra.openAgent` / `codehydra.closeAgent`, `extensions/sidekick/package.json:34,39`).
`agentLifecycle` is the **event** reporting that it happened.

## Public API changes requiring sign-off

Per CLAUDE.md's IPC-contract rule, all approved:

1. `keepBranch` default flips `true` → `false` on `api:workspace:delete`.
2. `api:workspace:delete` becomes blocking and reports real errors.
3. New channels for the five MCP-only operations plus the composed commands.
4. New optional params: `workspacePath`, `ignoreWarnings`, `projectPath`, `wait`.
5. New CLI client kind and token auth in the handshake.
6. MCP tool `workspace_create` gains `agent` and `model`.

## Testing

- **Integration** (primary, behavioral mocks, <50ms each): the registry and each adapter's
  generic loop.
- **Boundary**: the extended Socket.IO handshake, the CLI client kind and token auth, and the
  stdio MCP shim — all genuine external interfaces.
- **e2e**: one spec asserting `ch` is present in `binDir`, executable, and answers against a
  packaged build. Required because big-bang changes both agents' launch paths at once.

## Rollout

**Big bang** — registry, CLI, stdio MCP and the HTTP MCP deletion in one change.

## Docs to update

- `docs/API.md` — new channels, changed defaults, the CLI client kind, token auth
- `CLAUDE.md` — the `ch` concept, new `state.json` keys, retired `_CH_MCP_PORT`
- `resources/prompts/shared.md` — mention `ch` alongside MCP tools, and the `--json` convention
- `resources/prompts/claude.md` — `ch bg` alongside `ch-bg`

## Open risks

- **The plugin port is unauthenticated for sidekick clients.** Token auth covers CLI clients
  only, so the pre-existing exposure is unchanged — but the surface reachable through it grows.
