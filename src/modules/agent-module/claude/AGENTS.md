# Claude agent: `ch-bg` / `ch bg`

Provider and status tracking in general: [docs/AGENT_PROVIDERS.md](../../../../docs/AGENT_PROVIDERS.md).

A running background shell keeps a workspace busy by default; one started through the wrapper opts out. Background sub-agents keep busy unless their description starts with `[bg]` (`isOptedOutSubagent`; see docs/AGENT_PROVIDERS.md, Background Tasks); the background shells a `[bg]` sub-agent starts are opted out with it (`trackBackgroundOwners`, `isOptedOutShell`).

- Two spellings: `ch bg <cmd…>` (canonical, `src/cli/main.ts`) and `ch-bg <cmd…>` (`resources/bin/ch-bg`, `ch-bg.cmd`; shipped to the bin dir on the agent's PATH by `module-provider.ts` `scripts`).
- Detection: `isBackgroundWrapped` (`types.ts`, `/\bch-bg\b|\bch\s+bg\b/`) against Claude's `background_tasks[].command`, called by `taskKeepsBusy`, used in `hook-status.ts`. Both spellings must match, or every wrapped shell silently keeps the workspace busy again.
- `ch-bg` stays a self-contained `exec "$@"` (`call %*` on Windows) rather than a shim over `ch`: it works before `ch` is rendered and needs no interpreter.
- Claude only: OpenCode's status tracking never looks at background shells, so `ch-bg` (also on its PATH) changes nothing there, and only Claude's system prompt mentions it (`resources/prompts/claude.md`).
- Tests: `ch-bg.boundary.test.ts`, `src/cli/bg.boundary.test.ts`, `types.test.ts`.
