# Remote Workspaces via a Federated Dispatcher

Status: **design / exploration** (not yet approved for implementation)

Goal: let a user create workspaces on a **remote machine (SSH-first)** — surfaced in
the create-workspace dialog as a target-machine selection — with the workspace's
worktree, agent, and code-server all running on that machine, while a single
dispatcher on the host stays the sole orchestrator.

> This document leads with **what lives where** — the data, config, and module
> placement decisions — and only then covers the implementation punch list. An
> earlier revision inverted that order; the placement model is the thing to agree on
> first, because every implementation choice hangs off it.

> ⚠️ Requires explicit approval per CLAUDE.md before implementing: (a) any
> intent-contract / `OpenWorkspacePayload` change, (b) any **new boundary interface**
> for the transport, and (c) the new host-side modules and `state.json` keys named below.

---

## 1. Terminology (corrected)

Two **independent** dimensions describe a project. The old plan conflated them.

- **How the checkout is obtained**
  - **Managed** — CodeHydra cloned it from an origin URL and owns the bare clone.
    (This is today's misnamed "remote project"; **rename → managed**.)
  - **Existing checkout** — a path the user points CodeHydra at.
- **Which machine it lives on**
  - **Local** — the host.
  - **Remote** — an SSH-reachable box. The worktree, agent, and code-server all run
    there (git worktrees require the parent repo on the same filesystem).

They cross freely: `local+existing` (today's default), `local+managed` (today's URL
clone), `remote+existing`, `remote+managed`. A **remote workspace** is simply a
workspace whose project lives on a remote machine.

**v1 scope cut:** on a remote, **managed only**. `remote+existing` (and the remote
folder-browse / `path-probe` it needs) is **deferred**. Existing-checkout identity
stays a local-only concept in v1.

---

## 2. Project identity & the machine model (decided)

### Project identity depends on how it was obtained

- **Managed → identity is the origin URL** (`sha256(normalizedUrl)`). The same origin
  cloned on the host *and* on a remote box (and, later, mounted into a container) is
  **one project**; its workspaces just live on different machines. Grouped under a
  single project node in the UI.
- **Existing checkout → identity is `(machine, path)`.** No shared origin to unify on.
  Inherently single-machine. (Local-only in v1.)

Consequence: for managed projects **(project × machine) is many-to-many** — one
project spans machines, one machine hosts many projects — with **workspaces at the
intersection**. So **machine is a property of the workspace**, not the project (except
for existing checkouts, where it is part of identity).

### Machine is a first-class, host-persisted registry

Because it's many-to-many, a machine cannot be a field on a project. The host keeps a
**machine registry** — the set of SSH boxes to reconnect to on startup — plus a
project registry. On startup it connects each machine and **discovers** that machine's
worktrees, then groups them by project identity. Which machines a managed project lives
on is **discovered on connect, never persisted** — consistent with today's invariant
that workspaces are never stored, always re-derived from `git worktree list`.

### Reconnect story (reuses today's project-reopen machinery)

Today, open projects are persisted as one `config.json` per project under the host's
`projects/` dir; on launch the app scans that dir and re-dispatches `project:open` for
each, then discovers worktrees via `git worktree list`. Remote reconnect is the same
loop with one addition: a project on a remote machine triggers an **SSH connect**, and
the *remote* runs the discovery. Machine connect happens in the same post-`app-ready`
phase as project reopen (the `machines` registry is in `state.json`, which loads async).

---

## 3. What data lives where (decided)

| Data | Lives | Persisted? | Owner |
| --- | --- | --- | --- |
| User config (UI, `agent`, `version.*`, telemetry toggle, electron/log) | **Host** `config.json` | yes | existing owners |
| Identity, telemetry id, `update.dismissed-version`, `auto-workspaces` | **Host** `state.json` | yes | existing owners |
| **`machines` registry** (SSH boxes) + **`host.id`** | **Host** `state.json` — *new* | yes | **`machine-registry` (new)** |
| Project registry (managed→`{originUrl}`; local existing→`{machineId:local, path}`) | **Host** `projects/<id>/config.json` | yes | **`project-registry` (new, from local-project)** |
| Screenshots, `electron/`, host logs, host temp | **Host** `dataRoot` | yes | existing owners |
| Worktrees, managed clones, `vscode/`, `bin/`, `runtime/`, `claude/configs/`, remote logs/temp | **Remote** `<remoteBase>/<hostId>/…` | on box | remote-instanced modules |
| Binaries (code-server, agents) | **Remote** `<remoteBase>/bundles/` (**shared** across hosts) | on box | code-server / agent modules |
| The workspace list | nowhere — **discovered** per machine, grouped by origin | no | git-worktree (per machine) |

Notes:

- A **managed project may have no host clone at all** — materialized only on a remote.
  Its host `projects/<id>/` then holds `config.json` only (no `workspaces/` subdir).
- **`host.id`** is a dedicated, stable, unique per-install id in host `state.json`
  (owned by `machine-registry`), presented to the remote at connect. Stable ⇒ reconnect
  finds the same namespace; unique ⇒ two hosts don't collide. Not derived from
  hostname/user (both collide or are shared).

---

## 4. app-data split & the remote layout (decided)

The app already has **two independent roots** — `dataRoot` (`dataPath()`) and
`bundlesRoot` (`bundlePath()`, already special-cased + `_CH_BUNDLE_DIR`-overridable).
That separation is reused on the remote:

```
<remoteBase>/
  bundles/<agent|code-server>/<version>/   ← SHARED across all hosts on the box
                                             (dedupe downloads; idempotent/locked install)
  <hostId>/                                 ← PER-HOST dataRoot + its own module-host process
    projects/  remotes/  vscode/  bin/  runtime/  claude/configs/  temp/  logs/
```

- **No `config.json` on the remote.** The remote holds files only; its data root and
  settings are injected at connect (§5).
- **Multi-host isolation.** Two hosts often SSH in as the *same* unix user, so unix-user
  separation can't be relied on; a managed clone keys off `sha256(origin)` and would
  otherwise be shared, leaking one host's worktrees into the other's `git worktree list`.
  Isolation is therefore structural: **per-host `dataRoot` namespace + a per-host
  module-host process**, each rooted at `<remoteBase>/<hostId>/`. Discovery is scoped to
  the subtree by construction — a host cannot see another host's workspaces.
- **Ports** are the one genuinely shared resource on the box; handled by the
  "allocate at runtime, report back" handshake (§5), which avoids cross-host collision
  without per-host port ranges.

---

## 5. Config: host-authoritative, injected at connect (decided)

- **Host is the sole authority** for user config/state. The remote persists **no**
  config.
- A **defined subset is pushed to the remote at connect**: the injected data root
  (`<remoteBase>/<hostId>`), `log.level`, `agent` (default), `version.*`, keepfiles
  behavior, `experimental.busy-during-background-shell`. (Exact key list = an open
  detail, see §8.)
- **Inherently-per-machine values are decided on the remote at runtime**, not stored as
  user config: `code-server.port` and other allocated ports are chosen on the box and
  **reported back** — a runtime handshake, not persisted config, so "remote persists only
  files" holds.
- **Per-machine agent availability is discovered on connect.** Which agents are
  installed can differ per box (shared `bundles/` on that box). Each per-host remote
  process reports its available agents; the host keeps a per-machine availability map,
  and the create-workspace dialog offers agents per target machine. The `agent` config
  stays a global default pushed down; per-workspace agent type still lives in worktree
  metadata on the machine.

---

## 6. Module placement (decided)

The **both-sides** set runs as **one host instance** (for local workspaces) **plus one
instance per connected remote box**, each executing against that machine's native
boundaries inside the per-host module-host process.

### Host-only

All UI/Electron modules (presentation, view, settings, creation, deletion-dialog,
clone/error-notification, workspace-selection, window-title, shortcut, devtools, badge,
power), **hibernation-screenshot** *(reclassified host-only — the code-server iframe
still renders in the host window even for a remote workspace)*, electron-lifecycle,
host-logging, state, idempotency, debug, telemetry, **error-report** *(pulls a remote
log bundle on demand, §7)*, auto-updater, and **mcp + plugin-server** *(host-central;
remotes reach them via a reverse tunnel → the single host dispatcher)*.

Plus two **new** host-only modules:

- **`project-registry`** — extracted from `local-project`: persist/resolve/list projects
  + the folder-picker Dialog (host-only). Single-tier.
- **`machine-registry`** — owns `machines` + `host.id`; connection lifecycle
  (bootstrap, heartbeat, reconnect-reconcile, deregister-on-drop); launches the per-host
  remote process; proxies remote module registration into the host dispatcher.

### Remote-instanced (per-host process)

git-worktree, keepfiles, code-server, extension, metadata, workspace-agent-resolver,
script, temp-dir, posix-process-cleanup, **managed-project** *(renamed from
remote-project)*, and the **agent ServerManager**.

### Split (each resulting handler single-tier)

- **agent** — ServerManager = remote-instanced (co-located with the CLI); provider
  registration + availability + status intake = host. Status flows back as a dispatched
  `agent:update-status` intent (already an intent — no new concept). *The healthy
  reference shape for a split module.*
- **local-project → `project-registry` (host) + machine-instanced clone/discover.** The
  FS/git work — cloning a managed repo, discovering worktrees — runs where the repo lives.
- *(`path-probe` for `remote+existing` — deferred to post-v1.)*

### auto-workspace

Stays host-side but becomes **machine-targetable per source**
(`experimental.<source>.machine`) so auto-created workspaces can land on a remote —
which pulls remote connect/materialize into the auto-workspace path.

---

## 7. Observability (decided)

Remote workspaces run their agent + code-server on the box, so failures originate there.

- Remote logs **stay on the box** at `<hostId>/logs/`.
- On `$exception` or a manual bug-report, the per-host remote process **ships a
  compressed log bundle + its redacted config context up the channel**; the host-only
  **error-report** module attaches it to the PostHog `$exception` alongside host context.
- One reporting pipeline (host); remote data pulled **only on demand** (no continuous
  log streaming over the tunnel).

---

## 8. Implementation punch list (subordinate to the model above)

The value surface (intent payloads, hook results, capability values, event payloads) is
overwhelmingly plain serializable data — no structural blockers, given the **data-only
contract invariant** (item 2a) that forbids the few remaining function fields. What remains
is a bounded, sequenced list. Sequencing rationale unchanged: the handler/capability
**contract** first, then the **wire schemas** against the final shape, then the leaky-module
**splits**.

**1. Reshape the capability contract — ✅ DONE** (commit `d871aea6`, pre-session).
Handlers return a `HookOutput { result?, provides? }`; the merge loop is wire-ready. Rule
recorded in `docs/INTENTS.md` (*a value is a capability iff a sibling handler `requires`
it; everything else consumed is a `result`*). `workspaceUrl`/`agentType` migrated from
capabilities to results. `requires` stays host-evaluated; `ANY_VALUE` never crosses the wire.

**2. Wire codecs + zod validation (decided design).** The seam is **asymmetric**, and
the untrusted direction is **remote→host**, which carries **three** independently-defined
type families — not just intents: **intent payloads** (a remote handler dispatches),
**hook results** (`HookOutput.result`, which *ride the invocation response* back — 6+ per
op, e.g. `delete-workspace`), and **provided data** (`HookOutput.provides`). Event payloads
travel host→remote (trusted). Today the dispatcher does **zero** validation
(`dispatcher.ts:397`): intent payloads are `unknown`, hook results are merged via an
unchecked `output.result as T` cast (`dispatcher.ts:290`), and capability values are read
via `as number` casts (`code-server-module.ts:706`, `agent-module.ts:211`). So "just
schematize intents" under-scopes the actual attack surface.

Resolved design:

- **Schemas live on the Operation.** Each operation declares zod schemas for its intent
  payload, its per-hook-point results, its provided-data, and its events — colocated with
  the `*_OPERATION_ID` / hook-point / `EVENT_*` definitions it already owns. TS types
  become `z.infer<schema>`, so the schema is the single source of truth (no separate
  hand-synced registry like today's `plugin-protocol.ts`).
- **Data-only contract (global invariant — see item 2a).** With no functions anywhere in
  the contract, the *entire* operation surface is schematizable; scope is not bounded by
  serializability.
- **Validate + transform anywhere.** Every dispatch runs `schema.parse` — validation *and*
  `Path↔string` / `Error↔object` transforms — whether or not the message crosses the wire.
  **One code path, no local-vs-wire branch**, so the wire path is exercised on every local
  dispatch and a remote-only serialization bug cannot hide. This is safe because `Path` is a
  value object compared via `.equals()` / `.toString()` (never by reference) and
  `HookResult.errors` are data-only reports — a `Path` round-tripped through `string` back to
  a fresh `new Path()`, or an `Error` through `{message,stack}`, is *equivalent*; instance
  identity never mattered. *(Doc note for implementers: don't rely on `Path`/`Error`
  instance identity or live `Error` prototypes across a dispatch — reconstructed instances
  are equivalent by value only.)*
- **The dispatcher is the validation home** — "the intent system handles validation,"
  literally. This replaces the unsafe `as` casts everywhere (aligned with CLAUDE.md's
  no-assertions rule), not only at the wire.
- **`requires` stays host-evaluated** with the `ANY_VALUE` sentinel — it never needs a value
  schema and never crosses the wire; only `provides` *data* is schematized.

Cost: a `schema.parse` per dispatch, including the hot path (`project:resolve`) — mitigated
by the item-4 host-cached projections; zod v4 (already imported for `agentSpecSchema`) is
fast. Still do the full sweep for other non-JSON leaks (Maps/Sets/Buffers/class instances)
so every carrier has a transform.
→ research workspace `research-wire-codecs`.

**2a. Enforce the data-only handler contract.** *Both a handler's `HookContext` (in) and its
`HookOutput` (result + provides) — and every event payload — must be pure data: no
functions, no host closures in either direction.* This is the precondition that makes item 2
total **and** the thing that makes a handler location-transparent: with a uniform data
contract, the dispatch mechanism is identical local or remote, so **you never reason about
placement when writing a handler**. Operations are exempt — they are the host-side
orchestrators and keep `ctx.emit` / `ctx.dispatch`.

Placement then reduces to one mechanical rule (no per-handler judgement): **a handler is
host-pinned iff its module injects a host-only boundary** (Dialog / View / Image / Window /
Menu / Session / App); a handler that injects only both-sides boundaries runs anywhere.
Host-pinned handlers are legitimate and already coexist with anywhere-handlers on the same
operation (e.g. `delete-workspace` = host `confirm` dialog + remote teardown; `hibernate` =
host screenshot + remote agent/code-server teardown; `setup` = host UI phases + both-sides
downloads). The **only forbidden shape** is a single handler mixing a host-only boundary with
both-sides work — see item 3, git-init, the sole instance.

The closure fields to remove from the contract: `emit` (`app-resume.ts`), `report`
(`open-project.ts`, `setup.ts` ×2), and the outbound `waitForRetry` (`app-start.ts`). The
item-2 leak sweep confirms there are no other function carriers.

**3. Make every handler single-tier + pure (operations own emits).** This is *not* a
per-handler splitting exercise. "Operations own emits/dispatch; handlers return data" is
already the **dominant pattern** (~61 of ~69 emit/dispatch sites are operation-side;
`HookContext`/`HookOutput` carry no `emit`/`dispatch` by design). The work is to pull the
**8 straggler hook handlers** back in line with item 2a, in two groups:

- **Operation-owns (4 handlers, mechanical):**
  - **resume** (`code-server` `resume`): handler returns outcome data (`{restarted}` /
    `{failed, error}`); the operation emits. Because `app-resume` now **fans out to N
    machines + local**, the `code-server:restarted` / `app:resume-failed` payloads gain a
    **machine/workspace scope** so the host reloads only the affected iframes.
  - **waitForRetry** (`presentation` `show-ui`, outbound closure): the operation owns the
    retry loop; the handler returns a data flag.
  - **appStartStart** (`presentation` `start`): the **operation** dispatches `app:ready`,
    not the handler.
  - **delete `confirm`** (`deletion-dialog`): the operation gathers status/metadata
    (dispatch) and threads that **data** into the confirm context; the host-pinned handler
    renders the dialog and returns the decision.
- **Streaming progress → async generators (4 handlers):** clone (`managed-project`) plus
  three provisioning reporters — agent-binary download (`agent-module`), code-server
  binary + extensions (`code-server`), debug binary (`debug-module`). Each becomes an
  `async function*` that **yields progress frames (data)** and **returns its result**; the
  dispatcher consumes the stream (local: direct iteration; remote: wire frames) and the
  **operation emits** the progress event. This is the streaming generalization of the
  existing collect→emit pattern, and it removes the `report` closure from the
  `open-project` / `setup` hook contexts. (These run where the files/binaries live, incl.
  first-connect provisioning, so progress streams remote→host.)

**Not in scope / already right:**
- **hibernation capture**: host-only (§6) — capture renders the host UI iframe, PNG →
  host `screenshots/`. No split; the sibling hibernate teardown handlers are the remote ones.
- **git-init** (`local-project` `prepare`): the **sole** handler mixing a host-only boundary
  (`ui.dialog`) with both-sides work (`gitClient.init`). It only fires for **local**
  existing-checkouts in v1 (managed-on-remote clones instead), so the mix is harmless and
  host-local. **Deferred** — its `confirm`(host-pinned) / `init`(anywhere) split lands with
  `path-probe` + remote folder-browse when **remote+existing** checkout support arrives.
→ research workspaces `research-leaky-*`.

**4. Pin replicated indices host-side.** The `project:resolve` identity map
(`origin/path → projectId`, pure `sha256`) and the per-machine workspace inventory (for
`switch`'s auto-select) are host-cached projections **refreshed by domain events**, so the
hot path never round-trips to a remote. The inventory is **ephemeral** — rebuilt from
discovery on each connect, never persisted (§2).

**5. Registration lifecycle + partial-failure handling** (owned by `machine-registry`,
§6). Per-host RPC-with-reconnect: bootstrap, heartbeat/liveness, deregister-on-drop,
reconnect-with-reconcile, per-call timeouts, per-host process launch + binary
provisioning + idempotent/locked shared-`bundles/` install. Recovery leans on existing
machinery: worktree rollback, `cleanupOrphanedWorkspaces` (reconciliation precedent), and
the idempotency module (safe re-drive on reconnect). Single-dispatcher model keeps this to
client/server reconnect, not distributed consensus.

---

## 9. Control plane vs. data plane (independent)

- **Control plane** = the federated dispatcher: one dispatcher on the host, remote
  handlers registered via a per-host proxy (`machine-registry`). Wire is asymmetric —
  host→remote: operation/hook invocations + domain events; remote→host: intents (the only
  thing a remote handler initiates); results + provided data ride the invocation response.
- **Data plane** = tunnels:
  - `-L` (host→remote): editor iframe → remote code-server; host agent-client → remote
    `opencode serve`.
  - `-R` / the remote→host **intent channel**: Claude bridge callbacks, OpenCode MCP,
    plugin (sidekick) Socket.IO. If `agent-module`'s ServerManager runs on the remote, its
    Claude bridge co-locates with the CLI and status flows back as an `agent:update-status`
    intent — potentially removing a raw `-R` socket in favor of the control-plane channel.
  - Plus binary provisioning and git auth on the remote.

Separable, buildable/de-riskable independently.

---

## 10. Next steps

- **Recommended spike:** prove the reverse channel by hand — run code-server + one agent
  on a remote box with `ssh -L`/`-R`, confirm the Claude bridge callback and the OpenCode
  MCP round-trip both work through the tunnel — before committing.
- **Then:** fold `research-wire-codecs` + `research-leaky-*` findings into a phased
  implementation plan (2 → 3, then 4/5), with the data-plane spike alongside.
- **Open details not yet drilled:** the exact config-injection key list (§5), the
  connection/registration lifecycle mechanics (§8 item 5), and the data-plane tunnel choice
  (§9). `research-provides-closures` is **moot** (item 1 done) and can be discarded.
