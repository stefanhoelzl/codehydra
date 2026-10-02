/**
 * Registry error categories.
 *
 * The category is what adapters translate into their own failure vocabulary:
 * the CLI maps it to an exit code, MCP to `isError`, the API server to a
 * `ApiResult` error string. Keeping the category on the error means no
 * adapter has to string-match a message to decide how a failure is reported.
 */

import type { ApiErrorCategory } from "../shared/api-protocol";

/** Declared in `shared/api-protocol.ts` beside `ApiResult`, which carries it; see there for each category. */
export type { ApiErrorCategory };

/** Every category, for validating one that arrived over the wire. */
export const API_ERROR_CATEGORIES: readonly ApiErrorCategory[] = [
  "usage",
  "no-workspace",
  "conflict",
  "not-found",
  "failed",
];

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
