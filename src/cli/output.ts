/**
 * Rendering results, and the exit codes that carry the outcome.
 *
 * Output is TTY-aware: a person at a terminal gets something readable, and a
 * script or an agent's Bash call — never a TTY — gets JSON with no flag to
 * remember. `--json` / `--no-json` force either way, which is what keeps the
 * context-sensitivity from being a trap.
 */

/**
 * Exit codes.
 *
 * Distinguishing "CodeHydra is not running" from "the operation failed" is the
 * point: a script that cannot tell those apart cannot retry sensibly, and an
 * agent cannot tell a broken environment from a refused request.
 */
export const EXIT = {
  OK: 0,
  /** The operation ran and did not succeed. */
  FAILED: 1,
  /** The command was malformed: unknown subcommand, bad arguments. */
  USAGE: 2,
  /** CodeHydra could not be reached. */
  UNREACHABLE: 3,
  /** The operation needs a workspace and none was found. */
  NO_WORKSPACE: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Whether to emit JSON, given an explicit choice and whether stdout is a TTY. */
export function useJson(forced: boolean | undefined, isTty: boolean): boolean {
  return forced ?? !isTty;
}

/**
 * Render a successful result for a person.
 *
 * Deliberately modest: a scalar prints bare so it composes with shell pipelines,
 * a list of records prints as a table, and anything else falls back to indented
 * JSON rather than inventing a layout that would hide structure.
 */
export function renderHuman(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return value.every(isRecord) ? renderTable(value) : value.map(renderScalarish).join("\n");
  }

  return renderPairs(value as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderScalarish(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/** `key  value` pairs, aligned. Nested structures fall back to compact JSON. */
function renderPairs(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  const width = Math.max(...keys.map((key) => key.length));
  return keys.map((key) => `${key.padEnd(width)}  ${renderScalarish(record[key])}`).join("\n");
}

/**
 * A column per key seen across the rows.
 *
 * Columns come from the union of keys rather than the first row's, so a record
 * missing an optional field does not silently shift everything after it.
 */
function renderTable(rows: readonly Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cells = rows.map((row) =>
    columns.map((column) => (column in row ? renderScalarish(row[column]) : ""))
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index]!.length))
  );

  const line = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();

  return [line(columns), ...cells.map(line)].join("\n");
}

/** Render a result in whichever form was chosen. Empty output prints nothing. */
export function render(value: unknown, json: boolean): string {
  return json ? JSON.stringify(value ?? null) : renderHuman(value);
}

/** Render a failure. JSON mode emits an object so callers need not parse prose. */
export function renderError(message: string, code: ExitCode, json: boolean): string {
  return json ? JSON.stringify({ error: message, exitCode: code }) : message;
}
