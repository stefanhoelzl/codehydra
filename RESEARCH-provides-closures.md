# Research: Reshaping `provides` from a closure to returned data

**Goal:** Federate the intent dispatcher across a host/remote boundary — one dispatcher on
the host, some hook handlers executing remotely over a wire. The blocker is the hook
**capability** mechanism: a handler advertises capabilities via `provides`, a _closure_ that
the dispatcher invokes **host-side** after the handler runs. A remote handler cannot ship a
closure across a wire; it must **return** its provided capabilities as data alongside its
result so the host merges from data instead of calling a local closure.

Research only — no implementation.

---

## 1. The current contract

`HookHandler` (`src/intents/lib/operation.ts:47-57`):

```ts
export interface HookHandler<T = unknown> {
  readonly name?: string;
  readonly handler: (ctx: HookContext) => Promise<T>;
  readonly requires?: Readonly<Record<string, unknown>>; // already plain data
  readonly provides?: () => Readonly<Record<string, unknown>>; // <-- CLOSURE
}
```

Merge happens in `src/intents/lib/dispatcher.ts:284-291`:

```ts
const result = await entry.handler(frozenCtx);
if (result !== undefined && result !== null) {
  results.push(result as T); // handler RESULT -> results[]
}
if (entry.provides) {
  Object.assign(capabilities, entry.provides()); // CAPABILITIES -> running bag
}
```

Two separate output channels per handler:

- **result** (`T`) → pushed to `results[]`, consumed by the operation.
- **capabilities** (`provides()` return) → merged into the running `capabilities` bag, used to
  gate later handlers (`requires`) and read by downstream handlers via `ctx.capabilities?.X`.

`requires` is already plain data and is evaluated host-side (`requirementsSatisfied`), so it is
**not** part of the problem. Only `provides` is a closure.

### The universal closure idiom

Every `provides` closure captures a handler-local `let` and follows the same lifecycle:

1. Declared in the module factory: `let capX = <default>`.
2. Reset at the **start** of the handler: `capX = undefined` (guards against a stale value
   leaking if the handler throws).
3. Assigned during handler execution: `capX = <computed>`.
4. Read by the closure **after** the handler returns: `provides: () => ({ x: capX })`.

This reset-then-set dance exists _only_ because the closure is invoked separately, after the
handler. Returning the data inline makes the captured mutable variable unnecessary.

---

## 2. Every `provides` use (10 sites)

| #   | File:line                                              | Provided key(s)  | Captured state                                        | Value type      | Handler also returns a result?                   |
| --- | ------------------------------------------------------ | ---------------- | ----------------------------------------------------- | --------------- | ------------------------------------------------ |
| 1   | `src/modules/plugin-server-module.ts:874`              | `pluginPort`     | `capPluginPort` (decl `:163` `number \| null`)        | number/null     | no (void)                                        |
| 2   | `src/modules/code-server-module.ts:715`                | `codeServerPort` | `codeServerPort` (decl `:392` `number`, init `0`)     | number          | no (void)                                        |
| 3   | `src/modules/code-server-module.ts:911`                | `workspaceUrl`   | `capWorkspaceUrl` (decl `:650` `string \| undefined`) | string          | no (void)                                        |
| 4   | `src/modules/electron-lifecycle-module.ts:207`         | `"app-ready"`    | none — constant `true`                                | boolean literal | no (void)                                        |
| 5   | `src/modules/mcp-module.ts:1206`                       | `mcpPort`        | `capMcpPort` (decl `:1199` `number \| undefined`)     | number          | no (void)                                        |
| 6   | `src/modules/workspace-agent-resolver-module.ts:93`    | `agent`          | `resolved` (`AgentType \| null`)                      | string union    | no (void)                                        |
| 7   | `src/modules/workspace-agent-resolver-module.ts:108`   | `agent`          | `openResolved` (`AgentType \| null`)                  | string union    | no (void)                                        |
| 8   | `src/modules/view-module.ts:122`                       | `"ui-ready"`     | none — constant `true`                                | boolean literal | no (void)                                        |
| 9   | `src/modules/agent-module/agent-module.ts:340`         | `agentType`      | `capAgentType` (decl `:132` `AgentType \| undefined`) | string union    | **YES** — returns `SetupHookResult \| undefined` |
| 10  | `src/modules/presentation/presentation-module.ts:1422` | `agentType`      | `chosenAgent` (`LifecycleAgentType \| undefined`)     | string union    | no (void)                                        |

Notes:

- Sites 3, 5, 9, 10 use the conditional-spread idiom
  `...(capX !== undefined && { key: capX })`, so the closure can legitimately return `{}`
  (provide nothing). Site 6/7 similarly return `{}` when unresolved. The replacement shape must
  preserve "provide nothing" as a valid outcome.
- Sites 4 and 8 (`app-ready`, `ui-ready`) are **constant** boolean capabilities — these never
  needed a closure at all and could be static data today.
- **Only site 9** (`agent-module` setup) emits _both_ a meaningful result and a capability in
  the same handler. Its result `SetupHookResult` is consumed by the operation
  (`src/intents/open-workspace.ts`), while its `agentType` capability is read from the final
  bag at `src/intents/open-workspace.ts:267-268`. This is the case that proves the new shape
  must carry result **and** provides simultaneously — they can't be collapsed into one.

### Capability consumers (who reads the bag)

- Downstream-handler reads: `code-server-module.ts:718` (`pluginPort`),
  `agent-module.ts:212` (`mcpPort`).
- `requires` gates (already plain-data comparisons, host-side): `app-ready`, `ui-ready`,
  `codeServerPort`, `pluginPort`, `mcpPort`, `agent` — see `agent-module.ts:210/339/...`,
  `code-server-module.ts:714`, `presentation-module.ts:1401/1415`, `view-module.ts:121`, etc.
- Operation reads the finalized bag: `open-workspace.ts:268`
  (`setupResult.capabilities.agentType`).

---

## 3. Are provided values wire-safe? — Yes, all of them

Every provided value is a JSON primitive:

- **numbers**: `pluginPort`, `codeServerPort`, `mcpPort` (plus `null` for plugin/mcp).
- **booleans**: `app-ready`, `ui-ready` (literal `true`).
- **strings**: `workspaceUrl`, `agent`/`agentType` (string-union literals like `"claude"` /
  `"opencode"`).

No functions, class instances, `Path` objects, handles, or symbols are ever provided. The
capability **keys** are plain strings. The whole capability bag is already `JSON.stringify`-able,
so shipping provided capabilities as data across the wire needs no value-encoding work — only
the _delivery mechanism_ (closure → returned data) changes.

(Caveat for the wire layer: `requires` sentinels use `ANY_VALUE = Symbol(...)`
(`operation.ts:28`). Those live in `requires`, are compared host-side, and are never _provided_,
so they don't cross the boundary. No issue for this change.)

---

## 4. Proposed reshape of the `HookHandler` contract

The handler must be able to return **both** a result and its provided capabilities. Recommended
shape: have the handler return a structured envelope; the dispatcher reads `provides` off the
returned value instead of calling a closure.

### Recommended: tagged envelope, opt-in (minimal churn)

Add a small wrapper that handlers use only when they provide capabilities. Non-providing
handlers stay exactly as they are.

```ts
// operation.ts
export interface HookOutput<T> {
  readonly result?: T; // -> results[]
  readonly provides?: Readonly<Record<string, unknown>>; // -> capability bag (plain data)
}

export interface HookHandler<T = unknown> {
  readonly name?: string;
  readonly handler: (ctx: HookContext) => Promise<T | HookOutput<T>>;
  readonly requires?: Readonly<Record<string, unknown>>;
  // `provides` field removed
}
```

Dispatcher (`dispatcher.ts:285-291`) splits the two channels by recognizing the envelope. To
avoid mistaking a plain object result (e.g. code-server's `{ missingBinaries, ... }`) for an
envelope, tag it with an explicit, **serializable** discriminant rather than `instanceof` (a
class won't survive the wire):

```ts
const raw = await entry.handler(frozenCtx);
const out = isHookOutput(raw) ? raw : { result: raw }; // isHookOutput checks a "__hookOutput": true marker
if (out.result !== undefined && out.result !== null) results.push(out.result as T);
if (out.provides) Object.assign(capabilities, out.provides);
```

A `provide(caps)` / `provide(result, caps)` helper keeps call sites terse, e.g. site 2 becomes
`return provide({ codeServerPort: port })` and site 9 becomes
`return provide(setupResult, { agentType: provider.type })`.

**Why this beats the alternatives:**

- It carries result + provides together — required by site 9.
- It's pure data, so a remote handler's return serializes verbatim; the transport unwraps the
  same `{ result, provides }` on the host with no closure involved.
- It eliminates the reset-then-set captured-`let` idiom (sites 1-3, 5, 9, 10): the handler just
  computes a value and returns it; nothing to reset, no stale-value risk.
- Constant providers (sites 4, 8) become `return provide({ "app-ready": true })`.

### Alternative A — uniform envelope (every handler returns `HookOutput<T>`)

Cleaner type (no `T | HookOutput<T>` union, no discriminant guesswork) but touches **all ~192
handlers** in `src/modules` + `src/intents`. Large, mechanical, high-diff. Not recommended for a
first step.

### Alternative B — keep `provides` field but make it `Record`, not a closure

Doesn't work: provided values are **computed at runtime** by the handler (ports, resolved agent,
workspace URL). A static field can't capture them. The data must originate from handler
execution, so it must ride the return value. (Constant sites 4/8 _could_ use a static field, but
that's only 2 of 10.)

---

## 5. Call sites that change & migration

- **`HookHandler` definition** — 1 site (`operation.ts:47-57`): drop `provides`, widen handler
  return to `T | HookOutput<T>`, add `HookOutput`/helper/guard.
- **Dispatcher merge** — 1 site (`dispatcher.ts:285-291`): unwrap envelope instead of calling
  `entry.provides()`.
- **Provider handlers** — **10 sites** (table in §2), across 7 modules:
  `plugin-server-module`, `code-server-module` (×2), `electron-lifecycle-module`, `mcp-module`,
  `workspace-agent-resolver-module` (×2), `view-module`, `agent-module`, `presentation-module`.
  Each: delete the captured `let` + its reset/assignment, and `return provide(...)` instead.
- **Consumers unchanged**: `ctx.capabilities?.X` reads (`code-server:718`, `agent-module:212`),
  `requires` gates, and `open-workspace.ts:268` all read the same merged bag — its shape and
  contents are identical, only how it gets populated changes.

### Backwards-compatibility / migration considerations

- **Type safety of the union.** `handler: Promise<T | HookOutput<T>>` makes the dispatcher
  discriminate. The discriminant must be an explicit serializable marker (e.g. a
  `"__hookOutput": true` field), **not** `instanceof`/symbol — a class or symbol tag is lost on
  the wire, which is the whole point. Risk: a handler whose genuine result legitimately looks
  like a `HookOutput`. Real results today are `SetupHookResult`,
  `{ missingBinaries, extensionInstallPlan }`, etc. — none carry a `__hookOutput` marker, so a
  reserved-key marker is safe. The uniform-envelope alternative sidesteps this entirely.
- **Two transition styles.** Either flip all 10 + dispatcher atomically (small enough to do in
  one change), or support both shapes transiently — dispatcher accepts a returned envelope _and_
  still calls a legacy `provides` closure if present — then remove the closure path once all 10
  migrate. Atomic is cleaner given only 10 sites.
- **Reset semantics preserved for free.** The closures reset their captured `let` at handler
  entry precisely to avoid leaking a previous run's value when a handler throws. With inline
  return, a throwing handler returns nothing → no result, no provides merged — same observable
  outcome, no shared mutable state, and inherently re-entrant/concurrency-safe (relevant once
  remote handlers run out-of-process).
- **No IPC/shared-type contract impact (per CLAUDE.md).** `HookHandler`/`HookOutput` are
  internal dispatcher types (`src/intents/lib`), not `api:*` IPC channels or `src/shared` types,
  so this is not an API/IPC interface change. It _is_ a change to a core dispatcher contract,
  so it should still be done deliberately and with the existing dispatcher/operation tests
  updated.
- **Wire layer is a separate, later step.** This reshape only makes provided capabilities
  _expressible as returned data_. Actually shipping a handler's `{ result, provides }` across a
  transport (and merging it host-side) is the federation work that this change unblocks; it is
  out of scope here.

---

## 6. Resolved design decisions (interview)

Decisions taken for the implementation:

1. **Scope:** In-process refactor only. Closure→data is a standalone, behavior-preserving
   change; the remote/wire transport is follow-on work this unblocks.
2. **Contract:** Uniform envelope. The handler return type becomes
   `Promise<HookOutput<T> | void>` where `HookOutput<T> = { result?: T; provides?: Readonly<Record<string, unknown>> }`.
   The `provides` _field_ is removed from `HookHandler`. `requires` stays declarative
   (evaluated before the handler runs — must remain static data).
3. **Generic typing:** `T` stays the **unwrapped result type**. `collect<T>()` still returns
   `HookResult<T>` with `results: T[]`; the dispatcher unwraps `out.result`. Every existing
   `collect<SomeResult>()` call and every `.results` consumer (`open-workspace.ts:261`,
   `app-ready.ts:108/117`, `list-projects.ts`, …) is **untouched**.
4. **Return shape at call sites:** Raw object literal — `return { result: X }`,
   `return { provides: {...} }`, `return { result: X, provides: {...} }`. No helper functions,
   no imports.
5. **Void handlers:** Allowed. Dispatcher coerces a `void`/`undefined` return to `{}`, so the
   ~130+ pure-void handlers (logging, shutdown `stop`, most `init`/`start` hooks) **don't
   change**. Only the data-returning subset (handlers behind `collect<SomeResult>`) and the
   10 providers adopt the envelope. No ambiguity: the only non-envelope return permitted is
   `void`, never a bare result object.
6. **Merge rule — skip `undefined` keys:** Because `requirementsSatisfied` checks key
   _presence_ (`key in capabilities`) for `ANY_VALUE` (`dispatcher.ts:478`), the merge must
   skip `undefined`-valued provides keys: `for (const [k,v] of Object.entries(out.provides ?? {})) if (v !== undefined) capabilities[k] = v;`.
   This lets the 4 conditional-spread sites (`...(capX !== undefined && { key: capX })`) drop
   the boilerplate and just `return { provides: { key: value } }`. Trade-off accepted: an
   explicit `undefined` capability value can never be provided — no site does.
7. **Migration:** Atomic cutover, compiler-driven. Flip `HookHandler`'s return type first; TS
   flags every non-conforming handler. A handler that forgets to wrap (`return { missingBinaries }`
   instead of `return { result: { missingBinaries } }`) fails the excess-property check against
   `HookOutput<T>`, so the silent-result-loss footgun is caught at compile time.

### Resulting dispatcher merge (`dispatcher.ts:284-291`)

```ts
const raw = await entry.handler(frozenCtx);
const out = raw ?? {}; // void -> {}
if (out.result !== undefined && out.result !== null) {
  // preserve null/undefined skip
  results.push(out.result as T);
}
for (const [k, v] of Object.entries(out.provides ?? {})) {
  if (v !== undefined) capabilities[k] = v; // skip undefined (key-presence safety)
}
```

### Edit inventory

- **Contract** (`operation.ts`): add `HookOutput<T>`, widen `handler` return, remove `provides`. (1)
- **Dispatcher** (`dispatcher.ts:284-291`): unwrap + skip-undefined merge. (1)
- **10 provider handlers** (§2 table): delete captured `let` + reset + assignment; `return { provides: {...} }` (or `{ result, provides }` for `agent-module` setup). Removes the reset-then-set idiom entirely; concurrency-safe.
- **Data-returning handlers**: wrap `return X` → `return { result: X }` (the `collect<SomeResult>` producers). Compiler enumerates them.
- **Tests**: `dispatcher.integration.test.ts` inline `provides: () => (...)` handlers (lines ~517/561/607/951/1437/1461/1467) and module integration tests for the 7 provider modules.
- **Docs**: `docs/INTENTS.md` (HookHandler type ~109-111, capability table ~264, example ~268).

---

## 7. Bottom line

- **10 `provides` closures**, in 7 modules; all capture a handler-local `let` (or a constant)
  and the merge is a single host-side `Object.assign` at `dispatcher.ts:290`.
- **Every provided value is a JSON primitive** (number/boolean/string) — the wire needs no
  value encoding; only the delivery mechanism (closure vs returned data) blocks federation.
- **Recommended change:** handlers return a tagged `HookOutput<T> = { result?, provides? }`
  envelope; the dispatcher reads `out.provides` (data) instead of invoking `entry.provides()`
  (closure). **~12 edited sites total** (contract + dispatcher + 10 handlers); consumers,
  `requires` gates, and the capability bag's shape are untouched. Site 9 (`agent-module` setup)
  is the one case proving result and provides must coexist in the return.
