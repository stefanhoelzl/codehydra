/**
 * Clearing what an instance inherited from the CodeHydra that launched it.
 *
 * `_CH_*` variables are what CodeHydra sets for its own children: the agent
 * wrappers, the hook handler, `ch`. An app started from inside a CodeHydra
 * workspace (`pnpm dev`, `pnpm preview`, an e2e run) inherits that instance's
 * set — its API port and token above all — and would hand them on to every
 * process it spawns, so a `ch` in a plugin hook or an editor terminal would
 * talk to the parent instance instead of this one. Every child that needs one
 * of these gets it set explicitly by this instance, so none is worth keeping.
 *
 * `CH_*` (no leading underscore) is the config channel and `_CHDEV_*` the
 * launcher's own inputs (the root override); neither matches.
 */

const INHERITED_PREFIX = "_CH_";

/** Delete every `_CH_*` variable from `env`, returning the names removed. */
export function clearInheritedEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((key) => key.startsWith(INHERITED_PREFIX));
  for (const key of removed) delete env[key];
  return removed;
}
