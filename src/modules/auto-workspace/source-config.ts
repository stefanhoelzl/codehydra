/**
 * Parsing + validation for the `auto-workspace.sources` config value.
 *
 * The value is a multi-document YAML stream — one document per source, separated
 * by `---`. Each document is a mapping:
 *
 *   name: github
 *   type: cron          # optional, defaults to "cron"; only "cron" is supported
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
 */

import { parseAllDocuments } from "yaml";
import { isValidLiquidTemplate } from "../../utils/liquid/liquid-renderer";

export type TemplateScalar = string | number | boolean | null;
export type TemplateValue = TemplateScalar | TemplateValue[] | TemplateObject;
export interface TemplateObject {
  readonly [key: string]: TemplateValue;
}

export interface ParsedSource {
  readonly name: string;
  /** Only "cron" is supported today; the field exists for a future "event" arm. */
  readonly type: "cron";
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
    sources.push({ name, type: "cron", cmd, template: template as TemplateObject });
  }

  return { sources, errors };
}

/**
 * Config `validate` for the `auto-workspace.sources` key. Returns the raw string
 * unchanged when it parses with zero errors, `null` for a null value, or
 * `undefined` (rejected) when any document is malformed — so a bad edit is
 * caught in the settings dialog and on set().
 */
export function validateSourcesConfig(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  if (raw.trim() === "") return raw;
  return parseSources(raw).errors.length === 0 ? raw : undefined;
}
