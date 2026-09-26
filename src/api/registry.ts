/**
 * OperationRegistry — the operations, and the one path into them.
 *
 * The registry knows nothing about MCP, the plugin wire or the CLI. It holds
 * entries and runs them; each adapter owns its own mapping from operation name
 * to whatever it calls things, and hands the shaping it wants to `invoke`.
 *
 * `invoke` is the single entry point to a handler so the rules that must hold on
 * every surface — input shaping, validation, `requiresWorkspace` — cannot be
 * forgotten by an adapter that reaches for a handler directly.
 */

import type { z } from "zod/v4";
import { ApiError } from "./errors";
import type { OperationName } from "./names";
import type { AnyOperationEntry, OperationContext } from "./types";

/**
 * How one adapter pre-fills an operation's input.
 *
 * Every adapter accepts the same fields — an operation means the same thing on
 * every surface, target included. What may differ is a default, and only where
 * the difference is deliberate: an MCP `lock_take` fails fast rather than hang
 * the agent's turn, and `ch ws title` with no title clears it because argv
 * cannot spell null.
 */
export interface InputShaping {
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export class OperationRegistry {
  private readonly byName: ReadonlyMap<OperationName, AnyOperationEntry>;

  constructor(entries: readonly AnyOperationEntry[]) {
    const map = new Map<OperationName, AnyOperationEntry>();
    for (const entry of entries) {
      if (map.has(entry.name)) {
        throw new Error(`Duplicate registry entry name: ${entry.name}`);
      }
      map.set(entry.name, entry);
    }
    this.byName = map;
  }

  all(): readonly AnyOperationEntry[] {
    return [...this.byName.values()];
  }

  /**
   * Look up an operation by name.
   *
   * Throws rather than returning undefined: adapter mappings are exhaustive over
   * the operation vocabulary, so a miss means the registry was built without an
   * entry it promised — a wiring bug, not a runtime condition to branch on.
   */
  get(name: OperationName): AnyOperationEntry {
    const entry = this.byName.get(name);
    if (!entry) {
      throw new Error(`No registry entry for operation "${name}"`);
    }
    return entry;
  }

  /**
   * Look up an operation without insisting it exists.
   *
   * For adapters mounting a whole mapping at once: a missing entry should cost
   * that one operation and a logged complaint, not the caller's connection.
   * Completeness itself is asserted by the registry's conformance tests.
   */
  find(name: OperationName): AnyOperationEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * Run an operation's handler.
   *
   * Workspace enforcement runs before validation so a command written correctly
   * but run outside a worktree reports `no-workspace` (CLI exit 4) rather than a
   * confusing message about a missing field. A caller outside every workspace
   * that names one to act on has given it one.
   */
  async invoke(
    entry: AnyOperationEntry,
    ctx: OperationContext,
    rawInput: unknown,
    shaping: InputShaping = {}
  ): Promise<unknown> {
    if (entry.requiresWorkspace && ctx.workspacePath === null && !namesWorkspace(rawInput)) {
      throw new ApiError(
        "no-workspace",
        `"${entry.name}" acts on a workspace, but no workspace was given. ` +
          `Run it from inside a workspace, or pass an explicit workspace path.`
      );
    }

    const parsed = entry.input.safeParse(applyShaping(rawInput, shaping));
    if (!parsed.success) {
      throw new ApiError("usage", formatZodError(parsed.error, entry.name));
    }

    return entry.handler(ctx, parsed.data as never);
  }
}

/** Whether the input names a workspace to act on (see `targetFields`). */
function namesWorkspace(rawInput: unknown): boolean {
  return (
    rawInput !== null &&
    typeof rawInput === "object" &&
    typeof (rawInput as Record<string, unknown>).workspace === "string"
  );
}

/**
 * Lay the adapter's defaults underneath the caller's input, so an explicit
 * value from the caller always wins and a default only fills a field that was
 * omitted.
 */
function applyShaping(rawInput: unknown, shaping: InputShaping): unknown {
  if (shaping.defaults === undefined) return rawInput;
  const input =
    rawInput !== null && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  return { ...shaping.defaults, ...input };
}

/** Render a validation failure as one line, prefixed with the operation name. */
function formatZodError(error: z.ZodError, operation: string): string {
  const issue = error.issues[0];
  if (!issue) return `${operation}: invalid input`;
  const path = issue.path.join(".");
  return path ? `${operation}: ${path}: ${issue.message}` : `${operation}: ${issue.message}`;
}
