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
 * How one adapter narrows and pre-fills an operation's input.
 *
 * `pick` limits which fields that adapter accepts; `defaults` fills fields the
 * caller omitted. Both exist for divergences that are deliberate — an adapter
 * that deliberately hides a field, or keeps a different default from another.
 */
export interface InputShaping {
  readonly pick?: readonly string[];
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
   * confusing message about a missing field.
   */
  async invoke(
    entry: AnyOperationEntry,
    ctx: OperationContext,
    rawInput: unknown,
    shaping: InputShaping = {}
  ): Promise<unknown> {
    if (entry.requiresWorkspace && ctx.workspacePath === null) {
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

/**
 * Narrow the caller's input to what the adapter accepts, then lay its defaults
 * underneath.
 *
 * Defaults go underneath rather than over the top so an explicit value from the
 * caller always wins and the default only fills a field that was omitted.
 */
function applyShaping(rawInput: unknown, shaping: InputShaping): unknown {
  if (shaping.pick === undefined && shaping.defaults === undefined) {
    return rawInput;
  }
  const input: Record<string, unknown> =
    rawInput !== null && typeof rawInput === "object"
      ? { ...(rawInput as Record<string, unknown>) }
      : {};

  const picked = shaping.pick
    ? Object.fromEntries(Object.entries(input).filter(([key]) => shaping.pick!.includes(key)))
    : input;

  return { ...(shaping.defaults ?? {}), ...picked };
}

/** Render a validation failure as one line, prefixed with the operation name. */
function formatZodError(error: z.ZodError, operation: string): string {
  const issue = error.issues[0];
  if (!issue) return `${operation}: invalid input`;
  const path = issue.path.join(".");
  return path ? `${operation}: ${path}: ${issue.message}` : `${operation}: ${issue.message}`;
}
