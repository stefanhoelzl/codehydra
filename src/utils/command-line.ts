/**
 * A user-written command line, turned into an executable and its arguments
 * the same way on every OS — no shell is involved, so neither its quoting nor
 * its variable syntax applies.
 *
 * - Arguments are separated by whitespace.
 * - `"…"` and `'…'` group text containing whitespace; the quotes are removed.
 *   Inside double quotes, `\"` is a literal quote and `\\` a literal
 *   backslash. Every other backslash is literal everywhere, so Windows paths
 *   need no escaping.
 * - `${NAME}` is replaced by the variable's value (empty when unset), before
 *   splitting is decided — a value never splits into several arguments, nor
 *   are quotes in it interpreted.
 */

/** Matches `${NAME}`: a letter or underscore, then letters, digits, underscores. */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Thrown for a command line that cannot be split (an unclosed quote). */
export class CommandLineError extends Error {
  override readonly name = "CommandLineError";
}

/**
 * Split `line` into arguments, expanding `${NAME}` from `variables` inside
 * each. Throws `CommandLineError` for an unclosed quote.
 */
export function splitCommandLine(
  line: string,
  variables: Readonly<Record<string, string | undefined>> = {}
): string[] {
  const args: string[] = [];
  let current = "";
  let inArgument = false;
  let quote: '"' | "'" | null = null;

  const expand = (text: string): string =>
    text.replace(VARIABLE, (_match, name: string) => variables[name] ?? "");

  // Expansion happens per literal chunk, so values are never re-tokenized.
  let chunk = "";
  const flushChunk = (): void => {
    current += expand(chunk);
    chunk = "";
  };

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else chunk += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        chunk += line[i + 1];
        i++;
      } else {
        chunk += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (inArgument) {
        flushChunk();
        args.push(current);
        current = "";
        inArgument = false;
      }
      continue;
    }
    inArgument = true;
    if (char === '"' || char === "'") quote = char;
    else chunk += char;
  }

  if (quote !== null) throw new CommandLineError(`unclosed ${quote} in command line`);
  if (inArgument) {
    flushChunk();
    args.push(current);
  }
  return args;
}
