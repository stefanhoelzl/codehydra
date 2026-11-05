/**
 * Automation registry entries — `ch automation list|add|remove`.
 *
 * One automation at a time, where `ch plugin add|remove` handle whole sources.
 * An automation is a file in a plugins folder: these write and delete that file,
 * in `~/.codehydra/plugins` or, with `repo`, in a workspace's `.codehydra/plugins`.
 * Nothing is ever committed: a repository's automations run from its default
 * branch, so one added there takes effect once it is merged.
 */

import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { AutomationFile, AutomationListing, EntryDeps } from "./deps";
import { createPluginScopeResolver } from "./plugin";
import { targetFields } from "./target";

const nameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "an automation's name uses letters, digits, - and _ (and starts with a letter or digit)"
  )
  .describe("The automation's name, and its file's: <name>.yaml");

const repoSchema = z
  .boolean()
  .optional()
  .describe("The workspace's .codehydra/plugins instead of ~/.codehydra/plugins");

/** A listing as a row: strings throughout, so the human table has no odd cells. */
function row(automation: AutomationListing): Record<string, string> {
  return {
    automation: automation.automation,
    state: automation.state,
    schedule: automation.schedule ?? "",
    next: automation.nextRun ?? "",
    path: automation.path,
  };
}

function fileRow(file: AutomationFile): Record<string, string> {
  return {
    automation: file.automation,
    plugin: file.plugin,
    path: file.path,
    takesEffect: file.takesEffect,
  };
}

export function automationEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const scopeOf = createPluginScopeResolver(deps.dispatcher);

  const list = defineEntry({
    name: "automation.list",
    kind: "command",
    description: "List automations: yours, and each open project's",
    instructions:
      "One row per automation that can run: <plugin>/<name>, its plugin's state (enabled, " +
      "disabled, or ask when not answered yet), its schedule and next scheduled time (empty: " +
      "every poll) and where it is. A repository's are those on its default branch: one not " +
      "merged yet is not listed.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () => (await deps.plugins().automations()).map(row),
  });

  const add = defineEntry({
    name: "automation.add",
    kind: "command",
    description: "Add an automation",
    instructions:
      "Writes <name>.yaml holding one automation. By default in ~/.codehydra/plugins, where it " +
      "runs from the next poll, without asking. With repo, in the workspace's " +
      ".codehydra/plugins, uncommitted: it runs once it is committed, merged to the default " +
      "branch and trusted. The script's text is stored as written and must print a JSON array " +
      "of items (`ch plugin schema --items`); no file is copied, so a file it names must be " +
      "there when it runs. Refused if the folder already has a plugin by that name.",
    input: z.object({
      name: nameSchema,
      script: z.string().min(1).describe("The script itself"),
      schedule: z
        .string()
        .min(1)
        .optional()
        .describe(
          "When to run: a 5-field cron expression in local time (default: every poll). " +
            "It runs at the first poll after each time it names."
        ),
      shell: z
        .enum(["bash", "powershell", "cmd"])
        .optional()
        .describe("The shell it is written for (default: bash)"),
      repo: repoSchema,
      ...targetFields,
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) =>
      fileRow(
        await deps.plugins().addAutomation(await scopeOf(ctx, input), {
          name: input.name,
          script: input.script,
          repo: input.repo === true,
          ...(input.schedule !== undefined && { schedule: input.schedule }),
          ...(input.shell !== undefined && { shell: input.shell }),
        })
      ),
  });

  const remove = defineEntry({
    name: "automation.remove",
    kind: "command",
    description: "Remove an automation",
    instructions:
      "Deletes <name>.yaml, by default from ~/.codehydra/plugins, with repo from the " +
      "workspace's .codehydra/plugins (uncommitted: it stops once that is merged). Only a file " +
      "holding just that automation: one with anything more, a folder plugin, or an automation " +
      "from another source is refused, with its path, to edit by hand. Workspaces it created " +
      "stay; what it was tracking is forgotten.",
    input: z.object({ name: nameSchema, repo: repoSchema, ...targetFields }),
    requiresWorkspace: false,
    handler: async (ctx, input) =>
      fileRow(
        await deps
          .plugins()
          .removeAutomation(await scopeOf(ctx, input), input.name, input.repo === true)
      ),
  });

  return [list, add, remove];
}
