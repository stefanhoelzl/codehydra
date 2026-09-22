/**
 * MCP's view of the operation vocabulary.
 *
 * Exhaustive: a new operation fails to compile until this file says whether MCP
 * exposes it as a tool. Tool names are the ones agents already know — they were
 * the MCP server's surface before the registry existed, and renaming one would
 * silently break any prompt or transcript that refers to it.
 */

import type { OperationName } from "../names";
import type { InputShaping } from "../registry";

export interface McpMapping extends InputShaping {
  /** MCP tool name, e.g. `workspace_delete`. */
  readonly tool: string;
}

export const MCP_MAP: Readonly<Record<OperationName, McpMapping | null>> = {
  "workspace.status": { tool: "workspace_get_status" },
  "workspace.hibernate": { tool: "workspace_hibernate" },
  "workspace.wake": { tool: "workspace_wake" },
  "workspace.create": { tool: "workspace_create" },
  "workspace.delete": { tool: "workspace_delete" },
  "workspace.switch": { tool: "workspace_switch" },
  "workspace.title": { tool: "workspace_set_title" },
  "workspace.tag.list": { tool: "workspace_list_tags" },
  "workspace.tag.set": { tool: "workspace_set_tag" },
  "workspace.tag.remove": { tool: "workspace_remove_tag" },

  "metadata.get": { tool: "workspace_get_metadata" },
  "metadata.set": { tool: "workspace_set_metadata" },

  "agent.session": { tool: "workspace_get_agent_session" },
  "agent.restart": { tool: "workspace_restart_agent_server" },
  "agent.open": { tool: "workspace_open_agent" },
  "agent.close": { tool: "workspace_close_agent" },
  "agent.status.set": { tool: "workspace_set_agent_status" },
  // The one event: only an observer that witnessed the terminal event can send
  // it, and an agent is not that observer.
  "agent.lifecycle": null,

  "vscode.command": { tool: "workspace_execute_command" },
  "vscode.message": { tool: "ui_show_message" },
  // The split forms exist so the CLI has three commands instead of one with a
  // mode flag. A tool takes structured arguments already, so splitting it here
  // would only add schemas to every agent's context for no gain.
  "vscode.notify": null,
  "vscode.status-bar": null,
  "vscode.ask": null,
  "vscode.browser": { tool: "workspace_open_browser" },
  "vscode.diff": { tool: "workspace_open_diff" },
  "vscode.goto": { tool: "workspace_goto" },
  "vscode.preview": { tool: "workspace_preview_markdown" },
  "system.open": { tool: "system_open_path" },

  "project.list": { tool: "project_list" },
  "project.open": { tool: "project_open" },
  "project.close": { tool: "project_close" },
  // A tool call that waits unbounded would hang the agent's turn, so the MCP
  // take fails fast by default. Waiting belongs in a background shell.
  "lock.take": { tool: "lock_take", defaults: { noWait: true } },
  "lock.release": { tool: "lock_release" },
  "lock.list": { tool: "lock_list" },
  // `ch lock run`'s plumbing. Over MCP the connection is the whole agent
  // session, which is not what a hold tied to a process means.
  "lock.hold": null,
  log: { tool: "log" },
  "report.issue": { tool: "report_bug" },
};
