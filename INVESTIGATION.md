# Why `isolate: false` breaks the vitest suite

Investigated at `68fabed3`. All measurements taken on this machine (16 cores) under
`taskset -c 0-3` to approximate a 4-core CI runner, best of 2 runs, with the vitest duration
cache cleared before each run.

> **Sections 1–7 describe the bug as found.** The fix has since been implemented on this
> branch — see **§9** for what changed and the measured result (52.98s → 35.91s, −32%).

---

## Summary

There is **one root cause**, not five. Every failure is the same bug wearing different clothes:

> Under `isolate: false` a source module is **evaluated once per worker**. Its ESM import
> bindings are permanently wired to whatever mock instance existed at that first evaluation.
> Every _later_ test file in the same worker gets its **own fresh mock instance** from its own
> `vi.mock` factory, asserts against it — and the cached module under test never touches it.
> The spy reports 0 calls.

`restoreMocks` / `clearMocks` (`vitest.config.ts:16-17`) reset call _history_. They do not
re-point a module's import bindings, and they do not re-evaluate a cached module. They are
irrelevant to this failure mode.

Consequences:

- **The blast radius is larger than reported.** The report lists 5 files. Forcing the worst case
  (one registry per project, `--no-isolate --no-file-parallelism`) surfaces **11 files / 53
  failing tests**.
- **Almost all of it is test-owned**, not a production design problem. 10 of 11 files fail purely
  because a `vi.mock` factory instance was captured at import time.
- **There is exactly one genuine production hidden singleton** — `ElectronLog` mutating the
  `electron-log/main` global transports (`src/boundaries/platform/electron-log.ts:437-453`). It is
  not the _cause_ of any failure, but it is what turns a stale mock binding into a real
  `EACCES: mkdir '/test/app-data/logs'`.
- **The per-project escape hatch does not exist.** `isolate: false` on the `node` project alone
  still fails, because `node` is precisely where `electron-log.test.ts`, `main.test.ts` and
  `wrapper.integration.test.ts` live.
- **The win is real and large** (−35% wall on a 4-core runner), but it is _not_ where you'd
  guess: the `boundary` project is the long pole and gains nothing from `isolate: false`.

Verdict: **adopt `isolate: false`, but only after fixing the 11 files**, and keep `boundary`
isolated (it costs ~0.4s and is where a shared registry is most dangerous).

---

## 1. The mechanism, proven

The cleanest demonstration is the `extensions` project, where two files mock `vscode` with
**different factories**:

|     | file                                                                  | mock                                                                               |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A   | `extensions/dictation/src/config.test.ts:5`                           | `{ workspace: { getConfiguration: vi.fn() } }` — bare `vi.fn`, configured per test |
| B   | `extensions/dictation/src/DictationController.integration.test.ts:15` | full mock; `getConfiguration()` returns hard-coded values (`:29-40`)               |

Both files reach the same production module, `extensions/dictation/src/config.ts:1`:

```ts
import * as vscode from "vscode";
// ...
export function getConfig(): DictationConfig {
  const config = vscode.workspace.getConfiguration("codehydra.dictation");   // config.ts:25
```

`DictationController.integration.test.ts` imports `config.ts` transitively; `config.test.ts`
imports it directly.

**Each file passes alone:**

```
$ vitest run --project extensions --no-isolate <one file>
  config.test.ts                       -> Tests  3 passed (3)
  DictationController.integration.test -> Tests 42 passed (42)
```

**Together, the file that runs _second_ always fails** — and it is always the one whose mock got
orphaned:

```
run order: DictationController -> config          => config.test.ts FAILS (3 tests)
run order: config -> DictationController          => DictationController FAILS (34 tests)
```

### The decisive detail: two mock instances coexist

`config.test.ts:28` fails with:

```
expect(config.provider).toBe("auto")
  Expected: "auto"
  Received: "assemblyai"
```

`"assemblyai"` is not a default. It is hard-coded in **the other file's** factory
(`DictationController.integration.test.ts:31`), alongside `connectionTimeout: 2000`
(`:33`) — which is exactly the other value `config.test.ts` reports wrong.

This rules out the "one shared `vscode` mock" explanation. If `vscode` were a single shared
module instance, then `config.test.ts`'s

```ts
vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet });
```

would have reconfigured the very function `config.ts` calls, and the test would pass. It does
not. Therefore:

- `config.ts` is **cached**, still holding a live ESM binding to **B's** `vscode` namespace;
- `config.test.ts`'s own `import * as vscode` resolves to a **fresh** namespace built by **A's**
  factory, which nothing under test consumes.

So: _the module registry is shared across files; the mock registry is not._ The consumer keeps
the first mock; the latecomer talks to a mock nobody listens to.

That single sentence explains all 11 files.

---

## 2. Why the failing set is nondeterministic

Two independent sources compound.

### 2a. The sequencer has a feedback loop: "run failed first"

`node_modules/vitest/dist/chunks/coverage.Bri33R1t.js:47-75` — `BaseSequencer.sort()`:

```js
const aState = cache.getFileTestResults(keyA);
const bState = cache.getFileTestResults(keyB);
if (!aState || !bState) {
  ...
  return statsB.size - statsA.size;      // cold cache: larger files first
}
// run failed first
if (aState.failed && !bState.failed) return -1;
if (!aState.failed && bState.failed) return 1;
// run longer first
return bState.duration - aState.duration;
```

That cache is persisted to `node_modules/.vite/vitest/<hash>/results.json` and carries
`{ duration, failed }` per file **from the previous run**.

Now trace the loop. Suppose `config.test.ts` failed last run. It is promoted to the front of its
project. It therefore **wins the import race** and passes — which displaces
`DictationController`, which now runs second and fails. Next run, roles swap again.

Predicted: a period-2 oscillation. Observed, six consecutive identical invocations:

```
run 1 victim: config.test.ts
run 2 victim: DictationController.integration.test.ts StatusBar.test.ts
run 3 victim: config.test.ts
run 4 victim: DictationController.integration.test.ts StatusBar.test.ts
run 5 victim: config.test.ts
run 6 victim: DictationController.integration.test.ts StatusBar.test.ts
```

The same oscillation drives the `node` project's `EACCES` symptom (§4):

```
run 1: EACCES lines=17  victims: electron-build-info.test.ts electron-log.test.ts
run 2: EACCES lines=0   victims: <none>
run 3: EACCES lines=17  victims: electron-log.test.ts
run 4: EACCES lines=0   victims: <none>
```

**A green rerun is not evidence of a fix.** It is evidence that the failure moved.

Two corollaries worth knowing:

- With a **cold** cache, ordering is deterministic: largest file first. (I initially misread this
  as "vitest honours CLI argument order in reverse". It does not — clearing the cache produces
  the identical order regardless of the order files are passed on the command line. The apparent
  arg-order sensitivity was the warm cache from the preceding run.)
- `sort()` also orders `isolate: true` projects before `isolate: false` ones, so a mixed-mode
  config changes global file ordering as a side effect.

### 2b. Worker distribution decides who shares a registry

Files are dealt across pool workers, and **each worker has its own module registry**. Two
competing files only collide if they land in the same worker. Which files co-reside depends on
dispatch timing, so it varies run to run and machine to machine.

This is why the renderer failures you saw did not reproduce for me at default parallelism (32
renderer files spread thinly across workers), and why forcing one worker per project exposes the
full set at once:

```
$ vitest run --no-isolate --no-file-parallelism
  Test Files  11 failed | 174 passed | 1 skipped (186)
       Tests  53 failed | 3513 passed | 32 skipped (3598)
```

Between (2a) and (2b), _the set of failing files is a function of machine timing and of the
previous run's results._ That is the whole explanation for the nondeterminism.

---

## 3. Per-file root cause

All three renderer entries share one conduit: `src/renderer/lib/api` is mocked by four different
files with four different factories, while the components that consume it are cached.

| #   | Test file                                                             | Mocked module           | Cached consumer (keeps the first mock)                          | Owner                 | Verdict  |
| --- | --------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- | --------------------- | -------- |
| 1   | `src/renderer/lib/components/DialogView.test.ts:17`                   | `$lib/api`              | `form/Form.svelte:37` (`import { sendDialogEvent }`)            | test                  | test bug |
| 2   | `src/renderer/lib/components/PanelView.test.ts:18`                    | `$lib/api`              | `form/Form.svelte:37`                                           | test                  | test bug |
| 3   | `src/renderer/lib/components/MainView.integration.test.ts:43`         | `$lib/api`              | `MainView.svelte:27` (`import * as api`)                        | test                  | test bug |
| 4   | `src/renderer/lib/components/MainView.test.ts:32`                     | `$lib/api`              | `MainView.svelte:27`                                            | test                  | test bug |
| 5   | `src/main.test.ts:32`                                                 | `electron`              | `boundaries/platform/electron-build-info.ts` (`import { app }`) | test                  | test bug |
| 6   | `src/boundaries/platform/electron-build-info.test.ts:20`              | `electron`              | same                                                            | test                  | test bug |
| 7   | `src/modules/agent-module/claude/wrapper.integration.test.ts:18`      | `node:fs`               | `claude/wrapper.ts:23`                                          | test                  | test bug |
| 8   | `src/modules/agent-module/claude/wrapper.test.ts`                     | _(none — uses real fs)_ | `claude/wrapper.ts:23`                                          | test                  | test bug |
| 9   | `extensions/dictation/src/config.test.ts:5`                           | `vscode`                | `dictation/src/config.ts:1`                                     | test                  | test bug |
| 10  | `extensions/dictation/src/DictationController.integration.test.ts:15` | `vscode`                | `dictation/src/config.ts:1`                                     | test                  | test bug |
| 11  | `src/boundaries/platform/electron-log.test.ts:30`                     | `electron-log/main`     | `boundaries/platform/electron-log.ts:12`                        | **test + production** | see §4   |

Also observed failing in the single-worker run and belonging to the same classes:
`src/renderer/App.test.ts`, `src/renderer/lib/components/ErrorBoundary.test.ts`,
`src/renderer/lib/integration.test.ts`, `extensions/dictation/src/StatusBar.test.ts:16`.

Three notes on the shape of the races:

- **`$lib/api` (4 files, 4 factories).** `Form.svelte:37` uses a _named_ import and
  `MainView.svelte:27` a _namespace_ import. Both bind once. Whichever of DialogView / PanelView
  loads `Form.svelte` first owns `sendDialogEvent` for the rest of the worker's life; same for
  MainView's two test files over `MainView.svelte`.

- **`electron` (3 files, 3 factories):** `main.test.ts:32`,
  `electron-build-info.test.ts:20`, `preload/index.test.ts:23`. `electron-build-info.ts` binds
  `app` once. `main.test.ts` then sets its own `mockIsPackaged = true` and observes `false`,
  because `electron-build-info.ts` is reading the _other_ file's mock.

- **`node:fs` (a symmetric 2-file race).** `wrapper.integration.test.ts:18` mocks `node:fs`;
  `wrapper.test.ts` imports the same `wrapper.ts` and deliberately uses the **real** fs
  (`mkdtempSync` / `writeFileSync`). `wrapper.ts:23` can bind to only one of them. **This pair
  can never both pass under a shared registry** — one side always loses. It is the clearest proof
  that these tests are structurally incompatible with `isolate: false`, not merely unlucky.

---

## 4. The one genuine production design issue: `ElectronLog`

`src/boundaries/platform/electron-log.ts:12` imports the `electron-log/main` **singleton**, and
the `ElectronLog` **constructor mutates its global state**:

```ts
constructor(pathProvider: PathProvider) {
  log.transports.file.level = false;          // :437
  log.transports.console.level = false;       // :438
  ...
  log.transports.file.resolvePathFn = (): string => this.logPath;   // :444
  log.transports.file.maxSize = 20 * 1024 * 1024;                   // :449
  log.transports.file.format = TEXT_FORMAT;                         // :452
  log.transports.console.format = TEXT_FORMAT;                      // :453
}
```

`configure()` mutates the same globals again (`:462-468`).

This is a hidden singleton by any definition: **constructing `ElectronLog` twice in one process
reconfigures shared global transports.** In production it is benign — `src/main.ts` builds
exactly one. In tests it is what converts a stale mock binding into filesystem damage.

**Verified: the `EACCES` symptom still reproduces on `68fabed3`** (the report asked, since
`212e7a03` rewrote the file):

```
[error] electron-log.transports.file: Can't write to /test/app-data/logs/2026-07-09T14-38-49-dbc4d0dd.log
        Error: EACCES: permission denied, mkdir '/test/app-data/logs'
```

The causal chain:

1. Some other node-project file evaluates `electron-log.ts` first, binding `log` to the **real**
   `electron-log/main`. There is no shortage of candidates: `boundaries/platform/logging.ts:15`
   re-exports `ElectronLog`, `src/modules/logging-module.ts:16` imports from it, and **47
   non-test source modules** import the logging barrel. None of them mock `electron-log/main`.
2. `electron-log.test.ts` then constructs `ElectronLog` with a fake path provider
   (`dataRootDir: "/test/app-data"`, `electron-log.test.ts:72`).
3. Because of the constructor above, that fake absolute path is written onto the **real**
   transport's `resolvePathFn`, and `configure()` enables the transport.
4. The next log call drives the real file transport at `/test/app-data/logs` → `EACCES`.

So the test's assertion failures (`typeof mockTransports.file.format` → `undefined`;
`scopeLogger.info` → 0 calls) are the test bug, and the `EACCES` is the _production_ hidden
singleton amplifying it. Injecting the log object (or the transports) instead of importing and
mutating the module singleton would fix both: the test would need no module mock at all.

This is the only file where I would call the production code at fault, and it is the only one
where the fix genuinely improves the design rather than merely appeasing the test runner.

---

## 5. Measurements

`taskset -c 0-3`, best of 2, cold duration cache before every run.

### Full suite

| Config                             |      Wall |                   Δ | `setup` |
| ---------------------------------- | --------: | ------------------: | ------: |
| `isolate: true` (today)            | **52.8s** |                   — |  14.59s |
| `isolate: false` everywhere        | **34.5s** | **−18.4s (−34.8%)** |   1.30s |
| `isolate: false` except `boundary` | **34.9s** |     −17.9s (−33.9%) |   2.11s |
| `isolate: false` on `node` only    | **42.8s** |     −10.0s (−19.0%) |   5.35s |

The baseline reproduces your 52.3s, and the all-projects figure reproduces your 36.3s.

### Per project, run alone

| Project      | Files | `isolate: true` | `isolate: false` | Δ wall | `setup` before → after |
| ------------ | ----: | --------------: | ---------------: | -----: | ---------------------- |
| `boundary`   |    17 |       **30.5s** |        **29.2s** |  −1.4s | 1.52s → 0.56s          |
| `node`       |   123 |           18.3s |             7.2s | −11.1s | 11.90s → 0.76s         |
| `renderer`   |    32 |           11.4s |             5.7s |  −5.7s | 3.00s → 0.43s          |
| `extensions` |    14 |            3.2s |             2.8s |  −0.5s | 1.58s → 0.59s          |

### Reading the numbers

- **`boundary` is the long pole, and `isolate: false` cannot help it.** 17 files, but 76s of
  in-test time: it is I/O-bound against real external systems, not setup-bound. It alone floors
  the suite at ~29-30s on 4 cores. Full `isolate: false` lands at 34.5s — only ~5s above that
  floor. The isolation win is nearly exhausted; further speedup has to come from `boundary`.
- **Excluding `boundary` from `isolate: false` costs 0.4s** (34.9s vs 34.5s, within noise).
  That is very cheap insurance for the project whose tests touch real filesystems, ports and
  processes, and where a leaked module singleton would be hardest to debug.
- **`node`-only buys 55% of the win (−10.0s)** — and, critically, **does not sidestep anything**:

```
$ vitest run --config <node-only isolate:false>
  FAIL |node| src/boundaries/platform/electron-log.test.ts
  Test Files  1 failed | 184 passed | 1 skipped (186)
```

`electron-log.test.ts`, `main.test.ts`, `electron-build-info.test.ts` and both `wrapper` files
are all in the `node` project. **Answer to "can we apply it per-project to sidestep the
renderer/extensions failures?" — no.** The `node` project is the _most_ affected, not the least.
Scoping to `node` gives up 45% of the win and still leaves you red.

---

## 6. Recommendation

**Adopt `isolate: false`, on `node` + `renderer` + `extensions`, keeping `boundary` isolated.**
That is 34.9s vs 52.8s — a **−34%** wall-clock win on a 4-core runner, and it scales to the CI
numbers quoted (Windows ~122s, Ubuntu ~67s in vitest). The `setup` collapse (14.6s → 2.1s) is the
entire mechanism, and it is the cost that grows linearly with every new test file.

But it **cannot be turned on first and fixed after**. 11 files must change first. In rough order
of value:

1. **`electron-log.ts` — fix the production code.** Inject the log object / transports rather
   than importing `electron-log/main` and mutating it in the constructor
   (`electron-log.ts:437-453`, `:462-468`). The test then needs no `vi.mock("electron-log/main")`
   at all, the `EACCES` disappears, and a real design smell goes with it. This is the only
   change that is worth making on its own merits, `isolate` aside.

2. **Share one mock instance per mocked module.** For `vscode`, `$lib/api`, and `electron`, the
   problem is _N files × N different factories_. Move each to a single shared mock module (a
   `__mocks__/` entry, or a common `test-utils` factory) that every test file mocks identically,
   and reconfigure per test via `vi.mocked(...)` in `beforeEach`. Then it no longer matters who
   wins the import race: there is only one instance, and it is the one everybody configures.
   This is a mechanical change and it fixes items 1-6 and 9-10 in the §3 table.

3. **`wrapper.test.ts` / `wrapper.integration.test.ts` need a real decision.** They cannot
   coexist under a shared registry — one uses real `node:fs`, the other mocks it, over the same
   `wrapper.ts:23` binding. Either both use the real fs against a temp dir, or `wrapper.ts` takes
   its fs functions as a parameter. (Per `CLAUDE.md`, `wrapper.ts` reaching for `node:fs`
   directly is already outside the `FileSystemBoundary` rule; this is a good excuse to look at
   it.)

4. Only then flip `isolate: false` per project, leaving `boundary: true`.

---

## 7. The standing risk — and why it is worse than it looks

With `isolate: false`, ~186 test files share a module registry per worker. **Any future
module-level singleton, or any `vi.mock` factory captured at import time, silently breaks tests
in an order-dependent way.** Nothing in the type system, the linter, or code review catches it.

The sequencer's `run failed first` rule (§2a) makes this actively hostile rather than merely
fragile:

- A newly-introduced singleton produces a failure that **passes on rerun** — because failing
  promoted the file to the front of the order, where it wins the race.
- CI reruns therefore _systematically launder_ this class of bug into green.
- The bug then reappears on someone else's machine, in a different file, weeks later.

This is the worst possible failure signature: it trains people to press "rerun", and it detaches
the symptom from the change that caused it. Today, `isolate: true` is silently absorbing this —
`wrapper.test.ts` + `wrapper.integration.test.ts` are _already_ an unsatisfiable pair, and nobody
knows, because isolation hides it.

If `isolate: false` is adopted, add guards:

- **A single-worker canary in CI.** `vitest run --no-isolate --no-file-parallelism` maximises
  registry sharing and surfaces the entire class at once (it found all 11 files here, versus 1-2
  per default-parallelism run). It is slow, so run it nightly or on `main`, not per-PR.
- **Delete `node_modules/.vite/vitest` in CI** before the run, so file ordering is deterministic
  (largest-first) rather than a function of the previous run's failures. This alone converts an
  oscillating flake into a stable red.
- **Consider `--sequence.shuffle` with a logged seed** on the nightly job, so ordering is varied
  deliberately and any failure is reproducible from the seed.
- **Make "one shared mock module per mocked dependency" a convention**, enforced by review or a
  lint rule: a per-file `vi.mock(..., factory)` for a module that more than one test file imports
  is the exact shape of this bug.

Without at least the canary and the cache deletion, `isolate: false` trades 18 seconds per CI run
for a class of order-dependent flakes that will cost far more than 18 seconds to diagnose.

---

## 8. Appendix: the fix, validated experimentally

All five experiments below were run against this repo at `68fabed3` and then fully reverted.

### The pattern

Replace the per-file `vi.mock(mod, factory)` — where N test files each build their **own** mock
object — with a single shared fake that every file mocks _to_:

```ts
// src/renderer/lib/api/__mocks__/index.ts   (the one fake, shared by all files)
import { vi } from "vitest";
export const emitEvent = vi.fn();
export const sendDialogEvent = vi.fn();
export const on = vi.fn(() => vi.fn());
```

```ts
// any test file
vi.mock("$lib/api"); // no factory -> resolves to __mocks__
import { sendDialogEvent } from "$lib/api";
const mockSendDialogEvent = vi.mocked(sendDialogEvent);
```

Now there is exactly one `$lib/api` object in the worker, and it is the one every file
configures. Who wins the import race stops mattering.

### Results

| #   | Experiment                                                                                                                          | Result                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `mockReset: true` on the real suite, `isolate: true`                                                                                | **185 files / 3566 tests pass.** Zero blast radius.                                                                                                      |
| 2   | `vi.mock("$lib/api")` with no factory, resolving `src/renderer/lib/api/__mocks__/index.ts`                                          | **Resolves through the `$lib` alias.** No dynamic `import()` needed, so the `no inline dynamic imports` lint rule (212e7a03) is not implicated.          |
| 3   | Convert `DialogView.test.ts`, `PanelView.test.ts`, `form/Form.test.ts` to the shared fake; run `--no-isolate --no-file-parallelism` | **3 failures → 0.** Passes with `mockReset` on _and_ off, and still passes under `isolate: true`.                                                        |
| 4   | Full `renderer` project, single worker, with 3 of 10 `$lib/api` mockers converted                                                   | **7 failing files → 5.** The two converted victims are gone; the residual 5 are the other, unconverted `$lib/api` mockers. The fix generalizes linearly. |
| 5   | `eslint` on the converted files + the fake                                                                                          | **Clean.**                                                                                                                                               |

### The trap: `mockReset` is not optional in general

In a minimal sandbox, three files sharing one fake: file `b` calls
`vi.mocked(whoAmI).mockReturnValue("B")`; file `d` mocks but configures nothing and asserts the
fake's own default. `d` observed **`"B"`**.

`clearMocks` resets call history, `restoreMocks` restores spies — **neither resets a `vi.fn`'s
implementation.** Only `mockReset: true` does (it restores the implementation originally passed
to `vi.fn(impl)`, which is why experiment 1 is a no-op on the existing suite).

Sharing the fake without `mockReset` therefore trades a _loud_ bug (orphaned spy, "called 0
times") for a _silent_ one (a mock quietly carrying another file's implementation). Experiment 3
passed either way only because those particular tests never set an implementation. **Adopt
`mockReset: true` together with the shared fake, not after it.**

### What the pattern cannot fix

Sharing a fake resolves races between files that **all mock**. It does nothing for a race between
a file that mocks and a file that wants the **real** module. Sandbox: a third file importing the
same consumer and expecting the real `dep` received `MOCK-DEFAULT`.

That is exactly the two remaining cases:

- **`node:fs` / `wrapper.ts:23`.** `wrapper.integration.test.ts` mocks it; `wrapper.test.ts`
  deliberately uses real fs. One binding, two irreconcilable demands. **No mock pattern fixes
  this** — `wrapper.ts` must take its fs functions as a parameter. (`CLAUDE.md` already forbids
  its direct `node:fs` import in favour of `FileSystemBoundary`.)
- **`electron-log/main` / `electron-log.ts:12`.** One mocker versus ~122 node test files that
  load `electron-log.ts` through `logging.ts` with the real module. The mocker always loses.

For the latter there _is_ a mocking escape hatch, verified in the sandbox: **`vi.mock()` called
inside a `setupFiles` entry applies to every test file in the project**, so no file can opt out
and no race exists. That is defensible for `electron-log/main` (no test should write log files).
It is unusable for `node:fs`, where many tests legitimately need the real thing.

The better fix for `electron-log.ts` remains dependency injection: it deletes the test's module
mock, the `EACCES`, and the hidden singleton (§4) in one change.

### Revised migration estimate

| Module                   | Mockers | Fix                                        | Effort                  |
| ------------------------ | ------: | ------------------------------------------ | ----------------------- |
| `$lib/api`               |      10 | shared fake                                | mechanical              |
| `vscode`                 |       5 | shared fake                                | mechanical              |
| `electron`               |       4 | shared fake                                | mechanical              |
| `electron-log/main`      |       1 | inject the log object (or setup-file mock) | small production change |
| `node:fs` (`wrapper.ts`) |       2 | inject fs functions                        | small production change |

Plus `mockReset: true` suite-wide (free — experiment 1). Then flip `isolate: false` on
`node` + `renderer` + `extensions`, leaving `boundary` isolated.

---

## 9. What was implemented

`isolate: false` is now on for **all four projects** (`vitest.config.ts`), together with
`mockReset: true`. The full suite, `pnpm check`, `pnpm lint` and `pnpm run format:check` all pass,
as does the new `pnpm test:canary`.

**This includes `boundary`, revising the §6 recommendation.** Projects turn out to have separate
module registries: in the single-worker run that broke 11 files across `node`, `renderer` and
`extensions`, `boundary` was untouched — even though `dialog.boundary.test.ts` mocks `electron`
with its own factory while `main.test.ts` mocks it differently. Boundary is green under the
canary, so the caution in §6 was unnecessary. It buys ~0.4s; the reason to include it is
uniformity, not speed.

### The pattern

Every module that more than one test file mocks now has **one shared fake**, mocked with a bare
`vi.mock(id)` and no factory:

| Module     | Fake                                                                 | Mockers converted |
| ---------- | -------------------------------------------------------------------- | ----------------- |
| `$lib/api` | `src/renderer/lib/api/__mocks__/index.ts`                            | 10                |
| `vscode`   | `__mocks__/vscode.ts`                                                | 5                 |
| `electron` | `src/test/mocks/electron.ts`, re-exported by `__mocks__/electron.ts` | 3                 |

`vi.mock("vscode")` resolves a root `__mocks__/vscode.ts` even though `vscode` has no runtime
package (only `@types/vscode`). The `electron` fake lives under `src/` to stay inside the
`rootDir` of `src/tsconfig.node.json`; the root `__mocks__/electron.ts` is a one-line
`export *` re-export, which keeps it a single module instance.

`mockReset: true` is **not optional** with this pattern. `clearMocks` clears call history and
`restoreMocks` restores spies, but neither resets a `vi.fn`'s implementation — so a
`.mockReturnValue()` set by one file would silently leak into the next, which is a worse failure
mode than the one being fixed. Consequently the fakes pass implementations as `vi.fn(impl)`
(restored by `mockReset`) rather than chaining `.mockReturnValue()` (discarded by it).

### The three cases a shared fake cannot fix

A shared fake only resolves races between files that _all_ mock. These needed something else:

- **`$lib/logging`** (1 mocker vs 4 real importers). `ErrorBoundary.test.ts` now uses the real
  logger and stubs its only side effect, `window.api.emitEvent` — the same seam
  `src/renderer/lib/logging/index.test.ts` already used. No module mock remains.
- **`node:fs` / `wrapper.ts`** (`wrapper.integration.test.ts` mocked it; `wrapper.test.ts` and
  `wrapper.boundary.test.ts` use the real filesystem over the same binding — an unsatisfiable
  pair). `getInitialPromptConfig()` now takes an injected `InitialPromptFs`, defaulting to the
  real functions, mirroring the `runClaude(options, deps = defaultDeps)` idiom already in that
  file. The test injects a fake; every assertion is preserved. This also removes the direct
  `node:fs` use that `CLAUDE.md` forbids.
- **`electron-log/main`** (1 mocker vs ~122 node test files loading the real module through
  `logging.ts`). Following the precedent of `f79033cb` _("remove mock-based tests covered by
  boundary tests")_, `electron-log.test.ts` is now mock-free and covers only the pure parsing
  helpers. The behaviour it asserted through the mock moved to
  `electron-log.boundary.test.ts` (8 → 14 tests), which drives the **real** `electron-log` and
  asserts on the files it writes: JSON-format output (message/context/error as structured
  fields), text-mode context appending, and logger-name filtering. The `EACCES` symptom is gone
  with the mock.

Net test count: 3566 → 3548. `electron-log.test.ts` shed 24 mock-based tests; the boundary test
gained 6 that exercise the real module. No assertion was weakened.

### Measured result

`taskset -c 0-3`, best of 2, cold duration cache:

|                          |       Wall |   `setup` |
| ------------------------ | ---------: | --------: |
| before (`isolate: true`) |     52.98s |    14.23s |
| after (`isolate: false`) | **35.91s** | **1.29s** |

**−17.1s, −32.2%.** The `setup` collapse is the entire mechanism, and it is the cost that grows
with every new test file.

### The guard

`pnpm test:canary` (`vitest run --no-file-parallelism`) forces every file in a project into one
worker, i.e. one module registry — the maximal-contamination configuration. Before this change it
failed on 11 files / 53 tests; it now passes. Run it in CI (nightly or on `main`), because the
default parallel run only catches a regression when the two colliding files happen to land in the
same worker.

Also delete `node_modules/.vite/vitest` in CI: vitest's sequencer runs previously-failed files
first (§2a), so a stale duration cache makes this class of failure oscillate between runs rather
than fail consistently.

### Known residuals

- **`ElectronLog` still mutates the `electron-log/main` global transports** at
  `electron-log.ts:437-453` and `:462-468` (§4). Nothing depends on it any more — no test mocks
  that module — but constructing `ElectronLog` twice in one process still reconfigures shared
  global state. Injecting the log object would remove the last hidden singleton here.
- **The `boundary` project still contains two `vi.mock` calls**: `dialog.boundary.test.ts:18`
  (`electron`) and `filesystem.boundary.test.ts:24` (`node:fs/promises`, an `importOriginal`
  passthrough). Neither collides with anything today, and the project is green under the canary.
  A third mock in that project is the next thing that would break, which is what the canary is
  for.
- **Nothing prevents a future per-file `vi.mock(id, factory)`** from reintroducing the bug. The
  canary is the only mechanical guard; a lint rule forbidding factory-form `vi.mock` for modules
  imported by more than one test file would be stronger.
