/**
 * The manifest files `ch automation add|remove` manage: a `<name>.yaml` holding
 * one automation and nothing else.
 *
 * `remove` deletes a whole file, so it first checks the file is one of these. A
 * file that says anything more was written by hand and is the author's to edit.
 */

import { stringify } from "yaml";
import { PLUGIN_PLATFORMS, parseManifest } from "./manifest";
import type { ShellName } from "../scripts/shells";

export interface NewAutomation {
  readonly name: string;
  readonly script: string;
  readonly schedule?: string;
  readonly shell?: ShellName;
}

/** The manifest of a new automation. Throws `ManifestError` if it would not be a valid one. */
export function automationManifest(automation: NewAutomation): string {
  const { name, script, schedule, shell } = automation;
  const text = stringify({
    ...(shell !== undefined && { shell }),
    automations: { [name]: schedule === undefined ? script : { schedule, script } },
  });
  parseManifest(text);
  return text;
}

/** Whether a manifest holds exactly the one automation `name` and nothing else. */
export function holdsOnlyAutomation(text: string, name: string): boolean {
  let documents;
  try {
    documents = parseManifest(text);
  } catch {
    return false;
  }
  const doc = documents[0];
  return (
    documents.length === 1 &&
    doc !== undefined &&
    doc.automations.length === 1 &&
    doc.automations[0]?.name === name &&
    doc.description === undefined &&
    doc.platforms.length === PLUGIN_PLATFORMS.length &&
    Object.keys(doc.hooks).length === 0 &&
    Object.keys(doc.settings).length === 0
  );
}
