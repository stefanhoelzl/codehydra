/**
 * The options a git project offers when a workspace is created or deleted.
 *
 * Answered on app:start's `register-project-types`; see
 * `intents/project-type-options.ts` for what one description drives. These
 * names and meanings are what `ch ws create <name> [base] --tracking …` and
 * `ch ws delete --keep-branch` have always taken.
 */

import { z } from "zod/v4";
import type { ProjectTypeDescription } from "../../intents/project-type-options";
import { GIT_PROJECT_TYPE } from "./ref";

export const GIT_PROJECT_OPTIONS = {
  type: GIT_PROJECT_TYPE,
  create: {
    base: {
      kind: "select",
      label: "Base Branch",
      placeholder: "Select branch...",
      choices: "dynamic",
      positional: true,
      description: "Base branch. Omit to use the project's default branch.",
    },
    tracking: {
      kind: "text",
      // The dialog checks a remote branch out by picking it as the name.
      dialog: false,
      description: "Remote branch to check out, e.g. 'origin/feature-login'.",
    },
  },
  delete: {
    keepBranch: { kind: "checkbox", label: "Keep branch", default: false },
  },
  deleteObjections: "uncommitted changes, or unmerged commits on a branch that is not kept",
} as const satisfies ProjectTypeDescription;

const createOptionsSchema = z.object({
  base: z.string().optional(),
  tracking: z.string().optional(),
});

const deleteOptionsSchema = z.object({ keepBranch: z.boolean() });

type OptionsIn = Readonly<Record<string, unknown>> | undefined;

/** Git's create options, as core checked them. */
export function gitCreateOptions(options: OptionsIn): z.infer<typeof createOptionsSchema> {
  return createOptionsSchema.parse(options ?? {});
}

/**
 * Git's delete options, as core checked them. The default is applied again
 * here only for a dispatch that bypassed the check (a test driving git directly).
 */
export function gitDeleteOptions(options: OptionsIn): z.infer<typeof deleteOptionsSchema> {
  return deleteOptionsSchema.parse({ keepBranch: false, ...options });
}
