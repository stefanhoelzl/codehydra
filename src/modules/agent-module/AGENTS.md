# Agent module: binary distribution

Details: `docs/ARCHITECTURE.md` (Binary Distribution).

- `binary-resolver.ts` picks an agent's executable: `version.<agent>` set → that version (a channel word resolved first), downloaded, beats a system install; else the first working install on PATH (OpenCode: whose `--version` is a supported major, 1 or 2 — `supportedMajors`); else the agent's default channel (Claude `stable`, OpenCode `latest`), downloaded. A download of an unsupported major fails.
- OpenCode 1.x and 2.x are different server APIs; the wire is picked by the resolved major (`opencode/wire.ts`, docs/AGENT_PROVIDERS.md). 2.x downloads come from npm (`@opencode/cli-<os>-<arch>`).
- Channels are re-resolved each start; a newer version downloads in the background while the present one is used.
- Download coordinates: `claude/setup-info.ts`, `opencode/setup-info.ts`.
- The resolved absolute path reaches each workspace as `_CH_CLAUDE_BIN` / `_CH_OPENCODE_BIN`; wrappers never search PATH.
- VSCodium is pinned in `src/modules/ide-server-module/vscodium.ts`.
- Nothing downloads at `pnpm install`: the first start (dev or prod) runs the setup screen, and `codehydra --download-binaries` fetches everything and exits.
