/**
 * Which operations a plugin's automation may run.
 *
 * An automation's script prints a JSON array of items, each naming its
 * `action` — an operation from the registry, the same vocabulary `ch` and MCP
 * speak — and carrying that operation's input. This map says which ones.
 *
 * Exhaustive: a new operation fails to compile until this file says whether an
 * automation may run it, so the set can only grow by decision. `null` = not an
 * action: queries (nothing reads an automation's results), plumbing and events
 * (only a witness may send one), and anything an unattended timer should not be
 * able to do behind the user's back (config, locks, bug reports).
 */

import type { OperationName } from "../names";
import type { InputShaping } from "../registry";

export type PluginActionMapping =
  /**
   * The auto-workspace behavior: the item is `workspace.create`'s input plus
   * `event`, `key` and `metadata` (plugin-module/items.ts), and `event`
   * decides between reconciling a list of workspaces and firing events that
   * create or refresh one.
   */
  | { readonly kind: "create-workspace" }
  /** Invoke the operation with the item as its input. */
  | ({ readonly kind: "invoke" } & InputShaping);

const INVOKE = { kind: "invoke" } as const;

export const PLUGIN_ACTIONS_MAP: Readonly<Record<OperationName, PluginActionMapping | null>> = {
  "workspace.status": null,
  "workspace.hibernate": INVOKE,
  "workspace.wake": INVOKE,
  "workspace.wakeup.set": INVOKE,
  "workspace.wakeup.clear": INVOKE,
  "workspace.wakeup.show": null,
  "workspace.create": { kind: "create-workspace" },
  "workspace.delete": INVOKE,
  "workspace.switch": INVOKE,
  "workspace.title": INVOKE,
  "workspace.tag.list": null,
  "workspace.tag.set": INVOKE,
  "workspace.tag.remove": INVOKE,

  "metadata.get": null,
  "metadata.set": INVOKE,

  "agent.session": null,
  "agent.restart": INVOKE,
  "agent.open": INVOKE,
  "agent.close": INVOKE,
  "agent.message": INVOKE,
  // The agent reports its own status; a timer claiming it would be a lie.
  "agent.status.set": null,
  "agent.lifecycle": null,

  // Editor commands act in the IDE the user is looking at, not something an
  // unattended timer should drive.
  "vscode.command": null,
  "vscode.message": null,
  "vscode.notify": INVOKE,
  "vscode.status-bar": INVOKE,
  "vscode.ask": null,
  "vscode.browser": null,
  "vscode.diff": null,
  "vscode.goto": null,
  "vscode.preview": null,
  "system.open": null,
  "notification.show": INVOKE,
  "notification.close": INVOKE,

  "project.list": null,
  "project.open": INVOKE,
  "project.close": INVOKE,

  "lock.take": null,
  "lock.release": null,
  "lock.list": null,
  "lock.hold": null,
  // A plugin enabling or disabling plugins is a trust decision it may not make.
  "plugin.list": null,
  "plugin.enable": null,
  "plugin.disable": null,
  "plugin.add": null,
  "plugin.remove": null,
  "plugin.update": null,
  "plugin.errors": null,
  "plugin.schema": null,
  "plugin.render": null,
  "config.get": null,
  "config.list": null,
  "config.set": null,
  "config.reset": null,
  log: INVOKE,
  "report.issue": null,
  guide: null,
};

/** The operation names an automation's `action` may name, in vocabulary order. */
export const PLUGIN_ACTION_NAMES: readonly OperationName[] = (
  Object.keys(PLUGIN_ACTIONS_MAP) as OperationName[]
).filter((name) => PLUGIN_ACTIONS_MAP[name] !== null);
