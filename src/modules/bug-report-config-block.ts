/**
 * Build the prefilled content for the bug-report description textarea.
 *
 * Layout:
 *
 *   # describe your issue
 *   <cursor lands here — empty line for the user to start typing>
 *
 *   ----------- config -----------------
 *   { ...non-default values, with sensitive keys redacted as "<redacted>" }
 *   ------------------------------------
 *
 * When no non-default values exist, the JSON is replaced with:
 *
 *   # default configuration
 *
 * Returns { value, cursorOffset } so the renderer can place the cursor
 * on the empty line after the hint.
 */

import type { ConfigKeyDefinition } from "../boundaries/platform/config-definition";

const REDACTED = "<redacted>";
const HEADER = "# describe your issue";
const OPEN = "----------- config -----------------";
const CLOSE = "------------------------------------";

interface BuildDeps {
  getDefinitions(): ReadonlyMap<string, ConfigKeyDefinition<unknown>>;
  getEffective(): Readonly<Record<string, unknown>>;
  getDefaults(): Readonly<Record<string, unknown>>;
}

export interface ConfigBlock {
  readonly value: string;
  readonly cursorOffset: number;
}

export function buildConfigBlock(config: BuildDeps): ConfigBlock {
  const definitions = config.getDefinitions();
  const effective = config.getEffective();
  const defaults = config.getDefaults();

  const overrides: Record<string, unknown> = {};
  for (const [key, def] of definitions) {
    if (equals(effective[key], defaults[key])) continue;
    overrides[key] = def.sensitive === true ? REDACTED : effective[key];
  }

  const body =
    Object.keys(overrides).length === 0
      ? "# default configuration"
      : JSON.stringify(overrides, null, 2);

  // Cursor sits on the empty line right after the header.
  const prefix = `${HEADER}\n`;
  const value = [prefix, "", OPEN, body, CLOSE, ""].join("\n");

  return { value, cursorOffset: prefix.length };
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
