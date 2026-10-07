/**
 * Who outside CodeHydra may see and change a workspace metadata key.
 *
 * "Outside" is every surface a user or a script reaches: the API (MCP, `ch`,
 * the sidekick extension), plugin actions and automation items. CodeHydra's own
 * modules read and write every key.
 *
 * - `internal`: never shown outside (`metadata.get` omits it).
 * - `protected`: shown, but only CodeHydra's own operations change it —
 *   hibernate/wake flip `hibernated`, creation records `base`, `agent` and `name`,
 *   `ch ws wakeup` writes `wakeup`.
 * - `public`: read and written freely (`title`, `tags.*`, custom keys).
 *
 * The tier also picks the section of the workspace's metadata file the key is
 * stored in (`workspace-metadata-store.ts`).
 */
export type MetadataTier = "internal" | "protected" | "public";

/** Every key that is not public. Anything absent here is public. */
const RESTRICTED_KEYS: Readonly<Record<string, Exclude<MetadataTier, "public">>> = {
  "agent.pending-prompt": "internal",
  agent: "protected",
  base: "protected",
  hibernated: "protected",
  name: "protected",
  source: "protected",
  wakeup: "protected",
};

export function metadataTier(key: string): MetadataTier {
  return RESTRICTED_KEYS[key] ?? "public";
}

/** The metadata as the outside sees it: every key but the internal ones. */
export function visibleMetadata(
  metadata: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => metadataTier(key) !== "internal")
  );
}
