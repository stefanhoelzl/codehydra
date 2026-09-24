/**
 * argv → operation input.
 *
 * Driven entirely by the JSON Schema the running app describes each operation
 * with, so the CLI has no per-command parsing code and cannot fall out of step
 * with an operation's real shape.
 *
 * Three ways to supply a field, in increasing precedence: `--input` carrying the
 * whole payload as JSON, then positionals, then flags. `--input` exists so that
 * anything expressible through MCP is expressible here too, and so an agent has
 * one calling convention it can use for every command.
 */

import { parseArgs as tokenize } from "node:util";

// =============================================================================
// Types
// =============================================================================

/** How a result is rendered; `auto` means "JSON unless stdout is a TTY". */
export type Format = "json" | "text" | "auto";

const FORMATS: readonly Format[] = ["json", "text", "auto"];

/** Flags that apply to every command rather than to one operation. */
export interface GlobalArgs {
  /** Explicit workspace target, overriding the one derived from cwd. */
  readonly workspace?: string;
  /**
   * Project to look the `--workspace` name up in. Global only for a command
   * without a `project` field of its own (`ws create` has one, and keeps it).
   */
  readonly project?: string;
  /** Output format; undefined when `--format` was not given, which means `auto`. */
  readonly format?: Format;
  readonly help: boolean;
}

export interface ParsedArgs {
  readonly input: Record<string, unknown>;
  readonly global: GlobalArgs;
}

/** The slice of a JSON Schema this parser reads. */
export interface InputSchema {
  readonly properties?: Readonly<Record<string, { readonly type?: string | readonly string[] }>>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// =============================================================================
// Parsing
// =============================================================================

type OptionSpec = { readonly type: "string" | "boolean"; readonly short?: string };

/**
 * Flags every command accepts. They win over an operation field of the same
 * name, so `--workspace` always targets a workspace.
 */
const GLOBAL_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  help: { type: "boolean", short: "h" },
  workspace: { type: "string" },
  input: { type: "string" },
  format: { type: "string" },
  // Consumed by the entry point before run() is called; declared here so they
  // are not rejected as unknown flags.
  progress: { type: "boolean" },
  "no-progress": { type: "boolean" },
};

/**
 * The global flag names. An operation field whose flag spelling is one of these
 * can never be set from the command line (the global wins), so the registry's
 * conformance test rejects such a field.
 */
export const GLOBAL_FLAG_NAMES: readonly string[] = Object.keys(GLOBAL_OPTIONS);

/**
 * Split argv into flag and positional tokens.
 *
 * Non-strict on purpose: node reports an unknown flag, a missing value or an
 * inline value on a boolean only by throwing with its own wording. Taking the
 * tokens and judging them here keeps the messages ours and lets
 * `--wait=false` keep working. Negations are declared as options of their own
 * rather than left to node's `allowNegative`, which would read a field that is
 * genuinely named `noWait` as the negation of `wait`.
 */
function tokenizeArgv(argv: readonly string[], options: Readonly<Record<string, OptionSpec>>) {
  return (
    tokenize({
      args: [...argv],
      options,
      strict: false,
      allowPositionals: true,
      tokens: true,
    }).tokens ?? []
  );
}

/** Validate a `--format` value. */
function parseFormat(raw: string | undefined): Format {
  if (raw === undefined) throw new UsageError("--format expects a value");
  const format = FORMATS.find((candidate) => candidate === raw);
  if (format === undefined) {
    throw new UsageError(`--format expects one of ${FORMATS.join(", ")}, got "${raw}"`);
  }
  return format;
}

/**
 * Read `--format` from raw argv, before the command is resolved.
 *
 * The format is needed to report a failure, and failures can happen before
 * the operation's schema is known — so this reads only `--format`, ignoring
 * every other flag. The last occurrence wins; nothing after `--` counts.
 */
export function readFormat(argv: readonly string[]): Format {
  let format: Format = "auto";
  for (const token of tokenizeArgv(argv, { format: GLOBAL_OPTIONS.format! })) {
    if (token.kind === "option" && token.name === "format") format = parseFormat(token.value);
  }
  return format;
}

/** `--keep-branch` names the `keepBranch` field. */
function toCamelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** The declared type of a field, treating a nullable union as its non-null half. */
function typeOf(schema: InputSchema, field: string): string | undefined {
  const declared = schema.properties?.[field]?.type;
  if (declared === undefined) return undefined;
  if (typeof declared === "string") return declared;
  // A nullable field is described as a union; the non-null half is its real type.
  return declared.find((candidate) => candidate !== "null");
}

/**
 * Convert a flag's string value to what the field's schema expects.
 *
 * Object and array fields take JSON, which is the escape hatch for shapes argv
 * cannot express — `--args '[{"$vscode":"Uri",…}]'` and the like.
 */
function coerce(raw: string, type: string | undefined, field: string): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new UsageError(`--${field} expects a number, got "${raw}"`);
      return value;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new UsageError(`--${field} expects true or false, got "${raw}"`);
    case "object":
    case "array":
      try {
        return JSON.parse(raw);
      } catch {
        throw new UsageError(`--${field} expects JSON, got "${raw}"`);
      }
    default:
      return raw;
  }
}

/**
 * Add one flag occurrence to an array field.
 *
 * An array can be built two ways, distinguished by how the value starts. A value
 * opening with `[` or `{` is JSON — an array replaces the whole field, anything
 * else becomes one element — which is how structured arguments like
 * `--args '[{"$vscode":"Uri",…}]'` are given. Any other value is a plain element,
 * so repeating the flag builds a list: `--options Yes --options No`.
 */
function appendToArray(existing: unknown, raw: string, field: string): unknown[] {
  const current = Array.isArray(existing) ? existing : [];
  const trimmed = raw.trimStart();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UsageError(`--${field} expects JSON, got "${raw}"`);
    }
    return Array.isArray(parsed) ? parsed : [...current, parsed];
  }

  return [...current, raw];
}

/** Parse the JSON payload of `--input`, which must be an object. */
function parseInputFlag(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--input expects a JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--input expects a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** `keepBranch` is spelled `--keep-branch` on the command line. */
export function toKebabCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Parse the arguments that follow a resolved subcommand path.
 *
 * A flag that is neither global nor a field of the operation is refused rather
 * than dropped: a typo, or a flag from an older `ch`, must not run the command
 * as if it had not been given.
 *
 * @param argv     arguments after the subcommand path
 * @param schema   the operation's input schema, as described by the app
 * @param positionals field names that may be given positionally, in order
 */
export function parseArgs(
  argv: readonly string[],
  schema: InputSchema,
  positionals: readonly string[] = []
): ParsedArgs {
  const fields = Object.keys(schema.properties ?? {});
  const options: Record<string, OptionSpec> = {};
  for (const field of fields) {
    options[toKebabCase(field)] = {
      type: typeOf(schema, field) === "boolean" ? "boolean" : "string",
    };
  }
  // `--no-thing` clears a boolean field, unless a field is literally named that.
  const negations = new Map<string, string>();
  for (const field of fields) {
    const flag = `no-${toKebabCase(field)}`;
    if (typeOf(schema, field) === "boolean" && options[flag] === undefined) {
      options[flag] = { type: "boolean" };
      negations.set(flag, field);
    }
  }
  Object.assign(options, GLOBAL_OPTIONS);
  // `--project` scopes the `--workspace` lookup — unless the command has a
  // `project` of its own, which it then simply is.
  const projectIsGlobal = !fields.includes("project");
  if (projectIsGlobal) options.project = { type: "string" };

  let input: Record<string, unknown> = {};
  const flags: Record<string, unknown> = {};
  const free: string[] = [];
  const global: { workspace?: string; project?: string; format?: Format; help: boolean } = {
    help: false,
  };

  // Everything after `--` arrives as positional tokens, so a value that looks
  // like a flag (a filename beginning with a dash, say) can still be passed.
  for (const token of tokenizeArgv(argv, options)) {
    if (token.kind === "positional") {
      free.push(token.value);
      continue;
    }
    if (token.kind !== "option") continue;

    const { name, rawName, value } = token;
    if (options[name] === undefined) {
      throw new UsageError(
        `unknown flag "${rawName}"` +
          (rawName.startsWith("--") ? "" : ` (put an argument starting with "-" after --)`)
      );
    }

    // A value-taking flag must have one — the next token, or `=value`.
    const required = (): string => {
      if (value === undefined) throw new UsageError(`--${name} expects a value`);
      return value;
    };

    if (name === "help") {
      global.help = true;
      continue;
    }
    if (name === "progress" || name === "no-progress") continue;
    if (name === "format") {
      global.format = parseFormat(value);
      continue;
    }
    if (name === "workspace") {
      global.workspace = required();
      continue;
    }
    if (name === "project" && projectIsGlobal) {
      global.project = required();
      continue;
    }
    if (name === "input") {
      input = { ...input, ...parseInputFlag(required()) };
      continue;
    }

    const negated = negations.get(name);
    if (negated !== undefined) {
      if (value !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags[negated] = false;
      continue;
    }

    const field = toCamelCase(name);
    const type = typeOf(schema, field);

    if (type === "boolean") {
      flags[field] = value === undefined ? true : coerce(value, type, name);
      continue;
    }

    const raw = required();
    if (type === "array") {
      flags[field] = appendToArray(flags[field], raw, name);
      continue;
    }
    flags[field] = coerce(raw, type, name);
  }

  // Positionals fill their declared fields in order; anything past the end is a
  // mistake worth reporting rather than silently dropping.
  if (free.length > positionals.length) {
    throw new UsageError(
      positionals.length === 0
        ? `unexpected argument "${free[0]}"`
        : `unexpected argument "${free[positionals.length]}"`
    );
  }
  const positional: Record<string, unknown> = {};
  free.forEach((value, index) => {
    const field = positionals[index]!;
    positional[field] = coerce(value, typeOf(schema, field), field);
  });

  return { input: { ...input, ...positional, ...flags }, global };
}
