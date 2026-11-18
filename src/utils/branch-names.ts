/**
 * Git keeps a branch as a file under `refs/heads/`, its `/`-separated parts as
 * directories: with a branch `a/b`, `refs/heads/a` is a directory, so there can
 * be no branch `a` — and with a branch `a`, no `a/b`. Git refuses to create one.
 */

/** The parents a branch name's path implies: `a/b/c` → `a`, `a/b`. */
function parentsOf(name: string): string[] {
  const parts = name.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * The existing branch that keeps git from creating a branch `name`: one the
 * new name nests under, or one nested under it. An existing branch of the very
 * name is no clash (it is reused). Undefined when there is none.
 */
export function clashingBranch(name: string, existing: Iterable<string>): string | undefined {
  const parents = new Set(parentsOf(name));
  const nested = `${name}/`;
  for (const branch of existing) {
    if (parents.has(branch) || branch.startsWith(nested)) return branch;
  }
  return undefined;
}

/** Why a branch `name` cannot be created next to the existing branch `clash`. */
export function branchClashMessage(name: string, clash: string): string {
  return `Branch '${clash}' already exists; git cannot have both '${clash}' and '${name}'`;
}

/**
 * The names an existing branch rules out: each of its parents, and every
 * name nested under it (a prefix ending in `/`).
 */
export function namesRuledOutBy(branch: string): { exact: string[]; prefix: string } {
  return { exact: parentsOf(branch), prefix: `${branch}/` };
}
