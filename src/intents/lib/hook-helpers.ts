/**
 * Shared helpers for operation hook handling.
 *
 * Operations call `hooks.collect()` and then apply one of a small set of
 * policies to the returned results and errors. These helpers are the single
 * source of truth for those policies:
 *
 * - `throwHookErrors` — the standard fatal-hook error guard: a lone error is
 *   rethrown raw (preserving its message for IPC/MCP callers), multiple
 *   errors are wrapped in an AggregateError.
 * - `lastDefined` — last-write-wins extraction of a single field across
 *   handler results.
 * - `requireResult` — guard for hook points that must produce a result.
 * - `mergeHookResults` — conflict-throwing field merge (multiple handlers may
 *   each contribute a disjoint subset of fields).
 * - `collectErrorMessages` — fold collect() errors plus per-result `error`
 *   strings into one list (best-effort pipelines that report instead of throw).
 * - `streamProgress` — bridge a progress-callback API into an async generator of
 *   frames, so a streaming hook handler can `yield*` its progress while a
 *   callback-driven task (binary download, git clone) runs.
 */

/**
 * Standard error guard for fatal hook points.
 * Rethrows a lone error raw; aggregates multiple errors under `message`.
 */
export function throwHookErrors(errors: readonly Error[], message: string): void {
  if (errors.length === 1) throw errors[0]!;
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/**
 * Last-write-wins extraction over hook results: returns the value picked from
 * the last result for which `pick` returned a defined value.
 * `null` is a valid value — only `undefined` means "not provided".
 */
export function lastDefined<T, V>(
  results: readonly T[],
  pick: (result: T) => V | undefined
): V | undefined {
  let value: V | undefined;
  for (const result of results) {
    const picked = pick(result);
    if (picked !== undefined) value = picked;
  }
  return value;
}

/** Guard for hook points that must produce a result. */
export function requireResult<V>(value: V | undefined, message: string): V {
  if (value === undefined) throw new Error(message);
  return value;
}

/** Merge hook results field-by-field. Throws if two handlers contribute the same field. */
export function mergeHookResults<T extends object>(
  results: readonly T[],
  hookPoint: string
): Partial<T> {
  const merged: Record<string, unknown> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      if (value !== undefined) {
        if (key in merged) {
          throw new Error(`${hookPoint} hook conflict: "${key}" provided by multiple handlers`);
        }
        merged[key] = value;
      }
    }
  }
  return merged as Partial<T>;
}

/**
 * Fold collect() errors and per-result `error` strings into one message list.
 * Used by best-effort pipelines (delete-workspace) that surface errors via
 * progress events instead of throwing.
 */
export function collectErrorMessages(
  results: readonly { readonly error?: string }[],
  collectErrors: readonly Error[]
): string[] {
  const errors: string[] = collectErrors.map((e) => e.message);
  for (const result of results) {
    if (result.error) errors.push(result.error);
  }
  return errors;
}

/**
 * Bridge a callback-driven async task into an async generator of progress frames.
 *
 * A streaming hook handler `yield*`s this while `run` executes: `run` receives an
 * `emit(frame)` callback (a plain local function — no host closure) and drives the
 * underlying callback-based work (e.g. `downloadBinary`, `gitClient.clone`). Frames
 * are buffered and yielded in order as they arrive; when `run` settles the generator
 * finishes, re-throwing any error `run` produced (after draining remaining frames).
 *
 * Yielding is race-free: `emit` only runs on a later async tick, never interleaved
 * within the synchronous stretch where the drain loop parks a `wake` resolver, so a
 * frame emitted while parked always wakes the loop.
 */
export async function* streamProgress<F>(
  run: (emit: (frame: F) => void) => Promise<void>
): AsyncGenerator<F, void, void> {
  const buffer: F[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: unknown;

  const emit = (frame: F): void => {
    buffer.push(frame);
    if (wake) {
      wake();
      wake = null;
    }
  };

  void run(emit)
    .catch((err: unknown) => {
      failure = err ?? new Error("progress task failed");
    })
    .finally(() => {
      done = true;
      if (wake) {
        wake();
        wake = null;
      }
    });

  while (true) {
    if (buffer.length > 0) {
      yield buffer.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  if (failure !== undefined) throw failure;
}
