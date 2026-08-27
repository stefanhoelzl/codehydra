/**
 * Operation registry types — the single source of truth for every operation
 * CodeHydra exposes to the outside world.
 *
 * One entry per operation. The MCP, plugin and CLI adapters are generic loops
 * over the registry: none of them contains per-operation code, so an operation
 * cannot exist on one surface and be missing (or behave differently) on another.
 *
 * See planning/CLI.md for the design and the divergences this collapsed.
 */

import type { z } from "zod/v4";
import type { WorkspacePath } from "../intents/contract";
import type { OperationName } from "./names";

// =============================================================================
// Entry kind
// =============================================================================

/**
 * What an entry *is*, semantically — not how it is transported.
 *
 * - `command` — an instruction to do something. May return data (`workspace.status`)
 *   or nothing (`log`, `workspace.status.set`). A void result does NOT make it an event.
 * - `event` — a report of an occurrence the sender *witnessed*, which each receiver
 *   interprets for itself. Only the observer that saw the occurrence can send one
 *   truthfully, so events are restricted to that observer's adapter.
 *
 * Both kinds are inbound to CodeHydra. An event is not an outbound notification.
 */
export type EntryKind = "command" | "event";

// =============================================================================
// Handler context
// =============================================================================

/**
 * What a handler knows about its caller.
 *
 * `workspacePath` is null for app-global callers — a `ch` invocation from outside
 * any worktree, which is legitimate for `project.list` and `report.issue`. Entries
 * that need a workspace declare `requiresWorkspace`, and adapters reject the call
 * before the handler runs.
 */
export interface OperationContext {
  readonly workspacePath: WorkspacePath | null;
  /**
   * Directory the caller is standing in, when it told us.
   *
   * Only a shell has one — the sidekick and in-app callers leave it null. It is
   * what lets a relative argument mean what the caller expects: `ch project
   * open .` is the natural way to open the repository you are looking at.
   */
  readonly cwd: string | null;
}

// =============================================================================
// Registry entry
// =============================================================================

export interface OperationEntry<TInput = never, TOutput = unknown> {
  /** Stable name from the operation vocabulary. Adapters map it to their own identifiers. */
  readonly name: OperationName;
  readonly kind: EntryKind;
  /** One line. CLI help and the MCP tool summary. */
  readonly description: string;
  /** Long LLM-facing prose. Appended for MCP; shown by `ch <cmd> --help`. */
  readonly instructions?: string;
  /** zod is the single source of truth for the input shape. */
  readonly input: z.ZodType<TInput>;
  /**
   * Whether the operation acts on a specific workspace. When true and the caller
   * supplied none, adapters fail before dispatching (CLI exit code 4).
   */
  readonly requiresWorkspace: boolean;
  readonly handler: (ctx: OperationContext, input: TInput) => Promise<TOutput>;
}

/** An entry with its generics erased, as the registry and adapters hold it. */
export type AnyOperationEntry = OperationEntry<never, unknown>;

// =============================================================================
// Authoring helper
// =============================================================================

/**
 * Declare an entry with the handler's input typed from its own schema.
 *
 * Entries are stored with their generics erased (`AnyOperationEntry`), so
 * writing one as a plain object literal and casting would leave the handler's
 * parameters implicitly `any`. Going through this function keeps the schema as
 * the single source of truth for the handler's input type while still producing
 * the erased shape the registry holds.
 */
export function defineEntry<TSchema extends z.ZodType>(
  entry: Omit<OperationEntry<z.output<TSchema>, unknown>, "input"> & { readonly input: TSchema }
): AnyOperationEntry {
  return entry as unknown as AnyOperationEntry;
}
