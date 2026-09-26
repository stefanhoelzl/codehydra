/**
 * Reading what a hook printed.
 *
 * stdout is the result channel: nothing, or exactly the JSON shape the entry
 * declares (hook-map.ts). stderr is never parsed — it is human output, shown in
 * the workspace and kept in the run log.
 */

import type { z } from "zod/v4";

/**
 * A hook could not be run, or ran and failed.
 *
 * Distinct from a hook that *returned* a refusal: for a gate, this is the
 * "could not tell" half of the contract, and the caller fails it closed.
 */
export class HookFailedError extends Error {
  constructor(
    readonly entry: string,
    message: string
  ) {
    super(message);
    this.name = "HookFailedError";
  }
}

/**
 * Parse a hook's stdout.
 *
 * Nothing printed is the ordinary case — a setup script that only copies files
 * has nothing to say — and means an empty result. Anything else must be exactly
 * the declared shape: the schemas are strict, so a misspelled key is an error
 * rather than a value that silently never arrived. Throws a plain Error whose
 * message says what was wrong; the caller names the plugin and entry.
 */
export function parseHookOutput<S extends z.ZodType>(stdout: string, output: S): z.infer<S> {
  const text = stdout.trim();
  if (text === "") {
    return output.parse({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "printed something that is not JSON. stdout is the result channel — " +
        "write human output to stderr instead."
    );
  }

  const validated = output.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `printed JSON that does not match its contract: ${describeIssues(validated.error)}`
    );
  }
  return validated.data;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      // A rejected record key (a tag name) says only "Invalid key in record";
      // the reason is on the key's own issues.
      const message =
        issue.code === "invalid_key"
          ? issue.issues.map((keyIssue) => keyIssue.message).join("; ")
          : issue.message;
      return `${at}${message}`;
    })
    .join("; ");
}
