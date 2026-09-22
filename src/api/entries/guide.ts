/**
 * The user guide entry — `ch guide`, MCP `guide`.
 *
 * The same docs/USER_GUIDE.md the site renders and the help dialog shows,
 * shipped beside the system prompts. This is how an agent inside a workspace
 * learns how CodeHydra works (hooks, config, auto-workspaces, shortcuts) instead
 * of guessing: its system prompt points here.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps } from "./deps";
import { guideSections } from "../../shared/user-guide";

export function guideEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const guide = defineEntry({
    name: "guide",
    kind: "command",
    description: "Print CodeHydra's user guide, or one section of it.",
    instructions:
      "How CodeHydra itself works: workspaces, shortcuts, configuration, automatic " +
      "workspaces, repository hooks (.codehydra/hooks), the ch CLI and MCP. Pass a section " +
      "slug (e.g. 'repository-hooks') to get just that part; an unknown slug fails and " +
      "lists the valid ones.",
    input: z.object({
      section: z
        .string()
        .min(1)
        .optional()
        .describe("Section slug, e.g. 'repository-hooks'. Omit for the whole guide"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const markdown = await deps.readUserGuide();
      if (input.section === undefined) return markdown;

      const sections = guideSections(markdown);
      const match = sections.find((section) => section.slug === input.section);
      if (!match) {
        throw new ApiError(
          "not-found",
          `unknown section "${input.section}"; one of: ${sections.map((s) => s.slug).join(", ")}`
        );
      }
      return match.markdown;
    },
  });

  return [guide];
}
