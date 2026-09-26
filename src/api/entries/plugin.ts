/**
 * Plugin registry entries — `ch plugin list|enable|disable|errors|schema|render`.
 *
 * The plugins themselves live in the plugin module and are reached through
 * `deps.plugins`; these entries turn a caller into the scope a list is read in
 * and shape the answer. A repository's plugins belong to the caller's workspace
 * — the one `ch` resolved from its working directory, or the one `--workspace` names — so a
 * caller outside every workspace sees the user's own plugins only.
 */

import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry, OperationContext } from "../types";
import type { EntryDeps, PluginListing, PluginScope, PluginState } from "./deps";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import type { ResolveWorkspaceIntent } from "../../intents/resolve-workspace";
import { createTargetResolver, targetFields, type TargetInput } from "./target";

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
  const resolveTarget = createTargetResolver(dispatcher);

  /** The workspace the input names, else the caller's — and its project; none outside one. */
  const scopeOf = async (ctx: OperationContext, input: TargetInput): Promise<PluginScope> => {
    const named = input.workspace !== undefined || input.project !== undefined;
    if (!named && ctx.workspacePath === null) return { workspacePath: null, projectPath: null };
    const workspacePath = await resolveTarget(ctx, input);
    const resolved = await dispatcher.dispatch<ResolveWorkspaceIntent>({
      type: INTENT_RESOLVE_WORKSPACE,
      payload: { workspacePath },
    });
    return { workspacePath, projectPath: resolved.projectPath };
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
    input: z.object({ ...targetFields }),
    requiresWorkspace: false,
    handler: async (ctx, input) => (await deps.plugins().list(await scopeOf(ctx, input))).map(row),
  });

  const setState =
    (state: PluginState) => async (ctx: OperationContext, input: TargetInput & { id: string }) =>
      row(await deps.plugins().setState(await scopeOf(ctx, input), input.id, state));

  const enable = defineEntry({
    name: "plugin.enable",
    kind: "command",
    description: "Enable a plugin",
    instructions:
      "For one of this repository's plugins, this is the trust question answered " +
      "'Remember' with it checked: its scripts run from now on, in every workspace of the project.",
    input: z.object({ id: idSchema, ...targetFields }),
    requiresWorkspace: false,
    handler: async (ctx, input) => setState("enabled")(ctx, input),
  });

  const disable = defineEntry({
    name: "plugin.disable",
    kind: "command",
    description: "Disable a plugin",
    instructions:
      "Its scripts stop running — hooks and automations — until it is enabled again. For one " +
      "of this repository's plugins it covers every workspace of the project.",
    input: z.object({ id: idSchema, ...targetFields }),
    requiresWorkspace: false,
    handler: async (ctx, input) => setState("disabled")(ctx, input),
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
    description: "Print the JSON Schema of a plugin manifest, or of an automation's items",
    instructions:
      "Without items: the schema of one document of a plugin manifest (plugin.yaml), with a " +
      "description for every key — point an editor's YAML schema at it. With items: the " +
      "schema of what an automation's script prints — a JSON array whose items each name " +
      "their action and carry that action's input.",
    input: z.object({
      items: z
        .boolean()
        .optional()
        .describe("The items an automation's script prints, instead of the manifest"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) =>
      deps.plugins().schema(input.items === true ? "items" : "manifest"),
  });

  const render = defineEntry({
    name: "plugin.render",
    kind: "command",
    description: "Render items through a Liquid template file",
    instructions:
      "For automation scripts that describe their items as a template: pipe the raw items " +
      "(a JSON array) in, get the rendered items (a JSON array) out — " +
      '`gh pr list --json number,title | ch plugin render "$CH_PLUGIN_DIR/prs.yaml"`. The ' +
      "template is a YAML mapping; every string in it is a Liquid template evaluated against " +
      "one item, every other value is kept as written. Input that is not a JSON array fails, " +
      "so a command that failed and printed nothing is not taken for an empty list.",
    input: z.object({
      template: z
        .string()
        .min(1)
        .describe("The template file (YAML); relative to the current directory"),
      items: z.string().describe("The items to render, a JSON array; '-' reads standard input"),
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const template =
        isAbsolute(input.template) || ctx.cwd === null
          ? input.template
          : join(ctx.cwd, input.template);
      return deps.plugins().render(template, input.items);
    },
  });

  return [list, enable, disable, errors, schema, render];
}
