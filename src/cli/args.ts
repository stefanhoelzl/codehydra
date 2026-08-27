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

// =============================================================================
// Types
// =============================================================================

/** Flags that apply to every command rather than to one operation. */
export interface GlobalArgs {
  /** Explicit workspace target, overriding the one derived from cwd. */
  readonly workspace?: string;
  /** Explicit data directory, selecting which CodeHydra instance to talk to. */
  readonly dataDir?: string;
  /** Forced output mode; undefined means "decide from whether stdout is a TTY". */
  readonly json?: boolean;
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

const GLOBAL_VALUE_FLAGS = new Set(["workspace", "data-dir", "input"]);

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

/**
 * Parse the arguments that follow a resolved subcommand path.
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
  let input: Record<string, unknown> = {};
  const flags: Record<string, unknown> = {};
  const free: string[] = [];
  const global: { workspace?: string; dataDir?: string; json?: boolean; help: boolean } = {
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    // Everything after `--` is positional, so a value that looks like a flag
    // (a filename beginning with a dash, say) can still be passed.
    if (token === "--") {
      free.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("--")) {
      free.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (name === "help" || name === "h") {
      global.help = true;
      continue;
    }
    // Consumed by the entry point before run() is called; recognized here so it
    // is not mistaken for an operation field.
    if (name === "progress" || name === "no-progress") {
      continue;
    }
    if (name === "json") {
      global.json = true;
      continue;
    }
    if (name === "no-json") {
      global.json = false;
      continue;
    }

    // A value-taking flag reads the next token when no `=value` was given.
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`--${name} expects a value`);
      return next;
    };

    if (GLOBAL_VALUE_FLAGS.has(name)) {
      const value = readValue();
      if (name === "workspace") global.workspace = value;
      else if (name === "data-dir") global.dataDir = value;
      else input = { ...input, ...parseInputFlag(value) };
      continue;
    }

    // `--no-thing` clears a boolean field, mirroring `--thing` setting it.
    if (name.startsWith("no-") && typeOf(schema, toCamelCase(name.slice(3))) === "boolean") {
      flags[toCamelCase(name.slice(3))] = false;
      continue;
    }

    const field = toCamelCase(name);
    const type = typeOf(schema, field);

    if (type === "boolean" && inlineValue === undefined) {
      flags[field] = true;
      continue;
    }

    const raw = readValue();

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
