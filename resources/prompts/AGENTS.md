# Agent system prompt (`resources/prompts/`)

What every agent session is told about its environment: busy/idle and `[bg]` for background sub-agents, `ch --help` / `ch guide` for help, pages go to `ch ws browser` (logins excepted), worktree ownership, a stale `index.lock` (survives a retry with no git process running: delete it, else give the user its path), operator-driven delegation; background shells via `ch bg` for Claude only.

## Build

- `shared.md` + a per-agent appendix (`claude.md`; OpenCode has none) are concatenated by `composeAgentPrompts` in `vite.config.bin.ts` into `dist/bin/codehydra-prompt-{claude,opencode}.md`. That runs in `pnpm build:wrappers`, so the files exist before tests run.
- The main build copies `dist/bin/*` into `assets/bin`; at runtime they are read from the runtime bin dir (`pathProvider.runtimePath("bin/…")`), outside the ASAR, like the hook handler.

## Delivery

- Claude: `--append-system-prompt-file` from `_CH_CLAUDE_SYSTEM_PROMPT` — required, the wrapper (`src/modules/agent-module/claude/wrapper.ts`) refuses to launch without it. Last-wins, so one composed file per agent.
- OpenCode: `instructions` in `OPENCODE_CONFIG_CONTENT` (`src/modules/agent-module/opencode/server-manager.ts`), unioned with the user's own.

## Rules

- 350-word budget per composed file (`MAX_WORDS` in `src/modules/agent-module/codehydra-prompt.boundary.test.ts`, which asserts load-bearing phrases on the built files — rewording is free, dropping a rule is not). Additions displace something.
- Complements `SERVER_INSTRUCTIONS` (`src/cli/mcp.ts`), which cover only cross-tool facts no MCP tool schema can carry.
