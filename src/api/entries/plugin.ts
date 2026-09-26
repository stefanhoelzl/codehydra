/**
 * Plugin registry entries — `ch plugin list|enable|disable|errors|schema`.
 *
 * The plugins themselves live in the plugin module and are reached through
 * `deps.plugins`; these entries turn a caller into the scope a list is read in
 * and shape the answer. A repository's plugins belong to the caller's workspace
 * — the one `ch` resolved from its working directory, or `--workspace` — so a
 * caller outside every workspace sees the user's own plugins only.
 */

import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps, PluginListing, PluginScope, PluginState } from "./deps";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import type { ResolveWorkspaceIntent } from "../../intents/resolve-workspace";

const idSchema = z
  .string()
  .regex(
    /^(local|workspace):[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "a plugin is named local:<name> or workspace:<name>"
  )
  .describe("The plugin: local:<name> (yours) or workspace:<name> (this repository's)");

/** A listing as a row: strings throughout, so the human table has no odd cells. */
function row(plugin: PluginListing): Record<string, string> {
  return {
    name: plugin.id,
    origin: plugin.origin,
    state: plugin.state,
    platforms: plugin.platforms.length === 3 ? "all" : plugin.platforms.join(", "),
    path: plugin.path,
  };
}

export function pluginEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;

  /** The caller's workspace and its project, when it stands in one. */
  const scopeOf = async (ctx: OperationContext): Promise<PluginScope> => {
    if (ctx.workspacePath === null) return { workspacePath: null, projectPath: null };
    const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath: ctx.workspacePath },
    });
    return { workspacePath: ctx.workspacePath, projectPath: resolved.projectPath };
  };

  const list = defineEntry({
    name: "plugin.list",
    kind: "command",
    description: "List plugins: yours, and this repository's",
    instructions:
      "One row per plugin: its name (local:<name> for yours in ~/.codehydra/plugins, " +
      "workspace:<name> for this repository's in .codehydra/plugins), whether it is enabled, " +
      "disabled or not asked about yet (ask), the platforms it has scripts for, and where it " +
      "is. What a plugin contributes is in its manifest; `ch plugin errors` says what is wrong.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async (ctx) => (await deps.plugins().list(await scopeOf(ctx))).map(row),
  });

  const setState = (state: PluginState) => async (ctx: OperationContext, id: string) =>
    row(await deps.plugins().setState(await scopeOf(ctx), id, state));

  const enable = defineEntry({
    name: "plugin.enable",
    kind: "command",
    description: "Enable a plugin",
    instructions:
      "For one of this repository's plugins, this is the trust question answered " +
      "'Remember' with it checked: its scripts run from now on, in every workspace of the project.",
    input: z.object({ id: idSchema }),
    requiresWorkspace: false,
    handler: async (ctx, input) => setState("enabled")(ctx, input.id),
  });

  const disable = defineEntry({
    name: "plugin.disable",
    kind: "command",
    description: "Disable a plugin",
    instructions:
      "Its scripts stop running — hooks and automations — until it is enabled again. For one " +
      "of this repository's plugins it covers every workspace of the project.",
    input: z.object({ id: idSchema }),
    requiresWorkspace: false,
    handler: async (ctx, input) => setState("disabled")(ctx, input.id),
  });

  const errors = defineEntry({
    name: "plugin.errors",
    kind: "command",
    description: "Show what is wrong with plugins",
    instructions:
      "Plugins that cannot run (an invalid manifest, a missing shell) and the last failed run " +
      "of each hook or automation, until it next succeeds or CodeHydra restarts. A failure " +
      "gives the exit and the path of the run's log file, which holds the script's stdin, " +
      "stderr and stdout — read that rather than guessing.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () =>
      deps
        .plugins()
        .errors()
        .map((error) => ({
          plugin: error.plugin,
          entry: error.entry ?? "",
          message: error.message,
          log: error.logPath ?? "",
          at: error.at,
        })),
  });

  const schema = defineEntry({
    name: "plugin.schema",
    kind: "command",
    description: "Print the plugin manifest's JSON Schema",
    instructions:
      "The schema of one document of a plugin manifest (plugin.yaml), with a description for " +
      "every key — the reference for writing a plugin. Point an editor's YAML schema at it.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () => deps.plugins().schema(),
  });

  return [list, enable, disable, errors, schema];
}
