/**
 * Config registry entries — reading and writing the user's settings.
 *
 * The same keys the settings dialog edits (see isUserSetting), through the same
 * `Config` write path, so a value set here is validated, persisted to
 * config.json and — for `applies: "live"` keys — in effect immediately, exactly
 * as if it had been saved in the dialog.
 *
 * An unknown key is `not-found` (CLI exit 6) and a value the key rejects is
 * `usage` (exit 2): both are the caller's mistake. `failed` is reserved for a
 * write that did not land, which is an app fault worth an error in the log.
 *
 * Values travel as strings and go through the key's own `parse()`, the one the
 * `--key=value` flag and `CH_*` env vars already use. That keeps a single form
 * on every surface: `ch config set sidebar.width 300` needs no JSON quoting.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps } from "./deps";
import { isUserSetting, type ConfigSource } from "../../boundaries/platform/config";
import {
  OMITTED,
  PersistedValidationError,
  REDACTED,
  redactRejectedValue,
  type PersistedKeyDefinition,
} from "../../boundaries/platform/store-definition";
import { getErrorMessage } from "../../shared/error-utils";

/** One key as `list`, `set` and `reset` report it. */
export interface ConfigRow {
  readonly key: string;
  readonly value: unknown;
  readonly default: unknown;
  readonly source: ConfigSource;
  readonly applies: "live" | "restart";
  /** The accepted values, where the key constrains them (e.g. "claude|opencode"). */
  readonly validValues: string | null;
  /** What the key does — the text the settings dialog and `--help` show. */
  readonly description: string | null;
}

const OVERRIDE_NOTE =
  "An env var or CLI flag (source 'env' or 'cli') outranks config.json: a value set " +
  "over one applies now, but the override wins again when CodeHydra next starts.";

const keyField = z.string().min(1).describe("Config key, e.g. 'sidebar.width'");

/**
 * A value as it may be shown.
 *
 * `redact` hides a value everywhere it is read — a redactor function projects
 * it, and fails closed to the token if it throws. `omit` exists to keep a value
 * out of diagnostics while it is still edited in the clear, so it is honoured
 * only where asked (`list`, which also keeps multi-line values out of a table).
 */
function shown(def: PersistedKeyDefinition<unknown>, value: unknown, honourOmit: boolean): unknown {
  if (honourOmit && def.omit) return OMITTED;
  if (def.redact === undefined) return value;
  if (def.redact === true) return REDACTED;
  try {
    return def.redact(value, REDACTED);
  } catch {
    return REDACTED;
  }
}

export function configEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { config } = deps;

  function definitionOf(key: string): PersistedKeyDefinition<unknown> {
    const def = config.getDefinitions().get(key);
    if (def === undefined || !isUserSetting(key, def)) {
      throw new ApiError(
        "not-found",
        `Unknown config key "${key}". List the keys with config list.`
      );
    }
    return def;
  }

  function rowOf(
    key: string,
    def: PersistedKeyDefinition<unknown>,
    honourOmit: boolean
  ): ConfigRow {
    return {
      key,
      value: shown(def, config.getEffective()[key], honourOmit),
      default: shown(def, config.getDefault(key), honourOmit),
      source: config.getSource(key),
      applies: def.applies ?? "restart",
      // Always present, null when absent: a table takes its columns from keys in
      // first-seen order, so an optional field would shift position by row.
      validValues: def.validValues ?? null,
      // Last: the one long, free-text column, so it runs off the table's end
      // instead of pushing the short ones apart.
      description: def.description ?? null,
    };
  }

  const get = defineEntry({
    name: "config.get",
    kind: "command",
    description: "Get the effective value of one CodeHydra config key.",
    instructions:
      "Returns the bare value in effect now, whichever source it came from (default, " +
      "config.json, env var or CLI flag). A sensitive key reads as '<redacted>'. Use config " +
      "list to see every key with its default, source and whether a change needs a restart.",
    input: z.object({ key: keyField }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const def = definitionOf(input.key);
      return shown(def, config.getEffective()[input.key], false);
    },
  });

  const list = defineEntry({
    name: "config.list",
    kind: "command",
    description: "List every CodeHydra config key with its value, default, source and help.",
    instructions:
      "One row per key: value in effect, default, source (default | user = config.json | env " +
      "| cli), applies ('live' = takes effect at once, 'restart' = on the next start), and " +
      "the key's description and validValues where it has them. " +
      "A sensitive key's value reads as '<redacted>'; a key kept out of diagnostics reads as " +
      "'<omitted>' here but config get returns it. " +
      OVERRIDE_NOTE,
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () =>
      [...config.getDefinitions()]
        .filter(([key, def]) => isUserSetting(key, def))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, def]) => rowOf(key, def, true)),
  });

  const set = defineEntry({
    name: "config.set",
    kind: "command",
    description: "Set a CodeHydra config key and save it to config.json.",
    instructions:
      "The value is a string, parsed as that key's --key=value flag would be: 'true'/'false' " +
      "for booleans, digits for numbers, and an empty string clears a nullable key. Change " +
      "config only when the user asks for it — these are app-wide settings. Returns the key's " +
      "row as config list shows it; applies 'restart' means CodeHydra must be restarted for " +
      "the change to take effect. " +
      OVERRIDE_NOTE,
    input: z.object({
      key: keyField,
      value: z.string().describe("New value, as it would be written on the command line"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const def = definitionOf(input.key);
      const parsed = def.parse(input.value);
      if (parsed === undefined) {
        throw new ApiError(
          "usage",
          new PersistedValidationError({
            key: input.key,
            value: redactRejectedValue(def, input.value),
            reason: "invalid",
            source: "config.set",
            ...(def.description !== undefined && { description: def.description }),
            ...(def.validValues !== undefined && { validValues: def.validValues }),
          }).message
        );
      }
      try {
        await config.set(input.key, parsed);
      } catch (error) {
        // A value that parses but fails validation (out of range, say) is the
        // caller's mistake like any other bad argument; anything else — a
        // config.json that could not be written — is a real failure.
        const category = error instanceof PersistedValidationError ? "usage" : "failed";
        throw new ApiError(category, getErrorMessage(error), { cause: error });
      }
      return rowOf(input.key, def, false);
    },
  });

  const reset = defineEntry({
    name: "config.reset",
    kind: "command",
    description: "Reset a CodeHydra config key to its default (removes it from config.json).",
    instructions:
      "Returns the key's row as config list shows it; applies 'restart' means CodeHydra must " +
      "be restarted for the change to take effect. " +
      OVERRIDE_NOTE,
    input: z.object({ key: keyField }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const def = definitionOf(input.key);
      try {
        await config.reset(input.key);
      } catch (error) {
        throw new ApiError("failed", getErrorMessage(error), { cause: error });
      }
      return rowOf(input.key, def, false);
    },
  });

  return [get, list, set, reset];
}
