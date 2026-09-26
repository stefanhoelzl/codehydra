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
 *     prs:
 *       action: workspace.create                   # default
 *       mode: workspaces                           # default for workspace.create
 *       script: gh api …
 *       template: { name: "{{ title }}", … }
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
import { isValidLiquidTemplate } from "../../utils/liquid/liquid-renderer";
import { PLUGIN_ACTION_NAMES } from "../../api/adapters/plugin-actions-map";
import type { OperationName } from "../../api/names";
import { ALL_ENTRIES } from "./hook-map";
import { SHELL_NAMES, type ShellName } from "./shells";

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
// Templates
// =============================================================================

export type TemplateScalar = string | number | boolean | null;
export type TemplateValue = TemplateScalar | TemplateValue[] | TemplateObject;
export interface TemplateObject {
  readonly [key: string]: TemplateValue;
}

function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStringLeaves(item, out);
  }
}

const templateSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Rendered once per item the script prints: every string value is a Liquid template " +
      "evaluated against that item."
  )
  .superRefine((template, ctx) => {
    const leaves: string[] = [];
    collectStringLeaves(template, leaves);
    const invalid = leaves.find((leaf) => !isValidLiquidTemplate(leaf));
    if (invalid !== undefined) {
      ctx.addIssue({ code: "custom", message: `invalid Liquid: ${invalid}` });
    }
  });

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

/** What an automation's items mean. */
export const AUTOMATION_MODES = ["workspaces", "events"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** Automation names become log directories and state keys, so they stay plain. */
const AUTOMATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const automationSchema = z
  .object({
    action: z
      .enum(PLUGIN_ACTION_NAMES as [OperationName, ...OperationName[]])
      .optional()
      .describe("The operation each item runs (default: workspace.create)."),
    mode: z
      .enum(AUTOMATION_MODES)
      .optional()
      .describe(
        "workspaces: the items are the workspaces that should exist (workspace.create only; " +
          "the default for it). events: each item fires once."
      ),
    script: scriptSchema.describe("Prints a JSON array of items on stdout, once per poll."),
    template: templateSchema,
  })
  .strict()
  .superRefine((automation, ctx) => {
    const action = automation.action ?? "workspace.create";
    if (automation.mode === "workspaces" && action !== "workspace.create") {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: `mode: workspaces only applies to workspace.create (${action} runs as events)`,
      });
    }
    if (action === "workspace.create") {
      const name = automation.template["name"];
      if (typeof name !== "string" || name.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["template", "name"],
          message: "workspace.create needs template.name",
        });
      }
    }
  });

const automationsSchema = z
  .record(
    z.string().regex(AUTOMATION_NAME, {
      error: "automation names use letters, digits, - and _ (and start with a letter or digit)",
    }),
    automationSchema
  )
  .describe("Scripts run every poll cycle, whose items each run an action.");

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
  readonly action: OperationName;
  readonly mode: AutomationMode;
  readonly script: string;
  readonly template: TemplateObject;
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

function describeIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  if (issue.code === "invalid_key") {
    // A rejected record key (an automation name) says only "Invalid key in
    // record"; the reason is on the key's own issues.
    return `${at}${issue.issues.map((keyIssue) => keyIssue.message).join("; ")}`;
  }
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.join(", ");
    return `${at}unknown ${issue.keys.length === 1 ? "key" : "keys"} ${keys} (a typo, or a section a newer CodeHydra adds)`;
  }
  return `${at}${issue.message}`;
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
      throw new ManifestError(`document ${index}: ${describeIssue(parsed.error.issues[0]!)}`);
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
      automations: Object.entries(value.automations ?? {}).map(([name, automation]) => {
        const action = automation.action ?? "workspace.create";
        return {
          name,
          action,
          mode: automation.mode ?? (action === "workspace.create" ? "workspaces" : "events"),
          script: automation.script,
          template: automation.template as TemplateObject,
        };
      }),
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
