/**
 * A git project's branches as the New workspace form takes them
 * (`project:get-option-choices`): `base`'s choices, and the Name field's
 * suggestions, and the names an existing branch blocks.
 */

import type { BaseInfo } from "../../boundaries/platform/git-types";
import type { ListChoicesHookResult } from "../../intents/get-option-choices";
import { clashingBranch, namesRuledOutBy } from "../../utils/branch-names";

const LOCAL_GROUP = "Local Branches";
const REMOTE_GROUP = "Remote Branches";

/**
 * Every branch a choice for `base`, local ones first, the project's default
 * preselected (else the first); every branch a workspace name can be derived
 * from a name suggestion, which sets the base that branch was made from.
 */
export function branchChoices(
  bases: readonly BaseInfo[],
  defaultBase: string | undefined
): ListChoicesHookResult {
  const ordered = [...bases.filter((b) => !b.isRemote), ...bases.filter((b) => b.isRemote)];
  const groupOf = (base: BaseInfo): string => (base.isRemote ? REMOTE_GROUP : LOCAL_GROUP);
  const preselect =
    defaultBase !== undefined && bases.some((b) => b.name === defaultBase)
      ? defaultBase
      : ordered[0]?.name;
  const local = bases.filter((b) => !b.isRemote).map((b) => b.name);
  return {
    blockedNames: local.flatMap((branch) => {
      const { exact, prefix } = namesRuledOutBy(branch);
      const reason = `Clashes with branch '${branch}' (git cannot have both)`;
      return [...exact.map((name) => ({ name, reason })), { name: prefix, prefix: true, reason }];
    }),
    fields: {
      base: {
        choices: ordered.map((b) => ({ value: b.name, group: groupOf(b) })),
        ...(preselect !== undefined && { default: preselect }),
        ...(bases.length === 0 && { empty: "No base branches available" }),
      },
    },
    nameSuggestions: ordered.flatMap((b) =>
      // A remote branch whose name clashes with a local one (`origin/a/b` next to `a`) cannot be checked out.
      b.derives === undefined || clashingBranch(b.derives, local) !== undefined
        ? []
        : [
            {
              value: b.name,
              label: b.derives,
              group: groupOf(b),
              ...(b.base !== undefined && { sets: { base: b.base } }),
            },
          ]
    ),
  };
}
