/**
 * A plugin's manifest: what it contributes, as data.
 *
 * A manifest is a YAML stream — one or more `---`-separated documents. Each
 * document says which shell its scripts are written for and which platforms it
 * applies on, then lists its contributions, one top-level section per kind:
 *
 *   description: Poll GitHub for review requests   # optional
 *   shell: bash                                    # bash (default) | powershell | cmd
 *   platform: [linux, macos]                       # default: every platform
 *   hooks:
 *     before-workspace-opened: |
 *       echo '{"env":{"FOO":"1"}}'
 *   automations:
 *     prs: ./prs.sh        # prints the items to act on, see items.ts
 *
 * Every document that matches the platform applies, in file order, so the
 * usual split is one document per platform where scripts differ.
 *
 * The schemas here are the documentation: they are strict (an unknown key is an
 * error, so a typo — or a section a newer CodeHydra added — is reported rather
 * than silently doing nothing) and `ch plugin schema` prints them as JSON Schema
 * for an editor to validate against.
 */

import { z } from "zod/v4";
import { parseAllDocuments } from "yaml";
import { ALL_ENTRIES } from "./hook-map";
import { SHELL_NAMES, type ShellName } from "./shells";
import { describeIssue } from "./util";

// =============================================================================
// Platforms
// =============================================================================

export const PLUGIN_PLATFORMS = ["linux", "windows", "macos"] as const;

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/** The manifest's name for a Node platform, or undefined for one we do not ship on. */
export function pluginPlatformOf(platform: NodeJS.Platform): PluginPlatform | undefined {
  switch (platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return undefined;
  }
}

// =============================================================================
// Contributions
// =============================================================================

const scriptSchema = z
  .string()
  .min(1)
  .describe("The script, in the document's shell. JSON arrives on stdin.");

/** `hooks:` — one script per entry, keyed by the entry's name. */
const hooksSchema = z
  .object(
    Object.fromEntries(ALL_ENTRIES.map((entry) => [entry.name, scriptSchema.optional()])) as Record<
      string,
      z.ZodOptional<typeof scriptSchema>
    >
  )
  .strict()
  .describe("Scripts run at moments in a workspace's life, keyed by entry name.");

/** Automation names become log directories and tracking keys, so they stay plain. */
const AUTOMATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const automationsSchema = z
  .record(
    z.string().regex(AUTOMATION_NAME, {
      error: "automation names use letters, digits, - and _ (and start with a letter or digit)",
    }),
    scriptSchema.describe(
      "Run every poll cycle. Prints a JSON array of items, each naming its action " +
        "(`ch plugin schema --items`)."
    )
  )
  .describe("Scripts run every poll cycle, whose printed items each run an action.");

const platformListSchema = z.union([
  z.enum(PLUGIN_PLATFORMS),
  z.array(z.enum(PLUGIN_PLATFORMS)).min(1),
]);

/** One document of a manifest. */
export const manifestDocumentSchema = z
  .object({
    description: z.string().optional().describe("What this plugin (or this part of it) does."),
    shell: z
      .enum(SHELL_NAMES)
      .optional()
      .describe("The shell every script in this document is written for (default: bash)."),
    platform: platformListSchema
      .optional()
      .describe("The platforms this document applies on (default: all)."),
    hooks: hooksSchema.optional(),
    automations: automationsSchema.optional(),
  })
  .strict();

// =============================================================================
// Parsed form
// =============================================================================

export type HookEntryName = (typeof ALL_ENTRIES)[number]["name"];

export interface AutomationSpec {
  readonly name: string;
  readonly script: string;
}

export interface PluginDocument {
  /** 1-based position in the stream, for messages. */
  readonly index: number;
  readonly description?: string;
  readonly shell: ShellName;
  readonly platforms: readonly PluginPlatform[];
  readonly hooks: Readonly<Partial<Record<string, string>>>;
  readonly automations: readonly AutomationSpec[];
}

/** A manifest that could not be read, with the first thing wrong in it. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * Parse a manifest. Throws `ManifestError` naming the document and the first
 * problem — a plugin with any invalid document is skipped whole, so a broken
 * edit never half-runs.
 */
export function parseManifest(text: string): PluginDocument[] {
  const documents: PluginDocument[] = [];
  let index = 0;
  for (const doc of parseAllDocuments(text)) {
    index++;
    if (doc.errors.length > 0) {
      throw new ManifestError(`document ${index}: ${doc.errors[0]!.message}`);
    }
    const raw = doc.toJS() as unknown;
    if (raw === null || raw === undefined) continue; // an empty document (a trailing `---`)

    const parsed = manifestDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ManifestError(
        `document ${index}: ${describeIssue(
          parsed.error.issues[0]!,
          "key",
          "a typo, or a section a newer CodeHydra adds"
        )}`
      );
    }
    const value = parsed.data;
    const platforms =
      value.platform === undefined
        ? [...PLUGIN_PLATFORMS]
        : Array.isArray(value.platform)
          ? [...new Set(value.platform)]
          : [value.platform];

    documents.push({
      index,
      ...(value.description !== undefined && { description: value.description }),
      shell: value.shell ?? "bash",
      platforms,
      hooks: Object.fromEntries(
        Object.entries(value.hooks ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      ),
      automations: Object.entries(value.automations ?? {}).map(([name, script]) => ({
        name,
        script,
      })),
    });
  }
  return documents;
}

/** The documents that apply on a platform, in file order. */
export function documentsFor(
  documents: readonly PluginDocument[],
  platform: NodeJS.Platform
): PluginDocument[] {
  const own = pluginPlatformOf(platform);
  return own === undefined ? [] : documents.filter((doc) => doc.platforms.includes(own));
}

/** The manifest schema as JSON Schema, for editors and `ch plugin schema`. */
export function manifestJsonSchema(): Record<string, unknown> {
  return {
    title: "CodeHydra plugin manifest (one YAML document)",
    ...z.toJSONSchema(manifestDocumentSchema, { unrepresentable: "any", io: "input" }),
  };
}
