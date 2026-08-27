/**
 * The plugin wire's view of the operation vocabulary.
 *
 * Exhaustive by construction: `Record<OperationName, …>` means an operation
 * added to the vocabulary fails to compile until this file says what the plugin
 * wire does with it. An operation the wire deliberately does not carry is
 * written as `null`, so "absent" is always a decision someone made rather than
 * something nobody noticed.
 *
 * Channel names are historical and are NOT derived from operation names — they
 * are a published contract (docs/API.md) that third-party extensions call.
 */

import type { OperationName } from "../names";
import type { InputShaping } from "../registry";

export interface PluginMapping extends InputShaping {
  /** Socket.IO channel, e.g. `api:workspace:delete`. */
  readonly channel: string;
  /**
   * Skip the ack on this wire.
   *
   * A void result does not imply fire-and-forget — this is an optimization the
   * sidekick's long-lived connection allows, and it is why `api:log` has never
   * acknowledged. A short-lived client (the CLI) must never do this: it can exit
   * before the frame leaves the buffer.
   */
  readonly fireAndForget?: boolean;
}

export const PLUGIN_MAP: Readonly<Record<OperationName, PluginMapping | null>> = {
  // Workspace-scoped channels predate the optional `workspacePath` target, and
  // a plugin client is always scoped to its own workspace by the handshake — so
  // they pick only the fields the published contract documents.
  "workspace.status": { channel: "api:workspace:getStatus", pick: ["refresh"] },
  "workspace.hibernate": { channel: "api:workspace:hibernate" },
  "workspace.wake": { channel: "api:workspace:wake" },
  "workspace.create": { channel: "api:workspace:create" },
  "workspace.delete": { channel: "api:workspace:delete" },
  "workspace.switch": { channel: "api:workspace:switch" },
  "workspace.title": { channel: "api:workspace:setTitle" },
  "workspace.tag.list": { channel: "api:workspace:listTags" },
  "workspace.tag.set": { channel: "api:workspace:setTag" },
  "workspace.tag.remove": { channel: "api:workspace:removeTag" },

  "metadata.get": { channel: "api:workspace:getMetadata", pick: [] },
  "metadata.set": { channel: "api:workspace:setMetadata", pick: ["key", "value"] },

  "agent.session": { channel: "api:workspace:getAgentSession", pick: [] },
  "agent.restart": { channel: "api:workspace:restartAgentServer", pick: [] },
  "agent.open": { channel: "api:workspace:openAgent" },
  "agent.close": { channel: "api:workspace:closeAgent" },
  "agent.status.set": { channel: "api:workspace:setAgentStatus" },
  // The one event. Only an observer that witnessed the terminal event can send
  // it truthfully, and the sidekick is that observer.
  "agent.lifecycle": { channel: "api:workspace:agentLifecycle", fireAndForget: true },

  "vscode.command": { channel: "api:workspace:executeCommand", pick: ["command", "args"] },
  "vscode.message": { channel: "api:workspace:showMessage" },
  // The notify / status-bar / ask forms exist to give the CLI three commands
  // instead of one with a mode flag. On the wire that split buys nothing, so the
  // plugin carries only the general form above.
  "vscode.notify": null,
  "vscode.status-bar": null,
  "vscode.ask": null,
  "vscode.browser": { channel: "api:workspace:openBrowser" },
  "vscode.diff": { channel: "api:workspace:openDiff" },
  "vscode.goto": { channel: "api:workspace:goto" },
  "vscode.preview": { channel: "api:workspace:previewMarkdown" },
  "system.open": { channel: "api:workspace:openSystemPath" },

  "project.list": { channel: "api:project:list" },
  "project.open": { channel: "api:project:open" },
  "project.close": { channel: "api:project:close" },
  log: { channel: "api:log", fireAndForget: true },
  "report.issue": { channel: "api:reportIssue" },
};
