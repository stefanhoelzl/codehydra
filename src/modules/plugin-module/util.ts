/**
 * Small helpers the plugin module's files share.
 */

import type { z } from "zod/v4";

/** `JSON.parse`, with text that is not JSON read as `undefined`. */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A JSON/YAML mapping: an object that is neither null nor an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One schema issue in the words a plugin author reads, prefixed with where it is.
 *
 * `noun` names what an unknown key is to its reader — a manifest's "key", an
 * item's "field" — and `hint`, when given, follows the unknown ones in
 * parentheses.
 */
export function describeIssue(issue: z.core.$ZodIssue, noun: string, hint?: string): string {
  const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  if (issue.code === "invalid_key") {
    // A rejected record key (an automation name, a tag name) says only "Invalid
    // key in record"; the reason is on the key's own issues.
    return `${at}${issue.issues.map((keyIssue) => keyIssue.message).join("; ")}`;
  }
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.join(", ");
    const suffix = hint === undefined ? "" : ` (${hint})`;
    return `${at}unknown ${noun}${issue.keys.length === 1 ? "" : "s"} ${keys}${suffix}`;
  }
  return `${at}${issue.message}`;
}
