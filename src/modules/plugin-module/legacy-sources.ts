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
import type { TemplateObject, TemplateValue } from "./template-render";

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
  /** Template files the manifest's scripts render through: file name → text. */
  readonly templates: Readonly<Record<string, string>>;
  /** Old source name → automation name, for moving tracking state along. */
  readonly renames: ReadonlyMap<string, string>;
  /** Sources that could not be read and were left out. */
  readonly errors: readonly SourceParseError[];
  /** Template fields that could not be carried over, by source. */
  readonly dropped: readonly { readonly source: string; readonly field: string }[];
}

/** Where a migrated source's template is written, inside the plugin's folder. */
export const LEGACY_TEMPLATES_DIR = "templates";

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
 * An old workspace template, in the shape of a `workspace.create` item.
 *
 * The field names are `ch ws create`'s now: `git` and `project` become
 * `project`, `focus` becomes `stealFocus`, the nested `agent` becomes flat
 * fields (a `model: { provider, id }` becomes `"<provider>/<id>"`), and a
 * nested metadata namespace becomes dotted keys, as the old renderer
 * flattened it. The old `mode` becomes `event`. A field with no counterpart —
 * or a Liquid `focus`, which renders to a string where a boolean is needed —
 * is reported rather than carried over.
 */
export function convertLegacyTemplate(
  template: TemplateObject,
  mode: SourceMode,
  drop: (field: string) => void
): Record<string, TemplateValue> {
  const item: Record<string, TemplateValue> = {
    action: "workspace.create",
    event: mode === "events",
  };
  for (const [key, value] of Object.entries(template)) {
    switch (key) {
      case "name":
      case "key":
      case "base":
      case "tracking":
      case "prompt":
        item[key] = value;
        break;
      case "project":
        item["project"] = value;
        break;
      case "git":
        if (template["project"] === undefined) item["project"] = value;
        break;
      case "focus":
        if (typeof value === "boolean") item["stealFocus"] = value;
        else if (value === "true" || value === "false") item["stealFocus"] = value === "true";
        else drop("focus");
        break;
      case "agent":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const agent = value as TemplateObject;
          if (agent["type"] !== undefined) item["agent"] = agent["type"];
          if (agent["name"] !== undefined) item["agentName"] = agent["name"];
          if (agent["permission-mode"] !== undefined) {
            item["permissionMode"] = agent["permission-mode"];
          }
          const model = agent["model"];
          if (model !== null && typeof model === "object" && !Array.isArray(model)) {
            const { provider, id } = model as TemplateObject;
            if (typeof provider === "string" && typeof id === "string") {
              item["model"] = `${provider}/${id}`;
            }
          }
        } else {
          drop("agent");
        }
        break;
      case "metadata":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          item["metadata"] = flattenLegacyMetadata(value as TemplateObject);
        } else {
          drop("metadata");
        }
        break;
      default:
        drop(key);
    }
  }
  return item;
}

/** Keep `title` and `tags` as they are; turn any other nested namespace into dotted keys. */
function flattenLegacyMetadata(metadata: TemplateObject): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = {};
  const walk = (prefix: string, value: TemplateValue): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(`${prefix}.${key}`, child);
    } else {
      out[prefix] = typeof value === "string" ? value : String(value);
    }
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "title" || key === "tags") out[key] = value;
    else walk(key, value);
  }
  return out;
}

/**
 * Turn the old setting into a plugin: one automation per source, each running
 * the source's `cmd` piped through `ch plugin render` and the source's
 * template, rewritten to the create-item shape.
 *
 * A source's `cmd` ran through the platform shell — `sh` on Linux and macOS,
 * `cmd.exe` on Windows — so the automation keeps that: `bash` for a POSIX
 * line (which also runs on Windows, through Git Bash), `cmd` pinned to Windows
 * for a Windows one. The cmd is grouped, so one with several lines or its own
 * pipes reaches the render as a whole.
 */
export function convertLegacySources(raw: string, platform: NodeJS.Platform): ConvertedSources {
  const { sources, errors } = parseSources(raw);
  const windows = platform === "win32";
  const renames = new Map<string, string>();
  const automations: Record<string, string> = {};
  const templates: Record<string, string> = {};
  const dropped: { source: string; field: string }[] = [];
  for (const source of sources) {
    const name = automationName(source.name, new Set(renames.values()));
    renames.set(source.name, name);
    const file = `${name}.yaml`;
    templates[file] = stringify(
      convertLegacyTemplate(source.template, source.mode, (field) =>
        dropped.push({ source: source.name, field })
      ),
      { lineWidth: 0 }
    );
    const cmd = source.cmd.replace(/\s+$/, "");
    automations[name] = windows
      ? `(\r\n${cmd}\r\n) | ch plugin render "%CH_PLUGIN_DIR%\\${LEGACY_TEMPLATES_DIR}\\${file}"`
      : `{\n${cmd}\n} | ch plugin render "$CH_PLUGIN_DIR/${LEGACY_TEMPLATES_DIR}/${file}"`;
  }

  const document = {
    description: "Moved from the auto-workspace.sources setting",
    ...(windows ? { shell: "cmd", platform: "windows" } : { shell: "bash" }),
    automations,
  };
  return {
    manifest: stringify(document, { lineWidth: 0 }),
    templates,
    renames,
    errors,
    dropped,
  };
}
