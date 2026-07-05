# Remote & Container Workspaces via a Federated Dispatcher

Status: **design / exploration** (not yet approved for implementation)

Goal: let users create workspaces on a **remote machine (SSH-first)** and, later,
in **containers** — surfaced in the create-workspace dialog as a target selection
(image starts a new container / running container / remote machine).

---

## 1. Goal & scope (decided)

- **Remote machine over SSH first**, extensible to containers.
- **Both agents** (Claude + OpenCode) supported from the start.
- **Projects live on the remote** — managed (CodeHydra clones the repo) *or* an
  existing checkout already on the remote, mirroring today's local behavior.
  - Rationale: git worktrees require the parent repo on the same filesystem, so a
    remote **workspace** implies a remote **project**.
- **Dialog change is cheap:** the target selector (image/container/remote) is a
  `radio` section added in `creation-module` `buildConfig()` plus one optional
  field on `OpenWorkspacePayload` — **no Svelte and no IPC-channel changes**.

> ⚠️ Requires explicit approval per CLAUDE.md before implementing: (a) the
> `OpenWorkspacePayload` / intent-contract change, and (b) any **new boundary
> interface** introduced for the transport.

---

## 2. Architecture (converged): intent-seam federation, single host dispatcher

Keep **one dispatcher, on the host**, as the sole orchestrator — ordering,
capability merging, causation, and event emission all stay in-process on the host.
Remote **modules** register their handlers into that dispatcher; a remote handler
executes against the remote machine's own native boundaries (fs/process/git/port)
in a small module-host process.

Why this seam (vs. a "boundary-seam" that swaps fs/process/git per-call over SSH):
the wire sits at a **coarse, serializable, already-mostly-data layer** (intents,
events, hook results) instead of hundreds of fine-grained syscalls per workspace.

### Module registration
- **Static proxy, version-locked** to start: the host knows the module set at build
  time; a host-side proxy forwards to the remote; connection state is just up/down.
- Dynamic registration (remote pushes its handler list at connect) is the general
  form — defer until heterogeneous remotes are actually needed.

### Wire protocol (asymmetric, minimal)
- **host → remote:** operation/hook invocations + domain events (to remote subscribers)
- **remote → host:** intents (the only thing a remote handler *initiates*)
- **handler results + provided data** ride the invocation response

Notably, `agent:update-status` is already an intent, so a remote agent signaling a
status change is just "dispatch that intent back to the host" — no new concept.

---

## 3. The structural model: two boundary tiers, two module tiers

Placement is a **per-handler property**. The clean-up target is to make it so.

### Boundaries
- **Host-only** — `WindowBoundary`, `ViewBoundary`, `SessionBoundary`, `IpcBoundary`,
  `DialogBoundary`, `ImageBoundary`, `AppBoundary`(+power), `MenuBoundary`,
  `PostHogBoundary`. (The Electron/UI surface + telemetry.)
- **Both-sides** — `FileSystemBoundary`, `ProcessRunner`, `PortManager`,
  `IGitClient`/`GitWorktreeProvider`, `HttpClient`, `PathProvider`,
  `AgentServerManager`, code-server. (Run where the files live.)
  - `SdkClientFactory` / `AgentProvider` *client* is host-side but reaches a
    both-sides server over the `-L` tunnel.

### Modules
- **Host-only** — `view`, `presentation`, `creation`, `deletion-dialog`/`dialog-manager`,
  `badge`, `power`, window-title/shortcut/selection, `electron-lifecycle`, menu,
  `auto-updater`, `telemetry`, `error-report`, and the host-resident servers
  `mcp-module` / `plugin-server-module` (remotes reach them via `-R`).
- **Both-sides** — `git-worktree-workspace`, `keepfiles`, `code-server`,
  `remote-project`, `workspace-agent-resolver` (all clean), plus:
  - `agent-module` — **split by design** (server=remote, provider/status=host). The
    healthy reference shape.
  - `local-project-module` — **leaky** (FS/Git + `DialogBoundary`).
  - `hibernation-screenshot-module` — **leaky** (FS + `ViewBoundary`/`ImageBoundary`).

**A "leaky" module is a both-sides module whose handler also touches a host-only
boundary (or receives a host callback).** Fixing them makes every handler single-tier
and therefore cleanly placeable.

---

## 4. Audit verdict

The value surface (intent payloads, hook results, capability values, event payloads)
is overwhelmingly plain serializable data. No structural blockers. What remains is a
bounded punch list.

Non-JSON carriers found, all convertible:
- `Path` instances in `OpenProjectPayload.path`, `ProjectOpenedPayload.path`,
  `ProjectOpenFailedPayload.path` (convertible via `toString()` / `new Path()`).
- `Error[]` in `HookResult.errors`.
- Capability values are primitives (enforced by strict `===` matching in `requires`).

Orchestration facts that shape the work:
- `collect()` ordering/merging is **centralizable** (single host dispatcher is natural).
- `provides` is a **closure over handler-local mutable state** → must be reshaped to
  returned data to federate.
- Operations cast-inject `emit`/`dispatch` callbacks into extended hook contexts (not
  in the core `create/setup/finalize` handlers) → remote signaling becomes a
  dispatched-back intent, which is the model's `remote → host` channel.

---

## 5. Punch list (sequenced 1 → 2 → 3, plus 4 & 5)

Sequencing rationale: reshape the handler/capability **contract first** (1), so the
wire schemas (2) are written against the final data shape rather than the
closure-based one; only then are the leaky-module splits (3) worth doing, since they
depend on both the reshaped contract and the validated wire boundary.

**1. Reshape the capability contract.** Handlers **return** their provided data
instead of a `provides()` closure. Going forward, **prefer hook results over
`requires`/`provides`** — results federate for free (they ride the response);
reserve capabilities for genuine declarative intra-hook ordering.
→ research workspace `research-provides-closures`.

**2. Wire codecs + schema validation (zod).** Define zod schemas for every
wire-crossing type (intent payloads, hook results, provided-capability data, event
payloads), with `Path ↔ string` and `Error ↔ object` **transforms** baked into the
schemas. Validate + (de)serialize at the boundary so a malformed or hostile remote
message is **rejected at the edge**, not deep inside a handler. Two alignments make
this a natural fit:
- zod is **already a project dependency** (e.g. the `AgentSpec` discriminated union
  in `src/shared/api/types.ts`), so no new dependency is added.
- schema parsing **replaces unsafe `as` casts** (the audit found handlers do
  `ctx.capabilities?.X as number`) with validated parsing — aligned with CLAUDE.md's
  no-type-assertions rule, and it makes the guarded intent/event types a single
  source of truth for the wire contract.

Full sweep for any other non-JSON leaks (Maps/Sets/Buffers/class instances/functions).
→ research workspace `research-wire-codecs` (seeded before this reframing — its brief
covers the `Path`/`Error` codecs and the leak sweep; the zod-validation framing is an
addition to fold in when it reports).

**3. Split the three leaky handlers (results-first)** so every handler is single-tier:
- **git-init dialog** (`local-project-module.prepare`): host `confirm` handler returns
  the decision; the operation runs the remote `git init` step. (results-first;
  `requires`/`provides` optional.)
- **hibernation capture** (`hibernation-screenshot.capture`): likely **reclassify
  host-only** (the screenshot is a host-UI artifact) → no split; otherwise split
  host-capture / remote-write with the PNG bytes crossing as base64.
- **clone progress** (`remote-project-module`): invert the pushed-down `report`
  callback into a remote→host `emit` of `clone:progress`.
- → research workspaces `research-leaky-git-init-dialog`,
  `research-leaky-hibernation-capture`, `research-leaky-clone-progress`.

**4. Pin replicated indices host-side.** The `project:resolve` identity map
(`path → projectId`, a pure `sha256`-derived function) and the workspace inventory
used by `switch`'s auto-select are consulted on the hot path of nearly every dispatch.
Keep them as **host-cached projections refreshed by domain events** so the hot path
never round-trips to the remote.

**5. Registration lifecycle + partial-failure handling** (the one "engineering, not
audited" area). RPC-with-reconnect: bootstrap, heartbeat/liveness, deregister-on-drop,
reconnect-with-reconcile, **per-call timeouts**. Recovery leans on existing machinery:
worktree **rollback**, `cleanupOrphanedWorkspaces` (reconciliation precedent), and the
**idempotency** module (safe re-drive on reconnect). The single-dispatcher model keeps
this to client/server reconnect, **not** distributed consensus.

### The fix recipe for leaky handlers (general)
Split a leaky handler along the boundary tier so each resulting handler is single-tier,
and move **serializable data** between them (never host behavior into a remote handler):
1. **No cross-handler dependency** → each handler just returns its result (or `emit`s).
2. **Sequential/conditional dependency** → prefer **operation-coordinated results**
   (host handler returns → operation threads it into the resource step).
3. **Reclassify** → if the "resource" half is actually host-consumed, make the whole
   module host-only (no split).
4. **Invert-callback** → replace a pushed-down host closure with the resource handler
   `emit`-ing up the remote→host channel.
5. Reach for `requires`/`provides` only when you want the dispatcher to own intra-hook
   ordering declaratively — and item 2 makes that federate.

---

## 6. Control plane vs. data plane (independent)

- **Control plane** = the federated dispatcher (sections 2–5).
- **Data plane** = tunnels:
  - `-L` (host → remote): editor iframe → remote code-server; host agent-client →
    remote `opencode serve`.
  - `-R` remote → host (or, better, the remote→host **intent channel**): Claude bridge
    callbacks, OpenCode MCP, plugin (sidekick) Socket.IO.
  - Plus binary provisioning (code-server, agent binaries, git) and git auth on the
    remote.

These are separable and can be built/de-risked independently.

Note: if `agent-module` runs on the remote, its Claude bridge co-locates with the CLI
there, and status flows back as a dispatched `agent:update-status` intent — potentially
removing a raw `-R` socket in favor of the control-plane intent channel.

---

## 7. In flight / next steps

- **5 research workspaces** running, each producing a `RESEARCH-*.md` for punch-list
  items 1–3 (provides-reshape, wire codecs + zod validation, three leaky handlers).
- **Recommended spike:** prove the reverse channel by hand — run code-server + one
  agent on a remote box with `ssh -L`/`-R` and confirm the Claude bridge callback and
  the OpenCode MCP round-trip both work through the tunnel — before committing.
- **Then:** fold research findings into a phased implementation plan
  (1 → 2 → 3, then 4/5), with the data-plane spike alongside.
