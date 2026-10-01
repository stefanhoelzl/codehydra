/**
 * The plugin automations adapter: runs one action an automation's item names.
 *
 * An automation has no workspace of its own — it runs on a timer — so it calls
 * as an app-global caller would, from outside every workspace. An operation
 * that acts on one is told which through its own `workspace` (and `project`)
 * input fields, resolved by the entry exactly as for `ch` and MCP: a name is
 * looked up across the open projects, an absolute path is taken as is.
 */

import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationRegistry } from "../registry";
import type { OperationContext } from "../types";
import { PLUGIN_ACTIONS_MAP } from "./plugin-actions-map";

export interface PluginActionDeps {
  readonly registry: OperationRegistry;
}

/** A signal for a caller with no connection: it never aborts. */
const NEVER = new AbortController().signal;

/** An automation calls from nowhere: no workspace, no directory. */
const AUTOMATION_CALLER: OperationContext = { workspaceRef: null, cwd: null, signal: NEVER };

export async function invokePluginAction(
  deps: PluginActionDeps,
  action: OperationName,
  input: Record<string, unknown>
): Promise<unknown> {
  const mapping = PLUGIN_ACTIONS_MAP[action];
  if (mapping === null || mapping.kind !== "invoke") {
    throw new ApiError("usage", `${action} is not an action an automation can run`);
  }
  return deps.registry.invoke(deps.registry.get(action), AUTOMATION_CALLER, input, mapping);
}
