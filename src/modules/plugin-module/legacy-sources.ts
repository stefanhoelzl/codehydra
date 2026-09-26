/**
 * The `auto-workspace.sources` setting from before plugins, read once to move
 * it into a plugin (see {@link convertLegacySources}).
 *
 * The value is a multi-document YAML stream — one document per source, separated
 * by `---`. Each document is a mapping:
 *
 *   name: github
 *   type: cron          # optional, defaults to "cron"; only "cron" is supported
 *   mode: workspaces    # optional, defaults to "workspaces"; or "events"
 *   cmd: |              # shell command line, run via `sh -c` / `cmd /c`
 *     gh api graphql ... --jq '...'
 *   template:           # nested mapping; every string leaf is a Liquid template
 *     name: "{{ title }}"
 *     key: "{{ html_url }}"
 *     prompt: |
 *       Review #{{ number }}
 *
 * The cmd emits a JSON array of raw domain objects; `template` renders one
 * workspace definition per object (see template-render.ts).
 *
 * `type` and `mode` are separate axes on purpose. `type` is the *trigger* —
 * cron, i.e. the poll timer, and still the only one. `mode` is what the cmd's
 * objects *mean*, which is what actually changes the module's behavior.
 */

import { parseAllDocuments, stringify } from "yaml";
import { isValidLiquidTemplate } from "../../utils/liquid/liquid-renderer";
import type { TemplateObject, TemplateValue } from "./manifest";

/**
 * What a source's cmd emits, which decides how the module treats each object.
 *
 * - "workspaces": the desired workspace list. Unseen keys create, tracked keys
 *   absent from a poll are forgotten — the reconcile loop, with state.
 * - "events": things that happened. Each object fires once and nothing is
 *   tracked; the cmd owns dedup (it acks, pops, or keeps its own cursor).
 */
export type SourceMode = "workspaces" | "events";

export const SOURCE_MODES: readonly SourceMode[] = ["workspaces", "events"];

export interface ParsedSource {
  readonly name: string;
  /** The trigger. Only "cron" (the poll timer) is supported today. */
  readonly type: "cron";
  /** What the cmd's objects mean. Defaults to "workspaces". */
  readonly mode: SourceMode;
  readonly cmd: string;
  readonly template: TemplateObject;
}

export interface SourceParseError {
  /** 1-based document index within the stream (for errors that lack a name). */
  readonly index: number;
  readonly name?: string;
  readonly message: string;
}

export interface ParseSourcesResult {
  readonly sources: readonly ParsedSource[];
  readonly errors: readonly SourceParseError[];
}

function collectStringLeaves(value: TemplateValue, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStringLeaves(item, out);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the multi-document sources stream. Malformed documents are collected as
 * errors (with the offending source name or its 1-based index) and skipped;
 * valid documents still parse. Empty documents (a trailing `---`) are ignored.
 */
export function parseSources(raw: string | null): ParseSourcesResult {
  const sources: ParsedSource[] = [];
  const errors: SourceParseError[] = [];
  if (raw === null || raw.trim() === "") return { sources, errors };

  const docs = parseAllDocuments(raw);
  const seen = new Set<string>();
  let index = 0;
  for (const doc of docs) {
    index++;
    if (doc.errors.length > 0) {
      errors.push({ index, message: doc.errors[0]!.message });
      continue;
    }
    const js = doc.toJS() as unknown;
    if (js === null || js === undefined) continue; // empty section

    if (!isPlainObject(js)) {
      errors.push({ index, message: "Source must be a YAML mapping" });
      continue;
    }

    const name = js.name;
    if (typeof name !== "string" || name.trim() === "") {
      errors.push({ index, message: "Missing or invalid 'name'" });
      continue;
    }
    if (seen.has(name)) {
      errors.push({ index, name, message: `Duplicate source name '${name}'` });
      continue;
    }

    const type = js.type ?? "cron";
    if (type !== "cron") {
      errors.push({
        index,
        name,
        message: `Unsupported type '${String(type)}' (only 'cron' is supported)`,
      });
      continue;
    }

    const mode = js.mode ?? "workspaces";
    if (mode !== "workspaces" && mode !== "events") {
      errors.push({
        index,
        name,
        message: `Unsupported mode '${String(mode)}' (expected 'workspaces' or 'events')`,
      });
      continue;
    }

    const cmd = js.cmd;
    if (typeof cmd !== "string" || cmd.trim() === "") {
      errors.push({ index, name, message: "Missing or invalid 'cmd'" });
      continue;
    }

    const template = js.template;
    if (!isPlainObject(template)) {
      errors.push({ index, name, message: "Missing or invalid 'template' (must be a mapping)" });
      continue;
    }
    if (typeof template.name !== "string" || template.name.trim() === "") {
      errors.push({ index, name, message: "template.name is required" });
      continue;
    }

    const leaves: string[] = [];
    collectStringLeaves(template as TemplateObject, leaves);
    const invalid = leaves.find((s) => !isValidLiquidTemplate(s));
    if (invalid !== undefined) {
      errors.push({ index, name, message: `Invalid Liquid in template: ${invalid}` });
      continue;
    }

    seen.add(name);
    sources.push({ name, type: "cron", mode, cmd, template: template as TemplateObject });
  }

  return { sources, errors };
}

/** The plugin the old setting becomes, in `~/.codehydra/plugins`. */
export const LEGACY_SOURCES_PLUGIN = "auto-workspaces";

export interface ConvertedSources {
  /** The plugin's manifest text. */
  readonly manifest: string;
  /** Old source name → automation name, for moving tracking state along. */
  readonly renames: ReadonlyMap<string, string>;
  /** Sources that could not be read and were left out. */
  readonly errors: readonly SourceParseError[];
}

/** An automation name for an old source name: letters, digits, `-` and `_`. */
function automationName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/-+$/, "") || "source";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * Turn the old setting into a plugin manifest, one automation per source.
 *
 * A source's `cmd` ran through the platform shell — `sh` on Linux and macOS,
 * `cmd.exe` on Windows — so the automation keeps that: `bash` for a POSIX
 * line (which also runs on Windows, through Git Bash), `cmd` pinned to Windows
 * for a Windows one.
 */
export function convertLegacySources(raw: string, platform: NodeJS.Platform): ConvertedSources {
  const { sources, errors } = parseSources(raw);
  const renames = new Map<string, string>();
  const automations: Record<string, unknown> = {};
  for (const source of sources) {
    const name = automationName(source.name, new Set(renames.values()));
    renames.set(source.name, name);
    automations[name] = {
      mode: source.mode,
      script: source.cmd,
      template: source.template,
    };
  }

  const document = {
    description: "Moved from the auto-workspace.sources setting",
    ...(platform === "win32" ? { shell: "cmd", platform: "windows" } : { shell: "bash" }),
    automations,
  };
  return { manifest: stringify(document, { lineWidth: 0 }), renames, errors };
}
