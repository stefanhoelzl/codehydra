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
  cloned on the host _and_ on a remote box (and, later, mounted into a container) is
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
the _remote_ runs the discovery. Machine connect happens in the same post-`app-ready`
phase as project reopen (the `machines` registry is in `state.json`, which loads async).

---

## 3. What data lives where (decided)

| Data                                                                                          | Lives                                                        | Persisted? | Owner                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------ |
| User config (UI, `agent`, `version.*`, telemetry toggle, electron/log)                        | **Host** `config.json`                                       | yes        | existing owners                                  |
| Identity, telemetry id, `update.dismissed-version`, `auto-workspaces`                         | **Host** `state.json`                                        | yes        | existing owners                                  |
| **`machines` registry** (SSH boxes) + **`host.id`**                                           | **Host** `state.json` — _new_                                | yes        | **`machine-registry` (new)**                     |
| Project registry (managed→`{originUrl}`; local existing→`{machineId:local, path}`)            | **Host** `projects/<id>/config.json`                         | yes        | **`project-registry` (new, from local-project)** |
| Screenshots, `electron/`, host logs, host temp                                                | **Host** `dataRoot`                                          | yes        | existing owners                                  |
| Worktrees, managed clones, `vscode/`, `bin/`, `runtime/`, `claude/configs/`, remote logs/temp | **Remote** `<remoteBase>/<hostId>/…`                         | on box     | remote-instanced modules                         |
| Binaries (code-server, agents)                                                                | **Remote** `<remoteBase>/bundles/` (**shared** across hosts) | on box     | code-server / agent modules                      |
| The workspace list                                                                            | nowhere — **discovered** per machine, grouped by origin      | no         | git-worktree (per machine)                       |

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
- **Multi-host isolation.** Two hosts often SSH in as the _same_ unix user, so unix-user
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
power), **hibernation-screenshot** _(reclassified host-only — the code-server iframe
still renders in the host window even for a remote workspace)_, electron-lifecycle,
host-logging, state, idempotency, debug, telemetry, **error-report** _(pulls a remote
log bundle on demand, §7)_, auto-updater, and **mcp + plugin-server** _(host-central;
remotes reach them via a reverse tunnel → the single host dispatcher)_.

Plus two **new** host-only modules:

- **`project-registry`** — extracted from `local-project`: persist/resolve/list projects
  - the folder-picker Dialog (host-only). Single-tier.
- **`machine-registry`** — owns `machines` + `host.id`; connection lifecycle
  (bootstrap, heartbeat, reconnect-reconcile, deregister-on-drop); launches the per-host
  remote process; proxies remote module registration into the host dispatcher.

### Remote-instanced (per-host process)

git-worktree, keepfiles, code-server, extension, metadata, workspace-agent-resolver,
script, temp-dir, posix-process-cleanup, **managed-project** _(renamed from
remote-project)_, and the **agent ServerManager**.

### Split (each resulting handler single-tier)

- **agent** — ServerManager = remote-instanced (co-located with the CLI); provider
  registration + availability + status intake = host. Status flows back as a dispatched
  `agent:update-status` intent (already an intent — no new concept). _The healthy
  reference shape for a split module._
- **local-project → `project-registry` (host) + machine-instanced clone/discover.** The
  FS/git work — cloning a managed repo, discovering worktrees — runs where the repo lives.
- _(`path-probe` for `remote+existing` — deferred to post-v1.)_

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
is a bounded list. The original sequencing was contract → wire schemas → splits; in practice
the handler/capability **contract** (item 1) and the leaky-module **splits** (item 3) both
**landed first** — item 3 because it is a self-contained local refactor needing no transport —
leaving **validation** (item 2, reframed below from "wire schemas" to a first-class
intent-system feature) as the next code step, ahead of the transport items 4/5.

**1. Reshape the capability contract — ✅ DONE** (commit `d871aea6`, pre-session).
Handlers return a `HookOutput { result?, provides? }`; the merge loop is wire-ready. Rule
recorded in `docs/INTENTS.md` (_a value is a capability iff a sibling handler `requires`
it; everything else consumed is a `result`_). `workspaceUrl`/`agentType` migrated from
capabilities to results. `requires` stays host-evaluated; `ANY_VALUE` never crosses the wire.

**2. Validation as a first-class intent-system feature (decided design).** Reframed from
"wire codecs": the contract surface is **already plain serializable data** — every path in an
intent payload / hook result is a **branded string** (`WorkspacePath = string & brand`,
`ProjectId`, `WorkspaceName`), not a `Path` instance (`Path` lives _inside_ modules and is
stringified before it reaches `collect`/`dispatch`), and the only non-serializable carrier is
`AppStartErrorHookContext.error: Error`, a **host-only** hook that never crosses a wire. So the
`Path↔string` / `Error↔object` transform machinery the earlier revision leaned on is largely
theoretical, and **codecs are deferred until a wire actually exists**. What is real and durable
_now_ is **runtime validation**: the dispatcher does **zero** today (`dispatcher.ts`), so intent
payloads are `unknown`, hook results merge via an unchecked `output.result as T` cast
(`dispatcher.ts:300`), the operation return value is cast `as IntentResult<I>` (`:478`), and
capability values are read via `as number` casts. Item 2 replaces all of these with
`schema.parse` — a first-class intent-system feature, applied on **every dispatch whether or not
a wire is ever built** (aligned with CLAUDE.md's no-assertions rule). Wire-readiness falls out as
a byproduct; it is not the driver.

Resolved design:

- **zod is the single source of truth.** Schemas are what you write; types are `z.infer<schema>`
  (no hand-synced registry like today's `plugin-protocol.ts`). Branded ids become
  `z.string().brand<…>()`. The generic **envelopes** (`Intent<R>`, `DomainEvent`, `HookContext`)
  stay hand-written — zod can't model the phantom result-type param — while everything they
  _carry_ (payloads, results, provides, contexts) is zod-derived. `readonly` is preserved via
  `.readonly()` so inferred types match today's deeply-`readonly` contracts.
- **zod is confined to the intent system.** The shared contract vocabulary (branded ids,
  `agentSpecSchema`, `Workspace`, metadata) is _defined inside_ `src/intents/` (a `contract/`
  module; per-operation schemas stay colocated on their operations). `shared/api/types.ts` and
  `shared/ipc.ts` become **type-only re-export façades** (`export type { … } from "…/intents/…"`),
  so renderer / preload / services keep their import paths **unchanged** — those imports are
  already `import type` and thus erased at build. (This is already why zod stays out of the
  renderer bundle today despite `shared/api/types.ts:5` importing `zod/v4`: `renderer/lib/api`
  imports these names type-only.) A **boundary lint forbids `zod` imports under `src/renderer`,
  `src/preload`, `src/shared`**, making the confinement structural, not a tree-shaking accident.
  The one runtime zod consumer in `shared/` today — `plugin-protocol.ts`'s `agentSpecSchema.safeParse`
  (main-only) — value-imports the schema from the intents `contract/` module (an accepted, main-only
  `shared→intents` runtime edge; alternatively that guard relocates into the contract module).
- **Schemas hung on the Operation.** A `schemas` field —
  `{ payload, result, hooks: { <point>: { input, result, provides } }, events: { <type> } }` —
  colocated with the op's `*_OPERATION_ID` / hook-point / `EVENT_*` defs. The dispatcher indexes
  it at `registerOperation` (payload/hook/result reachable via the operations map; event schemas
  folded into an event→schema lookup for `emitEvent`). Modules registering a handler import the
  point's schema to conform.
- **Five validated carriers** — everything crossing the intent-system boundary, in **both**
  directions:

  | Carrier                                                       | Where                                 | On failure                                                         |
  | ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
  | Intent payload                                                | `dispatch()` entry                    | reject the dispatch                                                |
  | Hook input context (whole ctx)                                | into each handler                     | throw (operation built a bad ctx — a framework bug)                |
  | Hook result                                                   | `collectHookResults:300`, per handler | push to `collect`'s `errors[]` (isolated, like a throwing handler) |
  | Provides — a **scalar bag** (`string\|number\|boolean\|null`) | merge at `:305`                       | push to `errors[]`                                                 |
  | Event payload                                                 | `emit()`                              | throw                                                              |
  | Operation return value                                        | before `handle.resolve` (`:478`)      | reject the dispatch                                                |

- **`.strip()`, not strict.** Unknown keys are silently dropped and the dispatcher **forwards the
  parsed (stripped) value** so normalization takes effect and a future wire can't leak stray
  fields; known keys are still fully type-checked (so the `as number` capability reads are
  protected — only extra-key _detection_ is traded away).
- **Whole-context validation** at every hook point: the enrichment fields are validated strictly,
  the `intent` portion re-affirmed against the op's own payload schema, and `capabilities` is a
  **shape check** (`z.record` of scalars) — each capability value was already validated against its
  `provides` schema at merge time, so its values aren't re-parsed. All current capability values
  are already scalar (ports=number, `app-ready`/`ui-ready`=boolean, `agent`=`AgentType` string), so
  the scalar constraint holds against the whole codebase without a provider refactor.
- **`requires` stays host-evaluated** with the `ANY_VALUE` sentinel — it tests key _presence_, never
  needs a value schema, and never crosses a wire; only `provides` _data_ is schematized.

**Rollout: one atomic big-bang PR.** All ~30 operations get schemas + the shared branded-type
rewrite (`shared/api/types.ts`, `ipc.ts`) + mandatory validation from day one; CI proves the whole
surface at once (no half-validated window). Shared value schemas (`AgentSpec` — reuse the existing
`agentSpecSchema` — `Workspace`, metadata) live in a shared `schemas.ts` that operation schemas
compose; each event type has exactly one owning operation file and registration rejects a duplicate
event-schema.

Cost: a `schema.parse` per dispatch **and** per hook point, including the hot paths
(`project:resolve`, `switch`, `get-active-workspace`) — and the item-4 host-cached projections that
would mitigate it don't exist yet (they need the transport work). Posture: **accept it, measure,
optimize only on a real regression** — zod v4 (already imported for `agentSpecSchema`) is fast and
payloads are small; add a `project:resolve`/`switch` benchmark to the PR so the cost is visible.
Implementation residue (no decision): a per-brand constructor helper for building branded values at
runtime, and integration tests that lean on extra/invalid fields (mostly absorbed by `.strip()`).

**2a. Enforce the data-only handler contract.** _Both a handler's `HookContext` (in) and its
`HookOutput` (result + provides) — and every event payload — must be pure data: no
functions, no host closures in either direction._ This is the precondition that makes item 2
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

**3. Make every handler single-tier + pure (operations own emits).** This is _not_ a
per-handler splitting exercise. "Operations own emits/dispatch; handlers return data" is
already the **dominant pattern** (~61 of ~69 emit/dispatch sites are operation-side;
`HookContext`/`HookOutput` carry no `emit`/`dispatch` by design). The work is to pull the
**straggler hook handlers** back in line with item 2a, in two groups (one more — `delete
confirm` — turned out to already satisfy the invariant; see below):

- **Operation-owns (3 handlers, mechanical):**
  - **resume** (`code-server` `resume`): handler returns outcome data (`{restarted}` /
    `{failed, error}`); the operation emits. Because `app-resume` now **fans out to N
    machines + local**, the `code-server:restarted` / `app:resume-failed` payloads gain a
    **machine/workspace scope** so the host reloads only the affected iframes.
  - **waitForRetry** (`presentation` `show-ui`, outbound closure): the operation owns the
    retry loop; the handler returns a data flag.
  - **appStartStart** (`presentation` `start`): the **operation** dispatches `app:ready`,
    not the handler.
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
- **delete `confirm`** (`deletion-dialog`): its `HookContext` (`DeletePipelineHookInput`) and
  result (`ConfirmHookResult`) are **already pure data**, so the invariant holds. It is
  **host-pinned** (`ui.dialog`) and its `deps.dispatcher` sub-dispatches (status/metadata) are
  host-side UI orchestration that drives the _progressive_ dialog fill — the dialog opens
  immediately and fills warnings in when the slow `refresh:true` git-fetch lands. Moving those
  dispatches to the operation would block the dialog on that fetch (a UX regression) for no
  invariant gain (host-pinned ⇒ never remote; the host dispatcher already federates the target
  operations). Left as-is.
- **git-init** (`local-project` `prepare`): the **sole** handler mixing a host-only boundary
  (`ui.dialog`) with both-sides work (`gitClient.init`). It only fires for **local**
  existing-checkouts in v1 (managed-on-remote clones instead), so the mix is harmless and
  host-local. **Deferred** — its `confirm`(host-pinned) / `init`(anywhere) split lands with
  `path-probe` + remote folder-browse when **remote+existing** checkout support arrives.
  → research workspaces `research-leaky-*`.

_Implementation (decided):_ the streaming framework change is an **`onYield` host-callback
on `collect()`** — a handler may be an `async function*` that yields neutral progress data
and returns its `HookOutput`; the operation passes `collect(hookPoint, ctx, { onYield })`,
`collect` iterates the generator and calls `onYield(y)` per frame while the operation maps it
to the right event and emits. The callback lives **operation ↔ `collect`** (both host), never
in the handler's `HookContext`, so the data-only-context invariant holds by construction, and
a remote proxy later forwards yield-frames into the same `onYield` with zero operation rework.
(A hook point has one progress semantic — `resolve`→clone, `binary`/`extensions`→download — so
`onYield` is unambiguous; assert it.) Landed as **one PR** (the local refactor is self-contained
and needs no transport): the framework change + all 8 straggler conversions + the four
closure-field removals together, so the data-only invariant lands atomically and CI proves the
whole surface at once.

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

Progress: **item 1 done** (capability contract), **item 3 done** (single-tier handlers +
streaming framework), and **item 2 done** (validation as a first-class intent-system feature —
implemented and green). `research-wire-codecs`, `research-leaky-*`, and
`research-provides-closures` are all **moot**.

Item 2 as landed: the contract vocabulary (branded ids, AgentSpec, domain value objects) lives
in `src/intents/contract.ts` (zod = single source of truth), with `shared/api/types.ts` +
`shared/ipc.ts` as **type-only re-export façades** and an eslint boundary rule confining zod to
the intent system (legacy exceptions: `ui-event.ts`, `plugin-protocol.ts`). The dispatcher
validates all five carriers (intent payload, hook input ctx, hook result, provides, event, +
operation result) via schemas hung on each `Operation`. **`Operation` is parameterized by its
schema bundle** — `Operation<S extends OperationSchemas>` with required `schemas: S` and
`execute(ctx: OperationContext<IntentOf<S>>): Promise<ResultOf<S>>` — so a production op is just
`implements Operation<typeof schemas>` and its Intent/result derive from the bundle (`IntentOf` /
`ResultOf`), never restated. `registerOperation(op)` is single-arg (key = `op.schemas.type`). Test
mocks were consolidated onto a single generic helper (`createMinimalOperation(id, intentType,
hookPoint, opts)` → `Operation<S>` with a permissive `z.unknown()` payload + `z.custom<R>()` result
that keeps dispatched results typed); a few genuinely-custom mocks stay bespoke `Operation<typeof
schemas>` objects. **Deferred polish** (not blocking): tightening the few `z.custom<T>()` escapes
(AgentInfo / BinaryType / Path-carrying internal types) to structural schemas.

- **Next code step:** the transport work (items 4/5) + the §10 reverse-channel spike.
- **Recommended spike (in parallel):** prove the reverse channel by hand — run code-server + one
  agent on a remote box with `ssh -L`/`-R`, confirm the Claude bridge callback and the OpenCode
  MCP round-trip both work through the tunnel — before committing to the transport (items 4/5).
- **Open details not yet drilled:** the exact config-injection key list (§5), the
  connection/registration lifecycle mechanics (§8 item 5), and the data-plane tunnel choice (§9).
