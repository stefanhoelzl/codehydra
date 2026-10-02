/**
 * Liquid templates for `ch plugin render`: an opt-in filter for automation
 * scripts that would rather describe their items as a template than build them
 * in jq, and the bridge the migrated `auto-workspace.sources` run through.
 *
 * A template is a YAML mapping; every string leaf is a Liquid template rendered
 * against one input item, and every other value — a number, a boolean, a list —
 * is passed through as written, so `stealFocus: true` stays a boolean while
 * `"pr-{{ number }}"` becomes a string. A field whose string renders empty is
 * left out — `prompt: "{{ body }}"` for an item with no body means no prompt,
 * not an empty one the action would refuse.
 */

import { parse } from "yaml";
import { isValidLiquidTemplate, renderTemplate } from "../../utils/liquid/liquid-renderer";
import { isPlainObject } from "./util";

export type TemplateScalar = string | number | boolean | null;
export type TemplateValue = TemplateScalar | TemplateValue[] | TemplateObject;
export interface TemplateObject {
  readonly [key: string]: TemplateValue;
}

function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (isPlainObject(value)) for (const item of Object.values(value)) stringLeaves(item, out);
}

/** Parse a template file's text. Throws a message saying what is wrong with it. */
export function parseTemplate(text: string): TemplateObject {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`the template is not valid YAML: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) throw new Error("the template must be a YAML mapping");
  const leaves: string[] = [];
  stringLeaves(parsed, leaves);
  const invalid = leaves.find((leaf) => !isValidLiquidTemplate(leaf));
  if (invalid !== undefined) throw new Error(`invalid Liquid in the template: ${invalid}`);
  // A YAML mapping holds only what YAML can write: template values.
  return parsed as TemplateObject;
}

/** Render a template for one item: string leaves through Liquid, the rest as written. */
export function renderInput(template: TemplateObject, data: unknown): Record<string, unknown> {
  const ctx = (data ?? {}) as Record<string, unknown>;
  const render = (value: TemplateValue): unknown => {
    if (typeof value === "string") return renderTemplate(value, ctx);
    if (Array.isArray(value)) return value.map(render);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, item]) => [key, render(item)] as const)
          .filter(([, rendered]) => rendered !== "")
      );
    }
    return value;
  };
  return render(template) as Record<string, unknown>;
}
