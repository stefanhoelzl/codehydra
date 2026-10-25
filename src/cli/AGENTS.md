# `ch` CLI (`src/cli/`)

Full reference: [docs/API.md](../../docs/API.md) (`ch` CLI, MCP, WebSocket handshake).

## What ships

- `src/cli/main.ts` is bundled to `ch.cjs` by `vite.config.bin.ts`; `cli-module` ships it to `<dataRoot>/bin` with the templated `ch` / `ch.cmd` wrappers (the bundled interpreter's path is baked in, so `ch` runs from a shell that inherited none of CodeHydra's environment).
- Subcommands come from the operation registry (`src/api/`, see its AGENTS.md): `ch ws status`, `ch project list`, …. `run.ts` resolves every command against the app's describe channel.
- Built-ins that are not registry operations:
  - `ch mcp` (`mcp.ts`) — the stdio MCP server both agents launch; tool list fetched from describe at startup. `SERVER_INSTRUCTIONS` there carry only cross-tool facts no tool schema can.
  - `ch claude` / `ch opencode` — the agent launchers (`agent-module/*/wrapper.ts`), which the sidekick types into the agent terminal. Never touch the app.
  - `ch bg <cmd…>` — passthrough (`spawnSync`, child's exit code via `child-exit.ts`); never touches the app. See `src/modules/agent-module/claude/AGENTS.md`.
  - `ch lock run <name>[,<name>…] [-- <cmd…>]` (`lock-run.ts`) — over the hidden `lock.hold`.

## Finding the instance (`discovery.ts`, `chooseConnection`)

Precedence: `_CH_DATA_DIR`, then `_CH_API_PORT` + `_CH_API_TOKEN` (so `ch mcp` needs no state file), then `api.port` + `api.token` from `state.json` in the data dir `ch`'s own realpath resolves to.

- An app always clears every inherited `_CH_*` at startup (`clearInheritedEnv`, `src/utils/inherited-env.ts`, first thing in `src/main.ts`), so an app started from inside a workspace (`pnpm dev`, `pnpm preview`, e2e) gets its own terminals, agents and plugin hooks talking to it, not to the instance it was launched from. `_CHDEV_ROOT_DIR` (the root override, any build flavor) and `CH_*` config vars are not cleared.
- `ch` connects with only who the caller is (its `cwd`); it deliberately ignores `_CH_WORKSPACE` (only `ch mcp` uses it). Never put a target in the handshake — the target is the call's own fields, so no adapter shaping can drop it and act on the caller instead.

## Arguments and output

- `args.ts`: flags are tokenized by `node:util` `parseArgs` against the operation's described JSON Schema. A field comes from `--input <json>` (whole payload), positionals, then flags (increasing precedence). A flag that is neither global (`--format`, `--help`) nor a field is a usage error.
- `--format json|text|auto`; `auto` (default) = JSON when stdout is not a TTY.
- Progress (clone percentages, deletion steps; `progress.ts`) goes to stderr, only when stderr is a TTY.

## Exit codes (`EXIT` in `output.ts`)

| Code | Meaning            |
| ---- | ------------------ |
| 0    | ok                 |
| 1    | failed             |
| 2    | usage              |
| 3    | unreachable        |
| 4    | not in a workspace |
| 5    | conflict           |
| 6    | not found          |

Picked from the failure's `ApiErrorCategory` (`ApiResult.category`, sent by the API server adapter beside the message) — never from the wording.

## Rules

- Calls have no client-side timeout (a disconnect still ends one), so only call channels the app described: `run.ts` resolves every command against describe, `ch lock run` checks for `lock.hold` first.
- `ch lock run` spawns its command async (`spawn`, not `spawnSync`) so socket heartbeats keep flowing; the open connection holds the lock, closing it releases.
- Targets: workspaces and projects are named by ref, whole or short (`ch ws switch test-0`, `ch ws switch app::test-0`, `ch project close ohi`). `--workspace` / `--project` are the operation's `workspace` / `project` fields (`src/api/entries/target.ts`), a usage error on a command without them. A workspace path is not an input; a project's path or origin is.
- Long operations' progress comes from domain events the API server forwards on `api:event` (opt-in per event, `FORWARDED_EVENTS` in `src/api/events.ts`), scoped to the calls in flight (`ApiServerConnection.concerns`).
