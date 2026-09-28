# CodeHydra Architecture

## Quick Navigation

| Section                                                 | Description                          |
| ------------------------------------------------------- | ------------------------------------ |
| [System Overview](#system-overview)                     | High-level architecture              |
| [Core Concepts](#core-concepts)                         | Project, Workspace, Views            |
| [Component Architecture](#component-architecture)       | Main components and their roles      |
| [Intent-Based Architecture](#intent-based-architecture) | Intent dispatcher, operations, hooks |
| [Theming System](#theming-system)                       | CSS variables and VS Code theming    |
| [Logging](#logging-system)                              | Log levels, files, and debugging     |

**Related Documentation:**

- [INTENTS.md](INTENTS.md) - Intent system implementation, platform abstractions, mock factories
- [AGENTS.md](AGENTS.md) - Agent provider interface, status tracking, MCP integration
- [PATTERNS.md](PATTERNS.md) - IPC, UI, and CSS implementation patterns

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CodeHydra Application                             │
├──────────────────────────────────────────────────────────────────────────┤
│  Main Process (Electron)                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────────────┐│
│  │Window Manager │  │ UiViewManager │  │ App Services                  ││
│  │ BaseWindow    │  │ single UI view│  │ ├─ Git Worktree Provider      ││
│  │ resize/bounds │  │ session/focus │  │ ├─ IDE Server Manager         ││
│  │               │  │ mode/devtools │  │ ├─ Project Store              ││
│  └───────────────┘  └───────────────┘  │ └─ Agent Server Managers      ││
│                                        └───────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────┤
│  UI Layer (the single WebContentsView — Svelte renderer)                 │
│  ┌─────────┐ ┌──────────────────────────────────────────────────┐       │
│  │ Sidebar │ │ Workspace iframes (VSCodium, one per             │       │
│  │ dialogs │ │ non-hibernated workspace; only .active visible)  │       │
│  │ overlays│ │ ┌───────────┐ ┌───────────┐ ┌───────────┐        │       │
│  │         │ │ │Workspace 1│ │Workspace 2│ │Workspace 3│        │       │
│  │         │ │ │ (visible) │ │ (hidden)  │ │ (hidden)  │        │       │
│  │         │ │ └───────────┘ └───────────┘ └───────────┘        │       │
│  └─────────┘ └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Project vs Workspace

| Concept   | What it is                        | Viewable       | Actions              |
| --------- | --------------------------------- | -------------- | -------------------- |
| Project   | Git repository (main directory)   | No             | Close, Add workspace |
| Workspace | Git worktree (NOT main directory) | Yes (VSCodium) | Select, Remove       |

**Key behavior:**

- Main git directory is the PROJECT (container, not a workspace)
- Only git worktrees are WORKSPACES (viewable in VSCodium)
- Fresh clone with no worktrees = 0 workspaces → create dialog auto-opens

### Worktree Discovery Logic

| Location                   | Type                                | Discovered as Workspace?    |
| -------------------------- | ----------------------------------- | --------------------------- |
| Main git directory         | Original clone                      | ❌ NO - this is the PROJECT |
| Manually created worktrees | User-created via `git worktree add` | ✅ YES                      |
| App-managed worktrees      | App-created in managed location     | ✅ YES                      |

Example - user opens `~/projects/myrepo`:

```
~/projects/myrepo/                              → PROJECT (not a workspace)
~/projects/myrepo-feature/                      → WORKSPACE (manual worktree)
~/.local/share/codehydra/.../workspaces/feat/   → WORKSPACE (app worktree)
```

### Worktree Storage (Platform-Specific)

New worktrees are created only in the managed location, `<root>/projects/<name>-<hash>/workspaces/`. The root is the data root unless `paths.workspaces` names another folder (e.g. a Windows Dev Drive); managed clones follow it to `<root>/remotes/`. Every reader goes through `WorkspacesRoot` (`src/modules/workspaces-root/`), which reads the root in use — the `paths.workspaces-current` state key — on each call.

| Platform    | Data root (default workspaces root)        |
| ----------- | ------------------------------------------ |
| Linux       | `~/.local/share/codehydra/`                |
| macOS       | `~/Library/Application Support/codehydra/` |
| Windows     | `%LOCALAPPDATA%\Codehydra\`                |
| Development | `./app-data/`                              |

Windows releases used `%APPDATA%\Codehydra\` (the roaming profile) before. `relocateDataRoot` (`src/boundaries/platform/data-root-relocation.ts`) moves an existing install at bootstrap, synchronously and before the logger or `Config.load()` open anything: every entry but the source code (`remotes/`, `projects/*/workspaces/`) is renamed across (copied when the profile is on another volume), `electron/` first so a still-running older instance fails the move before anything changed, and the moved state.json gets `paths.workspaces-current` = the old folder. Any failure puts everything back and runs from the old folder (`DefaultPathProvider`'s `platformRoot`) until the next start. The workspaces-root `migrations` hook then sees the root in use is the legacy data root with `paths.workspaces` unset, and runs Migrate without the dialog.

Discovery finds worktrees in ANY location; creation only in managed location.

**Changing the root.** The app:start `migrations` hook compares `paths.workspaces` with the root in use and asks on the starting screen. **Migrate** (empty folder only) moves managed clones and nothing else: worktrees are adopted in place (`external` tag) so agents keep their conversations and editors their state, and new worktrees go to the new root. The tag lives on a branch, so the switch also records each old workspaces directory that still holds worktrees (`paths.workspaces-previous`): discovery counts a worktree there as CodeHydra's own on any branch, detached included, the way it counts one under the current root. The switch (`paths.workspaces-current`) is the commit point: failures before it are undone (copies deleted, `git worktree repair` pointed back, tags removed); after it they are reported. Path-keyed state (`hooks.trusted`, `auto-workspaces`, screenshots) is moved by each owner (`moveProjects`). **Use as is** switches without moving. The new folder is recorded with symlinks and junctions resolved, because git reports worktree paths resolved and ownership is a path-prefix test. See `src/modules/workspaces-root/migrate.ts`.

### Remote Projects (Cloned from URL)

Projects can be created by cloning from a git URL. A "remote" (managed) project is identified by its URL, not by where its clone sits:

```
<dataRoot>/remotes/<repo-name>-<url-hash>/<repo-name>/   # The clone (a normal clone) — the project's path
<dataRoot>/projects/<repo-name>-<url-hash>/config.json   # The record: {"remoteUrl": "..."} only
<dataRoot>/projects/<repo-name>-<path-hash>/workspaces/  # Its worktrees, named after the clone path like any project
```

**Key differences from local projects:**

- **URL-named record**: the record holds only `remoteUrl`; the path is derived from it (`managedClonePath` in `paths.ts`), so nothing stored names the clone's location and the clone can move. A record is written this way only when the clone sits exactly where its URL derives — otherwise it keeps `{path, remoteUrl}`. Legacy `{path, remoteUrl}` records in the path-named directory are moved at startup (`load-projects`), leaving the worktrees where they are
- **Duplicate detection**: Cloning the same URL returns the existing project (URL normalized for comparison)
- **Deletion option**: When closing a remote project, users can optionally delete the clone and its project directories

**URL normalization** for duplicate detection:

- Hostname and path converted to lowercase
- `.git` suffix removed
- Credentials stripped
- Trailing slashes removed
- Port numbers preserved

## View Architecture

The app owns exactly **one WebContentsView**: the UI layer (Svelte renderer).
Workspaces render as `<iframe>` elements inside its DOM (`WorkspaceFrames`
component), derived declaratively from the renderer's projects store:

- **Mount**: every non-hibernated workspace with an IDE server URL gets an
  iframe, eagerly (instant switching). URLs arrive on workspace payloads
  (`workspace:created`, `project:opened`).
- **Visibility**: only the active workspace's iframe is `display: block`
  (`.active` class). Inactive iframes are `display: none`, so Chromium
  suspends their paint/layout. Iframes are cross-origin OOPIFs — each keeps
  its own renderer process, so the memory profile matches the previous
  shared-host design.
- **Unmount**: hibernating a workspace (metadata flip) or removing it
  (`workspace:removed`) drops the iframe from the DOM.
- **Focus**: switching to a workspace focuses its iframe (rAF-deferred past
  layout); an injected in-frame tracker (`installChildFrameScript`) restores
  the last-focused element inside VSCodium. Focus is routed by mode —
  entering shortcut mode blurs the frame so navigation keys stay in the UI.
- **Loading indication**: the main process shows a "Loading workspace..."
  dialog from `workspace:created` until the agent's first status report (or
  a 10s timeout). No view-level load tracking exists.
- **Recovery**: two witnesses catch a frame that stays mounted but no longer
  shows a workbench. Showing a frame pings it, and a frame that stops
  answering is reloaded (renderer process died). A workbench that shuts down
  or navigates away on its own keeps answering, so the second witness is its
  sidekick: `frame-watchdog-module` watches `onWorkspaceDisconnected`, and a
  disconnect we did not cause (not hibernate/delete/quit) that is not followed
  by a reconnect within 15 s reloads that one frame (`reloadFrame` →
  `__chReloadFrame`), once. Every committed navigation of a workspace frame is
  logged (`Workspace frame navigated`) so a report shows where a frame went.

The main process side is a slim `UiViewManager`: UI view lifecycle
(create/load/bounds-on-resize/destroy), the shared session's
header/permission handlers, `window.open` interception, keyboard and
devtools capability targets (webContents-level, so they see input typed in
iframes), pure mode state, mode-routed focus, and active-workspace
screenshot capture (full-view capture clipped to the iframe's rect via a
renderer hook).

### UI Modes

The mode (`workspace`/`shortcut`/`dialog`/`hover`) is **computed in main by the
presenter** (priority `shortcut > dialog > hover > workspace`) from state it
owns — open dialogs, shortcut activation, and the renderer's last hover
`ui:event` — and shipped in the `UiState` snapshot as `ui.mode`. The renderer
reads mode only from the snapshot; there is no renderer→main `setMode` and no
`mode-changed` round trip. Since everything is one DOM tree, "raising the UI"
is CSS stacking, not view z-order: the sidebar, overlays, panel, and dialogs
simply have higher z-index than the frames container.

## Component Architecture

### Main Process Components

| Component       | Responsibility                                                         |
| --------------- | ---------------------------------------------------------------------- |
| Window Manager  | BaseWindow lifecycle, resize handling, minimum size, overlay icons     |
| UiViewManager   | Single UI view lifecycle, session handlers, mode state, focus, capture |
| Badge Manager   | App icon badge showing count of idle workspaces (platform-specific)    |
| IPC Handlers    | Bridge between renderer and services                                   |
| Preload Scripts | Secure IPC exposure, keyboard capture                                  |

### Preload Scripts

| Script           | Used By  | Purpose                                            |
| ---------------- | -------- | -------------------------------------------------- |
| preload/index.ts | UI layer | Expose IPC API for sidebar, dialogs, shortcut mode |

**Note**: Workspace iframes have NO preload script (preload scripts do not run in subframes), so IDE server content cannot reach `window.api`. Keyboard capture is handled via main-process `before-input-event` on the UI view's webContents, which sees input typed inside iframes.

### App Services (pure Node.js, no Electron deps)

Services are pure Node.js for testability without Electron:

| Service                      | Responsibility                                                                                     | Status      |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| Git Worktree Provider        | Discover worktrees (not main dir), create, remove                                                  | Implemented |
| IDE Server (IdeServerModule) | Download/start/stop the embedded IDE server + per-workspace files, behind the `IdeServer` boundary | Implemented |
| Project Store                | Persist open projects across sessions                                                              | Implemented |
| OpenCode Server Manager      | Spawn/manage one `opencode serve` per workspace                                                    | Implemented |
| OpenCode Status Provider     | SSE connections, status aggregation                                                                | Implemented |
| VS Code Setup Service        | First-run extension and config installation                                                        | Implemented |
| Hooks Module                 | Run a repository's own `.codehydra` scripts at curated lifecycle moments                           | Implemented |
| NetworkLayer                 | HTTP, SSE, port operations, local sockets (HttpClient, SseClient, PortManager, LocalSocketClient)  | Implemented |
| ApiServer                    | Socket.IO server for VS Code extension communication                                               | Implemented |
| McpServerManager             | MCP server for AI agent workspace API access                                                       | Implemented |
| PosthogModule                | PostHog analytics for DAU, version, platform, errors                                               | Implemented |
| AutoUpdater                  | Check for updates daily, apply on quit (electron-updater)                                          | Implemented |
| AutoTaggingModule            | Tag newly created workspaces `new`, clear the tag on first switch (`auto-tag.new`)                 | Implemented |

### IDE Server boundary

The embedded browser IDE that renders inside each workspace iframe is abstracted
behind the **`IdeServer`** boundary (`src/modules/ide-server-module/`). The
generic `IdeServerModule` owns the distribution-agnostic lifecycle — download,
spawn, health-poll, resume, extension install, and per-workspace
`.code-workspace` files — and delegates every distribution-specific fact
(download coordinates, serve args, readiness probe, folder/workspace URL scheme,
remote-cli invocation, node path) to a per-distribution descriptor.

One implementation ships: **VSCodium reh-web** — the official build (Open VSX,
first-class Windows). It runs on a fixed port (25448) so it keeps a stable
IndexedDB origin. The `code`/`ch-*` terminal wrapper scripts are
distribution-agnostic: the module passes the descriptor's concrete
remote-cli/node paths as env vars (`_CH_IDE_REMOTE_CLI`, `_CH_IDE_NODE`), so the
descriptor is the only distribution-specific surface.

### Workspace Cleanup

The Git Worktree Provider includes resilient deletion and orphaned workspace cleanup:

**Workspace Deletion Sequence**: When a workspace is deleted, the following operations run in the "kill-terminals" step, followed by cleanup operations:

1. **Kill terminals and extension host** (best-effort, in "kill-terminals" step):
   - Sends `shutdown` event to the VS Code extension, which handles:
     1. Gets all terminals and disposes each one
     2. Waits for `onDidCloseTerminal` events (or 5s timeout)
     3. Removes workspace folders (releases file watchers)
     4. Terminates the extension host process
   - If the workspace is not connected or operations time out, the step is marked as done and deletion continues

2. **Unmount the iframe**: The renderer drops the workspace's iframe from the DOM when the `workspace:removed` event lands (DOM removal destroys the frame's renderer).

3. **Remove worktree**: Executes `git worktree remove --force` to remove the git worktree.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Workspace Deletion Flow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  remove() ──► switchToNextWorkspace() ──► executeDeletion()        │
│                     │                           │                   │
│                     ▼                           ▼                   │
│              iframe hidden          ┌───────────────────────┐       │
│              (still mounted)        │ Op 1: kill-terminals  │       │
│                     │               │ "Terminating processes"│       │
│                     │               │ (ApiServer command) │       │
│                     │               └───────────┬───────────┘       │
│                     │                           │                   │
│                     │               ┌───────────────────────┐       │
│                     │               │ Op 2: cleanup-vscode  │       │
│                     │               │ "Closing VS Code view"│       │
│                     │               │ (renderer unmounts     │       │
│                     │               │  iframe on removed)    │       │
│                     │               └───────────┬───────────┘       │
│                     │                           │                   │
│                     │               ┌───────────────────────┐       │
│                     │               │ Op 3: cleanup-workspace│      │
│                     │               │ "Removing workspace"  │       │
│                     │               │ (git worktree remove)  │       │
│                     │               └───────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Resilient Deletion**: When `git worktree remove --force` fails but the worktree was successfully unregistered (e.g., due to locked files in VSCodium), the deletion is considered successful. The orphaned directory will be cleaned up on next startup.

**Blocking Process Detection (Windows)**: When deletion fails due to locked files (EBUSY, EACCES, EPERM), the `WindowsFileLockModule` handles blocking processes using the Windows Restart Manager API via a PowerShell script. The module provides three hook-based operations:

| Operation | Hook Point | Description                                  |
| --------- | ---------- | -------------------------------------------- |
| Release   | `release`  | CWD-only scan + kill before deletion attempt |
| Detect    | `detect`   | Full handle detection after deletion failure |
| Flush     | `flush`    | Kill user-selected PIDs on retry             |

The UI shows a scrollable list of blocking processes (with files and CWD) and offers a split button with "Retry" as the main action and a dropdown menu with "Kill Processes" (terminates processes), "Close Handles" (closes handles with elevation), or "Ignore Blockers" (skips detection). A "Dismiss" button closes the dialog. On non-Windows platforms, the module is not registered (detection steps are skipped).

**Startup Cleanup**: On project open, `cleanupOrphanedWorkspaces()` runs non-blocking to remove directories in the workspaces folder that are not registered with git. This handles cases where previous deletions partially failed.

**Security Measures**:

- Skips symlinks (prevents symlink attacks targeting system directories)
- Validates paths stay within workspacesDir (prevents path traversal)
- Re-checks worktree registration before each deletion (TOCTOU protection)
- Concurrency guard prevents multiple cleanups running simultaneously

### Data Root Cleanup

`CleanupModule` (`src/modules/cleanup-module.ts`) sweeps the data root of things nothing uses any more. It runs on the `app:start` "start" hook, **fire-and-forget**: reclaiming gigabytes can take seconds and nothing waits on the result. That is safe because every path a rule touches is one nothing else writes — retired directories no code references, log files older than the current session, bundle versions other than the live one. The one sweep that _is_ order-critical, clearing the temp root before a workspace writes its agent config into it, stays in `TempDirModule`, awaited in the earlier "init" hook.

Rules are declared by the composition root (`src/main.ts`) and run in order, so a rule that retires a path can precede one that sweeps its parent — `claude/configs` is retired before the `claude` bundle rule, so the retired directory is never mistaken for a version to keep.

| Rule kind    | Behaviour                                                                  |
| ------------ | -------------------------------------------------------------------------- |
| `retire`     | Delete a path we no longer use, whole (file or tree)                       |
| `keepRecent` | Keep the newest N entries **by name**                                      |
| `pruneEmpty` | Delete childless directories directly under a path                         |
| `bundle`     | Keep only the versions of a downloaded bundle in use; packaged builds only |

`keepRecent` sorts by name, not timestamp: session logs are named for the launch that wrote them (`2026-08-28T07-35-51-<id>.log`), so lexicographic order is already chronological and no `stat` is needed. Names that are not session logs rank **oldest**, so a stray file in the log directory is the first thing swept.

`bundle` reads the versions to keep (`keep()`) when it runs, not when it is declared, so it reflects what this launch resolved — for an agent, the version in use plus one still downloading in the background. It is skipped in development builds: dev shares its data root with binaries the test helpers download, which may be versions the running app does not resolve. An empty list (an agent running its system install) means no version directory is needed, so every one is a leftover; null (an agent this launch has not resolved yet — the non-configured one until the creation form asks about it) leaves the directory alone.

Every rule is best-effort and isolated: a failure is logged at warn and the remaining rules still run. An **absent** target is silent (the normal case); an **unreadable** one is reported, so cleanup never quietly behaves as though there were nothing to clean. One info line summarises what was removed.

### Plugins

What a plugin author needs — where plugins live, the manifest, the JSON exchange, each hook's input and output, automations, trust — is in the user guide ([USER_GUIDE.md](USER_GUIDE.md#plugins)). This section keeps the reasoning behind that shape; the implementation is `src/modules/plugin-module/`.

- **One model for every user script.** Repository hooks and auto-workspace sources were two ways to run a user's script, with two runners, two trust stories and two config shapes. A plugin is a manifest that says what it contributes, one top-level section per kind (`hooks`, `automations`, later more), and every kind goes through one runner. A future extension point adds a section and a schema, not a new mechanism.
- **The schema is the documentation, and it is strict.** zod schemas per section produce the JSON Schema `ch plugin schema` prints. An unknown key fails the whole plugin: a typo, or a section a newer CodeHydra added, is reported rather than silently doing nothing — and a broken edit never half-runs. There is no version field until one is needed; the strictness already turns "too old" into a named error.
- **The shell is declared, not guessed.** Each document names its `shell`, so a script means the same thing on every machine; the body runs from a temp file with GitHub Actions' flags, which people already know (`bash -eo pipefail`). On Windows, bash is Git Bash — found next to `git` on PATH, then in the usual install roots, the probe VS Code's terminal profiles use — and never WSL's `System32\bash.exe`, which runs in a VM that sees none of our paths, environment or tools, so a script would half-work. `cross-spawn`'s shebang handling was no basis: it resolves `bash` from PATH, which on Windows is exactly WSL's. Platform differences are documents with a `platform`, replacing the old `.win`/`.linux`/`.mac` file-name suffixes.
- **Two origins, two trust defaults.** `~/.codehydra/plugins` is the user's own and runs without asking; a repository's `.codehydra/plugins` is code from somewhere else. The escalation worth defending against needs no carelessness — `ch ws switch <git-url>` clones and opens — so a repository's plugin runs only once trusted. Trust is per plugin (a repository adding a second plugin must not ride on the first one's yes), asked in one dialog per project with a checkbox each. It is asked whatever triggered the hook — the UI, `ch ws delete`, an automation — because a gate that disappears when called from a script is not a gate.
- **Read from the worktree.** A repository's plugins must be committed on the branch a workspace is created from; that is the trade for being able to write and test one inside a workspace, the only place a user has the repository open. For the same reason a repository's plugin may not contribute automations: they are project-wide and timed, and whichever worktree happened to be read would decide what runs.
- **Composition is sequential and deterministic.** Several plugins may define one hook entry. They run local-then-workspace, each group by name, and merge in that order — `env` and `tags` key by key, the last `title`, the first refusal. Parallel runs would make the merge order arbitrary and stop one plugin's setup from depending on another's.
- **The name is the blocking rule.** An `on-` hook reports something that already happened, so it is fire-and-forget; every other entry runs at a moment CodeHydra is waiting on, blocks, and its output matters.
- **Cancel, no timeout, for hooks.** A timeout long enough for `pnpm install` is too long to be an escape, and one short enough kills real setup. While a blocking script runs the module registers it with the presenter (`trackRunningHook`), which offers Cancel where the user is looking: the startup loading screen, the active workspace's loading panel, the deletion panel (`cancelRunningHooks`), or a sidebar notification after a 1.5 s grace. Cancel kills the process tree; the tree kill reaches grandchildren because one holding the inherited pipes keeps the spawn from finishing. Automations, which nobody watches, are killed after 30 s instead. `app:shutdown` → `stop` aborts every hook run still in flight (event entries too) and waits for the kills, and a run started after it is canceled before it spawns: a script is a child of the app, the OS does not take it down with its parent, and one left sitting in its worktree keeps that directory from being removed on Windows.
- **Output goes to a run log, never the app log.** An automation's script routinely inlines a token, and a failing one echoes it (a 401 body, a usage line). So each run writes its own file — header, stdin, stderr, stdout, never the environment — and a notification or `ch plugin errors` (which agents read, and whose transcripts leave the machine) gives the exit and that file's path, never the output. Retention is by outcome (ten failures, one success per entry) because an automation succeeds every minute and would bury the failure worth reading. The session-log cleanup excludes `logs/plugins`.
- **One notification per distinct error.** An automation fails every poll until fixed; the error book raises a card when an error appears or changes, not on every repeat. Automation errors are cleared a cycle after a clean run rather than the moment the script succeeds, so an item failure found after a good script run is not cleared and re-notified every cycle.
- **Automations print actions, not data.** An automation is only its script; the script prints the items to act on, each naming its `action` and carrying that operation's input — the vocabulary `ch` and MCP speak, gated by the exhaustive `plugin-actions-map.ts` (an unattended timer may not change config, take locks or enable plugins). Shaping the data belongs where it comes from (a real language, `jq`), not in a second one inside the manifest: a Liquid template made every value a string, split debugging into two stages, and could not express logic or mixed actions. Templates survive as an opt-in filter, `ch plugin render`, which the migrated `auto-workspace.sources` run through. Items are strict — a hand-written script's typo must not silently do nothing — while the registry itself stays lenient for `ch`/MCP. Other actions are invoked like the CLI — a `workspace` input resolved the way `--workspace` is, since an automation has no workspace of its own. `workspace.create` keeps the auto-workspace behavior, per item: `event: false` (the default) reconciles, because only creation has state worth reconciling, and `event: true` fires. There is one global poll interval, as before; a trigger field waits for a second trigger to exist.
- **Setup once, environment every time.** `after-worktree-created` is work on a new tree and runs once; `before-workspace-opened` supplies the environment on _every_ open, because the environment is never written down — it is delivered in memory to the agent terminal, the editor's terminals and OpenCode's server, so nothing survives a restart or a hibernation for it to rely on. Both block at their own hook point (`provision`, `prepare`) ahead of the agents' `setup`, and both fail loud but not fatal. `title`/`tags` are returned rather than set with `ch` during setup, because a `ch` call races the snapshot the open returns.
- **CodeHydra's own variables win.** A `_CH_*` key in a hook's `env` is dropped at the source rather than left to each consumer's merge order, or a repository could re-point `ch` at another workspace or instance.
- **`branch` and `base` never stand in.** Every entry, on every path, gets `branch` only when a branch is checked out and `base` only when one is recorded; a plausible default would send a script down the wrong path while looking like it worked.
- **`before-worktree-deleted` fails closed.** A refusal (`{"blocked":true}`, exit 0) and a broken script (non-zero exit) both stop the deletion but are reported differently. Dismiss force-deletes and skips hooks entirely, as the escape from a gate that refuses wrongly.
- **The old shapes migrate themselves.** `auto-workspace.sources` is moved into a local plugin at start, tracking entries renamed so nothing is recreated. Old `.codehydra/hooks` files no longer run — running both models would double-run hooks during migration — and a repository still carrying them gets a warning with a Migrate button on every open, which writes a plugin that runs the old files unchanged.

### Workspace Session Model

All workspaces share a single global Electron session to enable extension storage (globalState, secrets) to be shared across workspaces.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ALL WORKSPACES                                   │
│            partition: persist:codehydra-global                      │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │         IndexedDB, localStorage (globalState, secrets)          │ │
│ │                         SHARED                                  │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Workspace A  │  │ Workspace B  │  │ Workspace C  │              │
│  │ ?folder=/a   │  │ ?folder=/b   │  │ ?folder=/c   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  VSCodium uses folder path for workspace-specific state             │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Points:**

- The UI view uses the `persist:codehydra-global` session partition; workspace iframes inherit the embedding page's session, so all workspaces share it
- Session storage (IndexedDB, localStorage, cookies) is global
- VSCodium distinguishes workspaces via the `?folder=` URL parameter
- VS Code's workspace-specific state uses the folder path, not browser storage
- Extension `globalState` and `secretStorage` are shared across all workspaces

**View Destruction Cleanup:**

When a workspace is deleted, the renderer unmounts its iframe (DOM removal
destroys the frame's renderer process). Session storage is NOT cleared — it
is shared with the other workspaces.

### Git Configuration Storage (Workspace Metadata)

CodeHydra stores workspace metadata in git config using the `branch.<name>.codehydra.<key>` pattern:

| Config Key                      | Purpose                                | Example                                   |
| ------------------------------- | -------------------------------------- | ----------------------------------------- |
| `branch.<name>.codehydra.base`  | Base branch workspace was created from | `branch.feature-x.codehydra.base = main`  |
| `branch.<name>.codehydra.note`  | User notes for the workspace           | `branch.feature-x.codehydra.note = WIP`   |
| `branch.<name>.codehydra.model` | AI model preference                    | `branch.feature-x.codehydra.model = gpt4` |

**Storage location**: Repository's `.git/config` file

**Why git config?**

- Portable: survives app reinstall, stored with the repository
- Standard mechanism: git provides CLI and library support
- Per-branch: each workspace/branch has isolated config

**Caveats**:

- Lost if branch is renamed (same as `branch.<name>.remote`)
- Not a standard git key, but git allows arbitrary branch config

#### Metadata Key Restrictions

Metadata keys are validated with `/^[A-Za-z][A-Za-z0-9-]*$/` and:

- Maximum length: 64 characters
- Cannot end with a hyphen

**Valid keys**: `base`, `note`, `model-name`, `AI-model`
**Invalid keys**: `_private` (leading underscore), `my_key` (underscore), `123note` (starts with digit), `note-` (trailing hyphen)

#### Base Branch

`metadata.base` is exactly the `codehydra.base` git config value, and absent when none is recorded (an adopted worktree, or a branch CodeHydra never created). There is no fallback to the branch or the workspace name: consumers — repository hooks included — treat a missing base as unknown rather than guessing one.

### Shell and Platform Layers

Electron APIs are abstracted behind testable interfaces in two domains. This enables unit testing with behavioral mocks while boundary tests verify real Electron behavior.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Main Process Components                         │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ WindowManager   │  │  ViewManager    │  │    BadgeManager             │  │
│  │ ShortcutCtrl    │  │                 │  │                             │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┬───────────────┘  │
│           │                    │                         │                  │
│           │                    │                         │                  │
└───────────┼────────────────────┼─────────────────────────┼──────────────────┘
            │                    │                         │
            │                    │                         │
┌───────────▼────────────────────▼─────────────────────────▼──────────────────┐
│                          Abstraction Layers                                 │
│                                                                             │
│  ┌─────────────────────────────────┐  ┌───────────────────────────────────┐ │
│  │          Shell Layers           │  │         Platform Layers           │ │
│  │         (services/shell/)       │  │       (services/platform/)        │ │
│  │                                 │  │                                   │ │
│  │  WindowBoundary ───► ImageBoundary ───┼──┼─► ImageBoundary                      │ │
│  │       │                         │  │   IpcBoundary                        │ │
│  │       ▼                         │  │   DialogBoundary                     │ │
│  │  ViewBoundary ───► SessionBoundary    │  │   AppBoundary                        │ │
│  │                                 │  │   MenuBoundary                       │ │
│  │                                 │  │   OsNotificationBoundary             │ │
│  └─────────────────────────────────┘  └───────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
            │                    │                         │
            │                    │                         │
┌───────────▼────────────────────▼─────────────────────────▼──────────────────┐
│                            Electron APIs                                    │
│                                                                             │
│  BaseWindow    WebContentsView    session    ipcMain    dialog    app       │
│  nativeImage   Menu                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Layer Dependency Rules:**

| Rule                | Description                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Shell → Platform    | Shell layers may depend on Platform layers (e.g., WindowBoundary uses ImageBoundary for overlay icons) |
| Platform → Platform | Platform layers are independent (no dependencies on each other)                                        |
| Shell → Shell       | Shell layers may depend on each other (e.g., ViewBoundary uses SessionBoundary)                        |
| Platform ↛ Shell    | Platform layers may NOT depend on Shell layers                                                         |

**Handle-Based Design:**

Layers return opaque handles instead of raw Electron objects:

| Layer                    | Returns                | Instead of        |
| ------------------------ | ---------------------- | ----------------- |
| `WindowBoundary`         | `WindowHandle`         | `BaseWindow`      |
| `ViewBoundary`           | `ViewHandle`           | `WebContentsView` |
| `SessionBoundary`        | `SessionHandle`        | `Session`         |
| `ImageBoundary`          | `ImageHandle`          | `NativeImage`     |
| `OsNotificationBoundary` | `OsNotificationHandle` | `Notification`    |

This pattern:

- Prevents Electron types from leaking into manager code
- Enables behavioral mocks that just return `{ id: "test-1", __brand: "ViewHandle" }`
- Centralizes all Electron access in layer implementations

**Boundary Tests:**

Each layer has boundary tests (`*.boundary.test.ts`) that verify behavior against real Electron APIs:

| Layer                    | Boundary Test                      |
| ------------------------ | ---------------------------------- |
| `IpcBoundary`            | `ipc.boundary.test.ts`             |
| `DialogBoundary`         | `dialog.boundary.test.ts`          |
| `ImageBoundary`          | `image.boundary.test.ts`           |
| `AppBoundary`            | `app.boundary.test.ts`             |
| `MenuBoundary`           | `menu.boundary.test.ts`            |
| `WindowBoundary`         | `window.boundary.test.ts`          |
| `ViewBoundary`           | `view.boundary.test.ts`            |
| `SessionBoundary`        | `session.boundary.test.ts`         |
| `OsNotificationBoundary` | `os-notification.boundary.test.ts` |

### Platform Abstractions Overview

All external system access goes through abstraction interfaces defined in `src/boundaries/platform/`. This enables unit testing with mocks and boundary testing against real systems.

**CRITICAL RULE**: Services MUST use these interfaces, NOT direct library imports.

For detailed platform abstraction documentation including interface definitions, mock factories, and usage patterns, see [INTENTS.md](INTENTS.md#platform-abstractions).

| External System    | Interface               | Implementation               |
| ------------------ | ----------------------- | ---------------------------- |
| Filesystem         | `FileSystemBoundary`    | `DefaultFileSystemBoundary`  |
| HTTP requests      | `HttpClient`            | `DefaultNetworkLayer`        |
| Port operations    | `PortManager`           | `DefaultNetworkLayer`        |
| Local sockets      | `LocalSocketClient`     | `DefaultNetworkLayer`        |
| Process spawning   | `ProcessRunner`         | `ExecaProcessRunner`         |
| Build info         | `BuildInfo`             | `ElectronBuildInfo`          |
| Platform info      | `PlatformInfo`          | `NodePlatformInfo`           |
| Path resolution    | `PathProvider`          | `DefaultPathProvider`        |
| Path normalization | `Path` (class)          | Self-normalizing object      |
| Blocking processes | `WindowsFileLockModule` | Intent module (Windows only) |

### Frontend Components (Svelte 5)

| Component             | Purpose                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App                   | Mode router between setup and normal app modes                                                                                                                                                      |
| MainView              | Normal app mode container, IPC initialization                                                                                                                                                       |
| Sidebar               | Project list, workspace list, action buttons                                                                                                                                                        |
| EmptyState            | Displayed when no projects are open                                                                                                                                                                 |
| Dialog                | Base dialog component with focus trap, accessibility                                                                                                                                                |
| CreateWorkspaceDialog | New workspace form with validation, branch selection                                                                                                                                                |
| RemoveWorkspaceDialog | Confirmation with uncommitted changes warning                                                                                                                                                       |
| CloseProjectDialog    | Confirmation when closing project with workspaces                                                                                                                                                   |
| BranchDropdown        | Searchable combobox for branch selection                                                                                                                                                            |
| ShortcutOverlay       | Keyboard shortcut hints (shown during shortcut mode)                                                                                                                                                |
| SetupScreen           | Setup progress display with indeterminate bar                                                                                                                                                       |
| SetupComplete         | Brief success message after setup completes                                                                                                                                                         |
| SetupError            | Error display with Retry and Quit buttons                                                                                                                                                           |
| App.svelte state      | `let ui = $state.raw(UiState)` from `api.onState`; props down. No stores — the renderer is a pure render function of the snapshot. Only ephemeral (hover/in-flight edits/focus) is component-local. |

## Intent-Based Architecture

All application behavior flows through an intent-based dispatcher. External triggers (IPC from the renderer, MCP commands, Electron lifecycle events) create typed intents that the dispatcher routes to operations. Operations orchestrate hook points where modules contribute behavior. Domain events propagate outcomes to subscribers.

### Architecture Overview

```
External Trigger (IPC / MCP / Electron lifecycle)
       │
       ▼
     Intent (typed, registered)
       │
       ▼
  Dispatcher
       │
       ├── Interceptors (may cancel — e.g., idempotency checks)
       │
       ▼
  Operation (1:1 with intent)
       │
       ├── Hook points (modules contribute behavior)
       ├── May dispatch child intents
       ├── Emits domain events
       │
       ▼
    Result
```

### Core Concepts

| Concept         | Responsibility                                               |
| --------------- | ------------------------------------------------------------ |
| **Intent**      | Declarative request describing _what should happen_          |
| **Operation**   | Orchestrates the workflow for one intent type                |
| **Hook**        | Module-provided behavior contributing data or side effects   |
| **Interceptor** | Pre-execution check or transformation (e.g., idempotency)    |
| **Event**       | Fire-and-forget signal emitted after something happened      |
| **Module**      | Declares hooks, interceptors, and event subscribers          |
| **Dispatcher**  | Routes intents to operations, delivers events to subscribers |

### Layer Ownership

| Component                            | Owns                                                                                                                                                                                                                                      | Does NOT Own                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Dispatcher`                         | Intent routing, interceptor pipeline, event delivery                                                                                                                                                                                      | Business logic (in modules)            |
| `Operations`                         | Workflow orchestration, control flow decisions                                                                                                                                                                                            | Side effects (delegated to hooks)      |
| `Modules`                            | Hook handlers, event subscriptions, domain logic                                                                                                                                                                                          | Workflow orchestration (in operations) |
| `PresentationModule` (the presenter) | Owns both UI wires (`api:ui:state` out, `api:ui:event` in): builds the `UiState` view-model from domain events, computes mode, interprets shortcuts, maps domain events to dialogs/notifications, and dispatches intents from `ui:events` | Business logic or workflow control     |

### Core Principles

1. **All externally visible behavior starts with an Intent**
2. **1 Intent = 1 Operation** (enforced by registry)
3. **Operations orchestrate workflows, but do not implement business logic**
4. **Hooks, Events, and Interceptors are the only extension points**
5. **Hooks are unordered by default** -- any ordering must be declared explicitly
6. **Operations decide what happens next**, based on hook outcomes
7. **Modules never call each other**
8. **Composition happens only in the application shell** (`src/main.ts`)

### Key Rules

- **Hook execution**: Operations call `hooks.collect(hookPointId, ctx)` which runs all registered handlers. All handlers always run regardless of earlier errors. The operation inspects `HookResult.errors` and decides whether to continue, abort, or compensate.
- **Control flow**: Hooks do not decide control flow. Operations always decide. Examples: fail-fast (stop on first error), best-effort (collect errors, continue), compensate (run cleanup hooks).
- **Child intents**: Only operations dispatch child intents (via `ctx.dispatch()`). Hooks return data; operations decide whether to dispatch further.
- **Events**: Domain events are fire-and-forget signals emitted via `ctx.emit()`. They cannot affect control flow. Subscribers (UiIpcModule, BadgeModule, WindowTitleModule) react independently.

For concrete operations, hook points, domain events, IPC mappings, capability ordering, platform abstractions, and mock factories, see [INTENTS.md](INTENTS.md).

### Branded ID Types

The API uses branded types (`ProjectId`, `WorkspaceName`) for type safety:

```typescript
// Branded type prevents accidental string/ID confusion
declare const ProjectIdBrand: unique symbol;
export type ProjectId = string & { readonly [ProjectIdBrand]: true };

// Generated from path using deterministic algorithm
function generateProjectId(absolutePath: string): ProjectId {
  const normalizedPath = path.normalize(absolutePath);
  const basename = path.basename(normalizedPath);
  const safeName = basename.replace(/[^a-zA-Z0-9]/g, "-") || "root";
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
  return `${safeName}-${hash}` as ProjectId;
}
```

**ID Format**: `<name>-<8-char-hash>` (e.g., `my-app-a1b2c3d4`)

**Test Vectors**:

| Input Path                    | Generated ID            |
| ----------------------------- | ----------------------- |
| `/home/user/projects/my-app`  | `my-app-<hash8>`        |
| `/home/user/projects/my-app/` | `my-app-<hash8>` (same) |
| `/home/user/Projects/My App`  | `My-App-<hash8>`        |

### IPC Channel Naming

The v2 API uses `api:` prefixed IPC channels:

| API Method                | IPC Channel            |
| ------------------------- | ---------------------- |
| `v2.projects.open(path)`  | `api:project:open`     |
| `v2.projects.close(id)`   | `api:project:close`    |
| `v2.projects.list()`      | `api:project:list`     |
| `v2.workspaces.create()`  | `api:workspace:create` |
| `v2.ui.switchWorkspace()` | `api:workspace:switch` |
| Event subscription        | `api:<event-name>`     |

### Main Process Startup Architecture

The main process uses a composition-root pattern in `src/main.ts`. All services are constructed (pure, no I/O), all operations and modules are registered, then `app:start` is dispatched. See [INTENTS.md — Composition Root](INTENTS.md#composition-root) for the full bootstrap diagram.

### First-Run Flow

On first startup (no `config.json` exists), the application follows this flow:

1. **Config Loading**: `Config.load()` reads `{homeRootDir}/config.json` (`~/.codehydra/`; moved there from `{dataRootDir}` on the first start that finds none). If missing, returns defaults with `agent: null`.

2. **Agent Selection**: When `agent` is null, UI shows `AgentSelectionDialog`. User selects Claude or OpenCode, which calls `lifecycle.setAgent()` to save the choice.

3. **Binary Resolution**: Binary availability is determined per binary:
   - For VSCodium (pinned version): Check exact version in bundles directory
   - For agents with null version (Claude, OpenCode):
     1. Check system binary via `which`/`where`
     2. If not found, check bundles directory for any version
     3. Use latest available or mark for download

4. **Setup Screen**: Shows 3 progress rows (VSCode, Agent, Setup). Downloads run in parallel. Row statuses:
   - `pending`: Waiting to start
   - `running`: In progress (with percentage or indeterminate)
   - `done`: Complete (green checkmark)
   - `failed`: Error occurred (red X, shows Retry/Quit buttons)

5. **Service Startup**: After all binaries are available, the `app:start` operation's `start` hook point initializes servers (IDE server, API server, agent servers, MCP server) and the `activate` hook point loads persisted projects and sets the active workspace. Earlier hook points (`register-config` through `check-deps`) handle configuration, Electron readiness, and dependency verification.

**Key invariant**: The renderer ALWAYS goes through "loading" before "ready". The multi-phase `app:start` design ensures config is loaded, dependencies are checked, and servers are running before data is loaded. This allows the UI to display a loading screen during service startup.

### Renderer Startup Flow

The renderer is event-driven — the main process controls mode transitions via IPC events:

```
App.svelte (mode router)
│
├── Starts in "initializing" mode (blank state)
│   └── Waits for IPC events from main process
│
├── lifecycle:show-agent-selection → "agent-selection" mode
│   ├── AgentSelectionDialog (user selects Claude/OpenCode)
│   ├── sendAgentSelected(agent) → main process continues
│   └── Transitions to "setup" mode
│
├── lifecycle:show-setup → "setup" mode
│   ├── SetupScreen.svelte (progress rows: vscode, agent, setup)
│   ├── lifecycle:setup-progress events → update row statuses
│   └── lifecycle:setup-error → SetupError (Retry emits the `setup-retry` ui:event, Quit emits `setup-quit`)
│
├── lifecycle:show-starting → "loading" mode
│   └── SetupScreen with message="CodeHydra is starting..."
│
└── lifecycle:show-main-view → "ready" mode
    └── MainView.svelte
        │
        └── onMount:
            ├── lifecycle.ready() signals main process
            ├── listProjects()
            ├── Workspace status fetches
            └── Domain event subscriptions (project/workspace/agent)
```

**Key Design Decisions:**

1. **App.svelte owns global events**: Shortcut events and setup progress events work across modes
2. **MainView.svelte owns domain events**: IPC calls only happen when services are started
3. **Multi-phase startup**: The `app:start` operation runs its hook points in sequence (`before-ready` → `init` → `show-ui` → `migrations` → agent selection (first run) → `check-deps` → `start`). The `init` hook uses capability-based ordering: ElectronLifecycleModule provides `"app-ready"` after `app.whenReady()`, and handlers needing Electron declare `requires: { "app-ready": ANY_VALUE }`. Errors in early hooks abort startup.
4. **Main-process-driven flow**: The main process sends IPC events to tell the renderer which mode to show. The renderer never polls or pulls state.
5. **Idempotent startup**: The `app:start` intent uses an idempotency interceptor to prevent duplicate execution
6. **IPC initialization timing**: `listProjects()` and workspace status fetches are called in MainView.onMount, not App.onMount
7. **Loading screen UX**: Services start AFTER UI loads so the loading screen can be displayed during service startup

See [VS Code Setup](#vs-code-setup) for the main process side of this flow.

### UI Mode System

The application uses a unified UI mode system with four modes:

| Mode        | UI Z-Order | Focus          | Description                               |
| ----------- | ---------- | -------------- | ----------------------------------------- |
| `workspace` | Behind     | Workspace view | Normal editing mode                       |
| `shortcut`  | On top     | UI layer       | Shortcut overlay visible                  |
| `dialog`    | On top     | Dialog (no-op) | Modal open (Alt+X → restricted: `b` only) |
| `hover`     | On top     | No change      | Sidebar expanded on hover (allows Alt+X)  |

```
WORKSPACE MODE (normal):
┌─────────────────────────────────────────────────────────────────────┐
│ children[0]: UI Layer        │ children[N]: Workspace Views        │
│ z-order: BEHIND              │ z-order: ON TOP                     │
│ Sidebar visible              │ VS Code receives keyboard input     │
└──────────────────────────────┴─────────────────────────────────────┘

SHORTCUT/DIALOG MODE (overlay):
┌─────────────────────────────────────────────────────────────────────┐
│ children[0..N-1]: Workspace Views (z-order: BEHIND)                 │
├─────────────────────────────────────────────────────────────────────┤
│ children[N]: UI Layer (z-order: ON TOP)                             │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │                  Dialog or Shortcut Overlay                     │ │
│ │              (receives all keyboard/mouse events)               │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Mode Transitions:**

| Trigger              | Mode Change          |
| -------------------- | -------------------- |
| Alt+X pressed        | workspace → shortcut |
| Alt+X pressed        | hover → shortcut     |
| Alt released         | shortcut → workspace |
| Escape pressed       | shortcut → workspace |
| Dialog opens         | any → dialog         |
| Dialog closes        | dialog → workspace   |
| Sidebar hover starts | workspace → hover    |
| Sidebar hover stops  | hover → workspace    |
| Dialog opens (hover) | hover → dialog       |

**Alt+X over a modal (restricted mode):**

Alt+X is never fully blocked. When a modal is open (`isModalOpen()`), Alt+X still
activates but in a **restricted** mode: only the bug-report key (`b`) is forwarded
and the module does **not** broadcast `ui:set-shortcut-active`, so the presenter is
untouched — no overlay, no sidebar badges, no ARIA, no workspace blur, and `mode`
stays `dialog`. This keeps a **bug report reachable in every state**, including over
the startup/setup screens (themselves modal system dialogs) and over ordinary
modals like settings. `isModalOpen()` is read live per key press, so a modal opening
mid-gesture transparently narrows to `b`. With no modal open, Alt+X behaves as
before (full mode, all keys + affordances) — including while hovering the expanded
sidebar. See `shortcut-module.ts`.

**Computation:** mode is derived in main by the presenter, not commanded by the
renderer. The presenter folds it into the `UiState` snapshot as `ui.mode`; the
renderer reads it to drive CSS z-order and focus behavior:

- `workspace`: UI behind workspaces, focus active workspace
- `shortcut`: UI on top, focus UI layer
- `dialog`: UI on top, no focus change (dialog manages its own)
- `hover`: UI on top, no focus change (sidebar hover)

The presenter coalesces snapshot pushes per microtask, so repeated recomputes
that don't change `ui.mode` are naturally collapsed.

## Theming System

CodeHydra uses a CSS custom properties system for theming, with support for both VS Code integration and standalone operation.

### CSS Variable Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CSS THEMING ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  variables.css                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  :root {                                                          │  │
│  │    --ch-foreground: var(--vscode-foreground, #cccccc);            │  │
│  │    --ch-agent-idle: var(--ch-success); /* Reference semantic */   │  │
│  │  }                                                                │  │
│  │  @media (prefers-color-scheme: light) { ... light fallbacks ... } │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│  Components use --ch-* variables exclusively                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  .indicator--idle { background: var(--ch-agent-idle); }           │  │
│  │  .dialog-overlay { background: var(--ch-overlay-bg); }            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Variable Categories

| Category | Variables                                                     | Purpose                  |
| -------- | ------------------------------------------------------------- | ------------------------ |
| Core     | `--ch-foreground`, `--ch-background`                          | Base text and background |
| Border   | `--ch-border`, `--ch-input-border`, `--ch-input-hover-border` | Borders and dividers     |
| Focus    | `--ch-focus-border`                                           | Focus indicators         |
| Semantic | `--ch-success`, `--ch-danger`, `--ch-warning`                 | Status colors            |
| Agent    | `--ch-agent-idle`, `--ch-agent-busy`                          | Agent status (semantic)  |
| Overlay  | `--ch-overlay-bg`, `--ch-shadow`                              | Modals, tooltips         |
| Layout   | `--ch-sidebar-width`, `--ch-dialog-max-width`                 | Sizing (theme-agnostic)  |

### VS Code Variable Fallback Pattern

Variables use `var(--vscode-*, fallback)` for dual-mode operation:

```css
--ch-foreground: var(--vscode-foreground, #cccccc);
```

- **In VSCodium context**: VS Code injects `--vscode-*` variables, which take precedence
- **In standalone mode**: Fallback values are used, controlled by `prefers-color-scheme`

### Light/Dark Theme Switching

Light and dark themes only change fallback values via `@media` query:

```css
:root {
  --ch-foreground: var(--vscode-foreground, #cccccc); /* Dark fallback */
}

@media (prefers-color-scheme: light) {
  :root {
    --ch-foreground: var(--vscode-foreground, #3c3c3c); /* Light fallback */
  }
}
```

This approach means:

- VS Code theme takes precedence when running in VSCodium
- System preference controls standalone appearance
- No JavaScript needed for theme switching
- Layout variables (widths, spacing) are NOT in the media query

## Logging System

The logging system provides comprehensive logging across both main and renderer processes using electron-log.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           LOGGING ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  MAIN PROCESS                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     Logging (interface)                           ││
│  │  - createLogger(name: LoggerName): Logger                               ││
│  │  - initialize(): void  (enables renderer logging via IPC)               ││
│  │                              │                                           ││
│  │                              ▼                                           ││
│  │              ElectronLog (boundary impl)                          ││
│  │  - Wraps electron-log/main                                              ││
│  │  - Configures file path: <app-data>/logs/<datetime>-<uuid>.log          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  RENDERER PROCESS (via IPC)                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  createLogger('ui') → Logger that calls window.api.log.*                ││
│  │                              │                                           ││
│  │                              │ IPC to main                               ││
│  │                              ▼                                           ││
│  │              Logging.createLogger(name).method(msg, context)     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Configuration

Logging is configured through the normal config keys (registered by
`createLoggingModule`), so each one works as a `config.json` entry, an env var,
or a CLI flag — see the Configuration section of CLAUDE.md for the precedence
rules.

| Config key   | Env var          | Values                            | Description              |
| ------------ | ---------------- | --------------------------------- | ------------------------ |
| `log.level`  | `CH_LOG__LEVEL`  | `<level>` or `<level>:<filter>`   | Level, optionally scoped |
| `log.output` | `CH_LOG__OUTPUT` | `file`, `console`, `file,console` | Output destinations      |
| `log.format` | `CH_LOG__FORMAT` | `text`\|`json`                    | Text lines or JSONL      |

Levels, most verbose first: `silly`, `debug`, `info`, `warn`, `error`. The
optional filter is a comma-separated **whitelist** of logger names (or `*` for
all) — naming loggers restricts output to them; it cannot exclude one from an
otherwise unfiltered level. A line that should stay out of a default `debug`
capture therefore belongs at `silly`, not behind a filter.

```bash
CH_LOG__LEVEL=debug CH_LOG__OUTPUT=console pnpm dev   # everything, to stdout
CH_LOG__LEVEL=debug:git,process pnpm dev              # only those two scopes
CH_LOG__LEVEL=silly:presenter pnpm dev                # one scope, maximum detail
```

**Default Levels**:

- Development (isDevelopment=true): `debug` (computed default)
- Production (isDevelopment=false): `warn`

### Ambient Scope

Each line carries the **log scope** of the dispatch it was written for (see INTENTS.md, Log scope) without its caller passing anything: `ElectronLog` owns a `LogScopeStore` (`log-scope.ts`, over `AsyncLocalStorage`) that the dispatcher writes and every logger reads at write time. A line buffered before `configure()` keeps the scope it was written in.

- **Text** — a positional block after the logger name, empty parts left out; a project without a workspace keeps its slash:

  ```
  [..] [debug] (git) [7f3a01 codehydra/ws-logs workspace:switch@git-worktree/create shortcut] ListBranches …
  [..] [info]  (dispatcher) [9c2144 codehydra/ project:resolve ui] dispatch parent=7f3a01 causation=…
  ```

  `caller`/`api` are not in the block; they are on the dispatch line where they enter the tree.

- **JSON** — `scope` is an object: `{"logger":"git","trace":"7f3a01","intent":…,"project":…,"ws":…,"path":…,"origin":…,"caller":…,"api":…,"module":…,"hook":…}`.

- **A line's own path goes in its scope, never its context.** A call site that knows which workspace, file or directory a line is about says so with `logger.scoped({ path })` — held for life by an object that belongs to one workspace (the agent providers), made inline for a one-off line. It is resolved at write time against a path→name index the store keeps, filled by the dispatcher whenever a resolve step names a workspace with its path (`setLogTarget`): the workspace itself shows as `project/ws` and writes no `path=`; a path inside one shows that workspace plus `path=` relative to it; any other path is written in full and the line claims **no** workspace — not even the ambient one, which may be another workspace's (a callback inheriting a foreign frame). So `workspacePath=`/`workspace=` context keys do not exist any more; `path=` in a line is always what is left after that resolution.
- `scope.*` is reserved: `LogContext` rejects such keys by type, and `toLogContext` drops them from runtime records (extension-sent context).
- Extension logs (`api:log`) arrive outside any dispatch; each sidekick connection's logger is `extensionLogger.scoped({ path: <its workspace>, origin: "sidekick" })`. Renderer lines are unscoped.
- **A workspace's lines in its IDE.** `Logging.onLine(listener)` sees every line — level, logger, scope, message, context — before the file's level and logger filters. The workspace-log module (`workspace-log-module.ts`) forwards each debug-and-up line whose scope names a workspace to that IDE's **CodeHydra Log** channel (`ui:appendOutput` with `log: true`, levelled lines → a VS Code `LogOutputChannel`, whose own level decides what is kept). Held by name until a line brings the workspace's path, then by `createWorkspaceOutput` (`workspace-output.ts`, shared with the hook-output sink): batched per tick, up to 1000 lines while the IDE is away, flushed on connect, dropped on deletion. A line listener must never log — its line would come back.
- Test loggers (`createMockLogger`, `createBehavioralLogger`) fold a `scoped` hint into the line's context as `scope.path`/`scope.origin`, so a test asserts it like any context key. Spreading `SILENT_LOGGER` into a spy logger loses scoped lines (its `scoped` is silent) — use `createMockLogger()`.

### Logger Names/Scopes

| Logger        | Module                    | Description                           |
| ------------- | ------------------------- | ------------------------------------- |
| `[badge]`     | BadgeManager              | App icon badge updates                |
| `[process]`   | LoggingProcessRunner      | Spawned processes, stdout/stderr      |
| `[network]`   | DefaultNetworkLayer       | HTTP fetch, port operations           |
| `[fs]`        | DefaultFileSystemBoundary | File read/write operations            |
| `[git]`       | SimpleGitClient           | Git commands                          |
| `[opencode]`  | OpenCodeClient            | OpenCode SSE connections              |
| `[pidtree]`   | PidtreeProvider           | Process tree lookups                  |
| `[plugins]`   | PluginModule              | Plugins: hooks, automations, runner   |
| `[api]`       | IPC Handlers              | API request/response timing           |
| `[window]`    | WindowManager             | Window create/resize/close            |
| `[view]`      | ViewManager               | View lifecycle, mode changes          |
| `[app]`       | Application Lifecycle     | Bootstrap, startup, shutdown          |
| `[ui]`        | Renderer Components       | Dialog events, user actions           |
| `[extension]` | ApiServer                 | Extension-side logs forwarded to main |
| `[presenter]` | PresentationModule        | ui:event intake, ui:state pushes      |

(An abridged list — CLAUDE.md carries the full set of `LoggerName` values.)

### Payload Size

A log line's context must be bounded by something small. Anything that scales
with user data — a git branch list, a file's contents, a screenshot, an SDK
response — belongs in the log as a size, an id, or a count, not verbatim.
`FileSystemBoundary.writeFileBuffer` is the pattern: it logs `size`, never
`content`.

The file rotates at 20 MB and bug reports ship a gzipped tail of it, so an
unbounded line does not merely bloat the log — it evicts the context a report
is read for. Payloads also leave the machine: bug reports attach the log, so a
line that dumps a dialog's render model or a screenshot is exfiltrating what it
renders.

`[presenter]` logs each `ui:state` push at two fidelities:

| Level   | Context key | Content                                                                                                                                              |
| ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug` | `state`     | Bounded projection: frames as keys, dialogs as `id` + `kind`, a hibernated `main.screenshot` as its length. Rows, notifications, and flags verbatim. |
| `silly` | `snapshot`  | The verbatim snapshot, unbounded.                                                                                                                    |

The projection is built from a mapped type over `UiState`, so a new field is a
compile error until it is deliberately projected. Both lines fire at `silly`.

### Log File Location

| Environment | Path                                                           |
| ----------- | -------------------------------------------------------------- |
| Development | `./app-data/logs/2025-12-16T10-30-00-abc123.log`               |
| Linux       | `~/.local/share/codehydra/logs/2025-12-16T10-30-00-abc123.log` |
| macOS       | `~/Library/Application Support/Codehydra/logs/...`             |
| Windows     | `%LOCALAPPDATA%\Codehydra\logs\...`                            |

### Usage in Services

Services receive a Logger via constructor injection (required parameter):

```typescript
class IdeServerModule {
  constructor(
    config: IdeServerConfig,
    processRunner: ProcessRunner,
    httpClient: HttpClient,
    portManager: PortManager,
    logger: Logger // Required
  ) {
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.logger.info("Starting the IDE server");
    // ...
    this.logger.info("Started", { port, pid });
  }
}
```

### Usage in Renderer

Renderer components use `createLogger` from `$lib/logging`:

```svelte
<script lang="ts">
  import { createLogger } from "$lib/logging";

  const logger = createLogger("ui");

  function handleDialogOpen() {
    logger.debug("Dialog opened", { type: "create-workspace" });
  }

  function handleSubmit() {
    try {
      // ...
      logger.debug("Dialog submitted", { type: "create-workspace" });
    } catch (error) {
      logger.warn("UI error", { component: "Dialog", error: error.message });
    }
  }
</script>
```

**Svelte 5 Guidance**: Call logger methods in event handlers and lifecycle hooks (`onMount`, `onDestroy`), NOT inside `$effect()` or `$derived()` runes.

## Agent Integration

The agent integration layer provides real-time agent status monitoring for AI agents running in each workspace. Currently supports OpenCode and Claude Code with extensible architecture for future agent types.

### Agent Abstraction Layer

The agent abstraction layer (`src/agents/`) defines interfaces for pluggable agent implementations:

| Interface            | Purpose                                     | Scope                    |
| -------------------- | ------------------------------------------- | ------------------------ |
| `AgentSetupInfo`     | Binary distribution, config file generation | Singleton per type       |
| `AgentServerManager` | Server lifecycle (start, stop, restart)     | Shared across workspaces |
| `AgentProvider`      | Connection and status tracking              | One per workspace        |

**Agent status types:** `"none"` | `"idle"` | `"busy"`

For detailed agent system documentation including provider interface, status tracking, MCP integration, and implementation guide, see [AGENTS.md](AGENTS.md).

### IPC Channels

| Channel                  | Type    | Payload                             | Description                       |
| ------------------------ | ------- | ----------------------------------- | --------------------------------- |
| `agent:status-changed`   | Event   | `{ workspacePath, status, counts }` | Status update for workspace       |
| `agent:get-status`       | Command | `{ workspacePath: string }`         | Get status for specific workspace |
| `agent:get-all-statuses` | Command | `void`                              | Get all workspace statuses        |
| `agent:refresh`          | Command | `void`                              | Trigger immediate scan            |

## API Server Interface

CodeHydra and VS Code extensions communicate via Socket.IO WebSocket connection. The protocol supports bidirectional communication:

- **Server → Client**: CodeHydra sends VS Code commands to extensions
- **Client → Server**: Extensions call CodeHydra API methods

### Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      CodeHydra (Electron Main)                            │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  ApiServer                                                       │  │
│  │                                                                     │  │
│  │  connections: Map<workspacePath, Socket>                            │  │
│  │                                                                     │  │
│  │  Server → Client:                                                   │  │
│  │  ───► "command" (execute VS Code commands)                          │  │
│  │                                                                     │  │
│  │  Client → Server:                                                   │  │
│  │  ◄─── "api:workspace:getStatus" → ApiResult<WorkspaceStatus>     │  │
│  │  ◄─── "api:workspace:getMetadata" → ApiResult<Record<...>>       │  │
│  │  ◄─── "api:workspace:setMetadata" → ApiResult<void>              │  │
│  │  ◄─── "api:log" → (fire-and-forget, no response)                    │  │
│  │                                                                     │  │
│  │  API handlers registered via onApiCall() callback pattern           │  │
│  │  (ApiServer remains agnostic to API layer)                       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                           ▲                               │
│                                           │ api-server-module adds     │
│                                           │ handlers during app:start     │
│  ┌────────────────────────────────────────┴────────────────────────────┐  │
│  │  createApiServerModule() - src/modules/api-server-module.ts   │  │
│  │                                                                     │  │
│  │  Workspace path resolution:                                         │  │
│  │  1. appState.findProjectForWorkspace(workspacePath)                 │  │
│  │  2. generateProjectId(project.path)                                 │  │
│  │  3. path.basename(workspacePath) as WorkspaceName                   │  │
│  │  4. If not found → return { success: false, error: "..." }          │  │
│  │                                                                     │  │
│  │  Dispatches intents via Dispatcher after resolution                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
                    │ WebSocket (localhost only)
                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    codehydra extension (VSCodium)                         │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  extension.js                                                       │  │
│  │                                                                     │  │
│  │  // Socket.IO client                                                │  │
│  │  socket.on("command", handler)           // inbound: execute cmd    │  │
│  │  socket.emit("api:workspace:...", ack)   // outbound: API calls     │  │
│  │                                                                     │  │
│  │  // Connection state management                                     │  │
│  │  let connected = false;                                             │  │
│  │  let pendingReady = [];  // queue for whenReady()                   │  │
│  │                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  exports.codehydra = {                                              │  │
│  │    whenReady(): Promise<void>             // resolves when connected│  │
│  │    log: {                                                           │  │
│  │      silly/debug/info/warn/error(msg, ctx?) → fire-and-forget      │  │
│  │    }                                                                │  │
│  │    workspace: {                                                     │  │
│  │      getStatus(): Promise<WorkspaceStatus>                          │  │
│  │      getMetadata(): Promise<Record<string, string>>                 │  │
│  │      setMetadata(key, value): Promise<void>                         │  │
│  │    }                                                                │  │
│  │  }                                                                  │  │
│  │                                                                     │  │
│  │  Error handling: Returns rejected Promise with clear message        │  │
│  │  (matches ApiResult pattern - no throwing)                       │  │
│  │                                                                     │  │
│  │  Timeout: 10s (matches COMMAND_TIMEOUT_MS)                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
                    │
                    │ vscode.extensions.getExtension()
                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    Third-party extension                                  │
│                                                                           │
│  const ext = vscode.extensions.getExtension('codehydra.sidekick');        │
│  const api = ext?.exports?.codehydra;                                     │
│  if (!api) throw new Error('codehydra extension not available');          │
│                                                                           │
│  await api.whenReady();  // wait for connection                           │
│  const status = await api.workspace.getStatus();                          │
│  const metadata = await api.workspace.getMetadata();                      │
│  await api.workspace.setMetadata('note', 'Working on feature X');         │
└───────────────────────────────────────────────────────────────────────────┘
```

### Protocol Messages

**Server → Client (Commands):**

| Event     | Payload          | Response             | Description             |
| --------- | ---------------- | -------------------- | ----------------------- |
| `command` | `CommandRequest` | `ApiResult<unknown>` | Execute VS Code command |

**Client → Server (API Calls):**

| Event                          | Payload                  | Response                           | Description                       |
| ------------------------------ | ------------------------ | ---------------------------------- | --------------------------------- |
| `api:workspace:getStatus`      | (none)                   | `ApiResult<WorkspaceStatus>`       | Get workspace dirty/agent status  |
| `api:workspace:getMetadata`    | (none)                   | `ApiResult<Record<string,string>>` | Get all workspace metadata        |
| `api:workspace:setMetadata`    | `SetMetadataRequest`     | `ApiResult<void>`                  | Set or delete metadata key        |
| `api:workspace:executeCommand` | `ExecuteCommandRequest`  | `ApiResult<unknown>`               | Execute a VS Code command         |
| `api:workspace:create`         | `WorkspaceCreateRequest` | `ApiResult<Workspace>`             | Create a new workspace in project |

**Types:**

```typescript
interface CommandRequest {
  readonly command: string;
  readonly args?: readonly unknown[];
}

interface SetMetadataRequest {
  readonly key: string; // Must match /^[A-Za-z][A-Za-z0-9-]*$/
  readonly value: string | null; // null deletes the key
}

type ApiResult<T> = { success: true; data: T } | { success: false; error: string };
```

### Connection Lifecycle

1. **ApiServer starts** on dynamic port in main process
2. **The IDE server spawns** with `_CH_API_PORT` env var
3. **Extension activates** and reads env var
4. **Extension connects** with `auth: { workspacePath }` (normalized path)
5. **Server validates** auth and stores connection by normalized path
6. **Bidirectional communication** begins with acknowledgment callbacks

### API Wiring

The CodeHydra API connects ApiServer to the intent dispatcher via MCP handlers that dispatch intents directly:

```typescript
// MCP handlers dispatch intents directly through the Dispatcher
function createMcpHandlers(dispatcher: Dispatcher, apiServer: ApiServer) {
  return {
    getStatus: async (workspacePath) => {
      // 1. Resolve workspace path
      // 2. Dispatch workspace:getStatus intent
      // 3. Return result
    },
    getMetadata: async (workspacePath) => {
      /* similar — dispatches workspace:getMetadata intent */
    },
    setMetadata: async (workspacePath, key, value) => {
      /* similar — dispatches workspace:setMetadata intent */
    },
  };
}
```

### Error Handling

- **Unknown workspace**: Returns `{ success: false, error: "Workspace not found" }`
- **Invalid metadata key**: Returns `{ success: false, error: "Invalid key format" }`
- **API exceptions**: Caught and mapped to `{ success: false, error: message }`
- **Timeout**: 10 seconds per request (client-side)

### Type Declarations for Third-Party Extensions

TypeScript declarations for the API are in:
`extensions/sidekick/api.d.ts`

Third-party extension developers should copy this file into their project for type safety.

## External URL Handling

All URLs opened from VSCodium → external system browser:

- Implemented via `setWindowOpenHandler` returning `{ action: 'deny' }`
- Platform-specific: `xdg-open` (Linux), `open` (macOS), `start` (Windows)

## Binary Distribution

CodeHydra downloads its binaries instead of bundling them: VSCodium (reh-web) always, and an agent only when it is not installed on the system. All downloads go through `src/utils/binary-download` (`downloadBinary`: an archive to extract, or — no `archiveExtension` — a single executable saved as `destDir/executablePath` under a temp name and renamed; an optional `sha256` is checked before anything is written; `destDir` is removed on failure) over `HttpClient`, `FileSystemBoundary` and `ArchiveExtractor`.

### Agent binaries

`binary-resolver.ts` (`createAgentBinaryResolver`) decides which executable an agent runs, the same way for Claude and OpenCode:

1. `version.<agent>` set → that version under `<bundles>/<agent>/<version>/`, downloaded if missing. A channel word (`latest`/`stable` for Claude, `latest` for OpenCode) is resolved to a version first. Beats a system install.
2. Otherwise the first `<agent>` on the app's PATH whose `--version` exits 0 (Windows also probes the npm `.cmd` shim, spawned through a shell).
3. Otherwise the agent's default channel (Claude `stable`, OpenCode `latest`).

Nothing is recorded: the version directories are the record ("installed" = the directory holds the executable). A channel is re-resolved at every start (`prepare()`, memoized per launch after it succeeds). A failed lookup falls back to the newest downloaded version; a newer version than the one downloaded starts a background download, and `current()` switches once it lands, so workspaces launched afterwards run it. `bundleVersionsInUse()` feeds the cleanup `bundle` rule (in use + in flight; null until resolved).

Each workspace snapshots `current()` at `startWorkspace` and passes it on: Claude's terminal gets `_CH_CLAUDE_BIN` (plus `DISABLE_AUTOUPDATER=1` for a download), OpenCode's server is spawned with it (kept per workspace for restarts; `autoupdate: false` for a download) and its terminal gets `_CH_OPENCODE_BIN`. The wrappers run that path and never search PATH themselves.

Download coordinates live in each agent's `setup-info.ts`:

| Agent    | Channel lookup                                                          | Download                                                                                         |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude   | `downloads.claude.ai/claude-code-releases/<channel>` (a version string) | `<version>/manifest.json` → `<version>/<platform>-<arch>/claude[.exe]`, raw file, sha256-checked |
| OpenCode | where `github.com/anomalyco/opencode/releases/latest` redirects         | `releases/download/v<version>/opencode-<os>-<arch>.{tar.gz,zip}`, extracted, no checksum         |

Claude's manifest also lists musl builds; they are unused, since Electron itself needs glibc. Windows builds are x64 only (`assertWindowsX64`).

### VSCodium

`VSCODIUM_VERSION` (`src/modules/ide-server-module/vscodium.ts`, overridable by `version.vscodium`) pins the IDE server; the setup screen downloads it on first start.

### Development, CI and `--download-binaries`

Nothing is downloaded at `pnpm install`: the first `pnpm dev` downloads like a production first start, and the boundary project fetches the latest OpenCode once per run in its globalSetup (`src/test/global-setup-boundary.ts`, via `ensureBinaryForTests` in `src/utils/testing/ensure-binaries.ts`), so parallel test files never extract into the same bundle directory. `codehydra --download-binaries` (a boolean config key, handled in `main.ts` before `app:start`, `src/modules/download-binaries.ts`) downloads VSCodium and both agents — the configured version, else the default channel, whatever is installed — then exits; the e2e `download-binaries` project seeds its root with it.

**Windows Note**: VSCodium publishes an official reh-web build for every platform CodeHydra targets, including Windows x64, so Windows is a first-class path with no special per-platform build step.

## VS Code Setup

### Startup Flow with Preflight

The application uses a preflight phase to detect what needs installation, enabling selective setup:

```
app.whenReady()
       │
       ▼
  regenerateWrapperScripts()   # Always regenerate (cheap, ~1ms)
       │
       ▼
  preflight()                  # Check what's installed
       │
       ├─► missingBinaries?    # vscodium/<version>/ exists?
       ├─► missingExtensions?  # Extension directories exist?
       ├─► outdatedExtensions? # Bundled extension version matches?
       └─► markerValid?        # .setup-completed with schemaVersion 1?
       │
       ▼
  needsSetup?  ──NO──►  Normal startup (services start immediately)
       │ YES
       ▼
  Show SetupScreen     # Blocking UI with progress bar
       │
       ▼
  validateAssets()     # Check manifest.json exists
       │
       ▼
  Run SELECTIVE setup:
  1. downloadBinaries()      # Only download missing binaries
  2. cleanExtensions()       # Remove outdated extensions only
  3. installExtensions()     # Only install missing/outdated extensions
  4. setupBinDirectory()     # Create CLI wrapper scripts in bin/
  5. writeCompletionMarker() # .setup-completed (schemaVersion: 1)
       │
       ▼
  On success: Show "Setup complete!" (1.5s) → Continue to normal startup
  On failure: Show error with Retry/Quit buttons
```

**Key behaviors:**

- **Wrapper scripts regenerated on EVERY startup**: Cheap operation ensures scripts always match current binary versions
- **Preflight is read-only**: Only checks filesystem, no network calls
- **Selective setup**: Only installs what's missing/outdated based on preflight results
- **No full clean**: `cleanVscodeDir()` is NOT called; only specific outdated extensions are removed

### Asset Files

VS Code extension sources are stored in the `extensions/` directory at the project root:

```
extensions/
├── external.json              # External extension IDs and versions (downloaded at build time)
├── README.md                  # Documentation for adding extensions
└── sidekick/                  # Custom extension source
    ├── package.json
    ├── extension.js
    └── api.d.ts
```

### Build Process

1. `pnpm build:extensions` - auto-discovers extension folders, packages them to `dist/extensions/`, downloads external extensions from VS Code Marketplace, and generates `manifest.json` (flat array of all extensions)
2. `vite-plugin-static-copy` - copies `dist/extensions/*` to `out/main/assets/` during build
3. `pnpm build` - runs both steps sequentially

**Note:** External extensions are downloaded during the build process, not at runtime. This ensures reproducible builds and eliminates runtime network dependencies for extension installation.

### Distribution Build

The `dist/` directory contains both intermediate build artifacts and final distributables:

```
dist/
├── extensions/                # Extension builds (intermediate, copied to out/main/assets/)
│   ├── codehydra-sidekick-*.vsix
│   └── extensions.json
├── win-unpacked/              # Unpacked Windows app (for debugging)
├── linux-unpacked/            # Unpacked Linux app (for debugging)
├── CodeHydra-0.1.0.exe        # Windows portable executable
└── CodeHydra-0.1.0.AppImage   # Linux AppImage
```

**Distribution commands:**

| Command           | Platform   | Output                          |
| ----------------- | ---------- | ------------------------------- |
| `pnpm dist`       | Current OS | Platform-specific distributable |
| `pnpm dist:win`   | Windows    | `dist/CodeHydra-x.x.x.exe`      |
| `pnpm dist:linux` | Linux      | `dist/CodeHydra-x.x.x.AppImage` |

**Note:** Cross-platform builds have limitations - Windows portable can only be built on Windows, Linux AppImage can only be built on Linux.

### Runtime Asset Resolution

```
out/main/assets/ (ASAR in prod)
    │
    └─► *.vsix ──► <app-data>/vscode/ ──► node out/server-main.js --install-extension
```

- `PathProvider.vscodeAssetsDir` resolves to `<appPath>/out/main/assets/`
- Node.js `fs` module reads transparently from ASAR in production
- Files are copied to app-data before use (external processes can't read ASAR)

### Directory Structure

```
<app-data>/
├── .setup-completed               # JSON: { schemaVersion: 1, completedAt: "ISO" }
├── bin/                           # CLI wrapper scripts (regenerated every startup)
│   ├── code (code.cmd)            # VS Code CLI wrapper
│   └── opencode (opencode.cmd)    # OpenCode wrapper (redirects to versioned binary)
├── vscodium/
│   └── <version>/                 # e.g., 1.126.04524/
│       ├── node[.exe]             # Bundled Node.js — what we spawn
│       ├── out/server-main.js     # Server entry point
│       ├── bin/codium-server[.cmd]  # Launcher wrapper (unused; see IdeServer.entryArgs)
│       └── bin/remote-cli/codium[.cmd]  # Terminal `code` CLI target
├── opencode/
│   └── <version>/                 # e.g., 0.1.47/
│       └── opencode[.exe]         # Actual opencode binary
├── vscode/
│   ├── sidekick-0.0.3.vsix     # Copied from assets for installation
│   ├── extensions/
│   │   ├── codehydra.sidekick-0.0.1/  # Installed by VSCodium
│   │   └── sst-dev.opencode-X.X.X/    # Installed by VSCodium
│   └── user-data/
│       └── User/
│           ├── settings.json      # Copied from assets
│           └── keybindings.json   # Copied from assets
├── runtime/                       # VSCodium runtime files
└── projects/                      # Git worktrees
```

### Setup Versioning

The setup system uses a **preflight-based approach** instead of a single version number. On every startup:

1. **Preflight checks** detect what's missing/outdated:
   - Binary versions (vscodium, opencode directories exist?)
   - Extension versions (each extension in manifest.json array must match installed version)
   - Marker validity (has `schemaVersion: 1`?)

2. **Selective setup** runs only for components that need installation

The `.setup-completed` marker uses `schemaVersion` (not `version`) to track marker format changes:

```json
{
  "schemaVersion": 1,
  "completedAt": "2025-12-23T10:30:00.000Z"
}
```

**When `schemaVersion` changes**: Only for marker format/preflight architecture changes.
**When binary/extension versions change**: Preflight detects missing components automatically; no marker change needed.

### Codehydra Extension

The custom codehydra extension (packaged as `.vsix` at build time) runs on VS Code startup to:

1. Close sidebars to maximize editor space
2. Open OpenCode terminal automatically
3. Clean up empty editor groups

This provides an optimized layout for AI agent workflows.

### CLI Wrapper Scripts

During VS Code setup, CLI wrapper scripts are generated in `<app-data>/bin/`. These scripts enable command-line tools to work in the integrated terminal.

**Generated Scripts:**

| Script                      | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `code` / `code.cmd`         | VS Code CLI (VSCodium's remote-cli)                         |
| `opencode` / `opencode.cmd` | Redirects to `<app-data>/opencode/<version>/opencode[.exe]` |

**Note**: The IDE server is launched directly via its absolute binary path (resolved from the `IdeServer` descriptor), not via a wrapper script.

**Environment Configuration (in the IDE server module):**

When spawning the IDE server, the module modifies the environment:

1. **PATH prepend**: `<app-data>/bin/` is prepended to PATH
2. **EDITOR**: Set to `<binDir>/code --wait --reuse-window`
3. **GIT_SEQUENCE_EDITOR**: Set to same value as EDITOR

**Script Generation (in VscodeSetupService):**

```
setupBinDirectory()
    │
    ├── mkdir bin/
    ├── resolveTargetPaths() → { codeRemoteCli, ideServerBinary, opencodeBinary }
    ├── generateScripts(platformInfo, targetPaths) → GeneratedScript[]
    └── for each script:
        ├── writeFile(binDir + filename, content)
        └── if needsExecutable: makeExecutable(path) [Unix only]
```

**Git Integration:**

With EDITOR configured, git operations open in VSCodium:

- `git commit` - Opens commit message editor
- `git rebase -i` - Opens interactive rebase editor
- Any tool respecting `$EDITOR`

## Keyboard Capture System

CodeHydra uses a **unified main-process keyboard capture system** where all shortcut detection happens in the main process.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Main Process — capture: shortcut-module                                  │
│  ├─ Registers before-input-event on ALL WebViews (workspace + UI)       │
│  ├─ Alt+X → dispatch set-shortcut-active (skipped if isModalOpen:       │
│  │    restricted mode, only "b" forwarded, no broadcast)                │
│  ├─ Action keys while active → dispatch shortcut:key                    │
│  └─ Alt release / Escape / blur → dispatch set-shortcut-active(false)   │
├─────────────────────────────────────────────────────────────────────────┤
│ Main Process — interpret: presenter                                      │
│  ├─ shortcut:active → recompute ui.mode (shortcut > dialog > hover > …)  │
│  └─ shortcut:key → navigate / jump / dialog action against its model,   │
│      updating the snapshot or dispatching the matching intent           │
├─────────────────────────────────────────────────────────────────────────┤
│ Renderer: pure render of the snapshot                                    │
│  └─ reads ui.mode → ShortcutOverlay visibility + CSS z-order            │
│      (no action execution, no setMode round trip)                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Detection Flow

| User Action            | Main Process                             | Renderer (from snapshot)                 |
| ---------------------- | ---------------------------------------- | ---------------------------------------- |
| Alt+X pressed          | dispatch `set-shortcut-active(true)`     | overlay shows (`ui.mode === "shortcut"`) |
| Action key (↑↓0-9 etc) | dispatch `shortcut:key` → presenter acts | row/active reflect the new snapshot      |
| Escape / Alt released  | dispatch `set-shortcut-active(false)`    | overlay hides                            |

### ShortcutController State Machine

```
                              ┌──────────┐
              ┌───────────────│  NORMAL  │◄────────────────────────────────┐
              │               └────┬─────┘                                 │
              │                    │                                       │
              │ Alt up             │ Alt down                              │
              │ (suppress)         │ (preventDefault)                      │
              │                    ▼                                       │
              │            ┌─────────────┐                                 │
              │            │ ALT_WAITING │                                 │
              │            └──────┬──────┘                                 │
              │                   │                                        │
              │     ┌─────────────┼─────────────┐                          │
              │     │             │             │                          │
              │  Alt up      non-X key       X down                        │
              │  (suppress)  (let through)      │                          │
              │     │             │             ▼                          │
              │     │             │      • preventDefault                  │
              │     │             │      • dispatch set-shortcut-active    │
              │     │             │      • focusUI()                       │
              │     │             │             │                          │
              └─────┴─────────────┴─────────────┘                          │
                                                                           │
              Main process returns to NORMAL, UI has focus ────────────────┘
```

**While in shortcut mode**, action keys (↑↓Enter Delete O 0-9) are captured and dispatched as `shortcut:key` domain events that the presenter interprets. Unknown keys pass through to the focused view.

### Key Files

| File                                              | Purpose                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `src/modules/shortcut-module.ts`                  | Main-process key capture (before-input-event) → shortcut intents |
| `src/modules/presentation/presentation-module.ts` | Interprets shortcut events; computes `ui.mode`                   |
| `src/renderer/App.svelte`                         | Reads `ui.mode` from the snapshot; renders overlay/z-order       |

### Design Decisions

1. **Main owns detection AND interpretation**: capture (shortcut-module) and navigation/mode (presenter) both live in main — no renderer shortcut logic, eliminating focus/key races.
2. **Mode is computed, not commanded**: the presenter derives `ui.mode` from its own state and ships it in the snapshot; the renderer never sets mode.
3. **Alt+X over a modal**: `isModalOpen()` doesn't block Alt+X — it downgrades it to restricted mode (only the bug-report key `b` forwarded, no `set-shortcut-active` broadcast), so a bug report stays reachable over any modal / the startup screens without lighting up the overlay or trapping focus.
4. **Coalesced pushes**: snapshot pushes batch per microtask, so mode recomputes that don't change anything are collapsed.

## Data Flow

### Opening a Project

```
User: Click "Open Project"
  → System folder picker
  → IPC: api:project:open → project:open intent dispatched (payload.initial = true)
  → OpenProjectOperation runs "prepare" hook point (local paths only):
      → LocalProjectModule: offer git init for a non-repo directory
      → GitWorktreeWorkspaceModule: offer the repo's unmanaged worktrees for
        adoption (only when payload.initial — startup restore and automation
        re-run this same intent and must not raise a dialog). Cancel aborts the add.
  → OpenProjectOperation runs "open" hook point:
      → LocalProjectModule: validate git repository, discover worktrees
      → (or RemoteProjectModule: clone from URL)
  → Operation dispatches workspace:open per discovered worktree
  → Sets first workspace as active
  → Emits project:opened domain event → UiIpcModule → sendToUI → Renderer
  → If 0 worktrees: auto-open create dialog
  → If 1+ worktrees: activate first workspace
```

### Switching Workspaces

```
User: Click workspace (or keyboard shortcut)
  → IPC: api:workspace:switch → workspace:switch intent dispatched
  → SwitchWorkspaceOperation runs "activate" hook:
      → ViewModule: attach target view, set bounds, detach previous view
  → Emits workspace:switched domain event → UiIpcModule → sendToUI → Renderer
```

### Creating a Workspace

```
User: Click [+], fill dialog, click OK
  → Validate name (frontend)
      → If invalid: show error, stay in dialog
      → If valid: continue
  → IPC: api:workspace:create → workspace:open intent dispatched
  → OpenWorkspaceOperation runs hook points:
      → "create": GitWorktreeWorkspaceModule creates git worktree
      → "provision": PluginModule runs the plugins' after-worktree-created
      → "prepare": PluginModule runs the plugins' before-workspace-opened
                   (its env goes to the agent and the editor's terminals)
      → "setup": AgentModule starts agent server (with that env)
      → "finalize": IdeServerModule creates .code-workspace file
  → Operation dispatches workspace:switch to activate the new workspace
  → Emits workspace:created domain event → UiIpcModule → sendToUI → Renderer
```

### Closing a Project

```
User: Click [x] on project row
  → IPC: api:project:close → project:close intent dispatched
  → CloseProjectOperation:
      → Dispatches workspace:delete { removeWorktree: false } per workspace (runtime teardown)
      → Runs "close" hook point:
          → LocalProjectModule: dispose provider; delete the project's own
            directory if removeLocalRepo and the project has no remoteUrl
          → (or RemoteProjectModule: delete cloned dir if removeLocalRepo)
      → Emits project:closed domain event → UiIpcModule → sendToUI → Renderer
  (NO files or git data deleted unless removeLocalRepo is true; that flag
   implies removeAll, so the per-workspace deletes become full worktree
   deletions, and a non-interactive dispatch is refused while workspaces exist)
```

## IPC Contract

All IPC channels are defined in `src/shared/ipc.ts` with TypeScript types for compile-time safety.

**Architecture Note**: IPC handlers in `UiIpcModule` create typed intents and dispatch them through the Dispatcher. They only perform input validation and intent construction -- all business logic lives in operations and hook modules. See [Intent-Based Architecture](#intent-based-architecture) for details.

### Commands (renderer → main)

| Channel                           | Payload                             | Response            | Description                                    |
| --------------------------------- | ----------------------------------- | ------------------- | ---------------------------------------------- |
| `api:project:open`                | `{ path: string }`                  | `Project`           | Open project, discover workspaces              |
| `api:project:close`               | `{ projectId, removeLocalRepo? }`   | `void`              | Close project, optionally delete its directory |
| `project:list`                    | `void`                              | `Project[]`         | List all open projects                         |
| `project:select-folder`           | `void`                              | `string \| null`    | Show folder picker dialog                      |
| `workspace:create`                | `{ projectPath, name, baseBranch }` | `Workspace`         | Create workspace, create view                  |
| `workspace:remove`                | `{ workspacePath, deleteBranch }`   | `RemovalResult`     | Remove workspace, destroy view                 |
| `workspace:switch`                | `{ workspacePath }`                 | `void`              | Switch active workspace                        |
| `workspace:list-bases`            | `{ projectPath }`                   | `BaseInfo[]`        | List available branches                        |
| `workspace:update-bases`          | `{ projectPath }`                   | `UpdateBasesResult` | Fetch from remotes                             |
| `workspace:is-dirty`              | `{ workspacePath }`                 | `boolean`           | Check for uncommitted changes                  |
| `api:workspace:get-opencode-port` | `{ projectId, workspaceName }`      | `number \| null`    | Get OpenCode server port                       |
| `ui:set-dialog-mode`              | `{ isOpen: boolean }`               | `void`              | Swap UI layer z-order                          |
| `ui:focus-active-workspace`       | `void`                              | `void`              | Return focus to VS Code                        |

### Events (main → renderer)

| Channel              | Payload                                          | Description                               |
| -------------------- | ------------------------------------------------ | ----------------------------------------- |
| `project:opened`     | `{ project: Project }`                           | Project was opened                        |
| `project:closed`     | `{ path: string }`                               | Project was closed                        |
| `workspace:created`  | `{ projectPath: string, workspace: Workspace }`  | Workspace was created                     |
| `workspace:removed`  | `{ projectPath: string, workspacePath: string }` | Workspace was removed                     |
| `workspace:switched` | `{ workspacePath: string }`                      | Active workspace changed                  |
| `shortcut:enable`    | `void`                                           | Shortcut mode activated                   |
| `shortcut:disable`   | `void`                                           | Shortcut mode deactivated (race recovery) |

**Note**: `shortcut:enable` and `shortcut:disable` are defined as channel constants but are not typed in the `IpcEvents` interface (they use simple void payloads).

### IPC Data Flow

```
┌─────────────┐  IPC invoke   ┌────────────────┐  dispatch   ┌────────────┐  hooks   ┌──────────┐
│  Renderer   │ ────────────► │ UiIpcModule │ ─────────► │ Dispatcher │ ───────► │ Modules  │
│  (Svelte)   │               │ (intent+IPC)   │            │ +Operation │          │(services)│
│             │ ◄──────────── │                │ ◄────────── │            │ ◄─────── │          │
└─────────────┘  IPC events/   └────────────────┘  domain     └────────────┘  results └──────────┘
                 response       (sendToUI)         events
```
