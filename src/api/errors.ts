/**
 * Registry error categories.
 *
 * The category is what adapters translate into their own failure vocabulary:
 * the CLI maps it to an exit code, MCP to `isError`, the plugin server to a
 * `PluginResult` error string. Keeping the category on the error means no
 * adapter has to string-match a message to decide how a failure is reported.
 */

/**
 * - `usage` — the call was malformed: unknown operation, or input that failed
 *   validation. CLI exit code 2.
 * - `no-workspace` — the operation needs a workspace and the caller supplied
 *   none. CLI exit code 4. Distinct from `usage` because it is the expected
 *   outcome of running a workspace command outside a worktree, not a mistake in
 *   how the command was written.
 * - `failed` — the operation ran and did not succeed. CLI exit code 1.
 */
export type ApiErrorCategory = "usage" | "no-workspace" | "failed";

export class ApiError extends Error {
  readonly category: ApiErrorCategory;

  constructor(category: ApiErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiError";
    this.category = category;
  }
}

/** Category for an arbitrary thrown value. Anything not an ApiError is a failure. */
export function categoryOf(error: unknown): ApiErrorCategory {
  return error instanceof ApiError ? error.category : "failed";
}
