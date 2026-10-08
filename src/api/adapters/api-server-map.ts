/**
 * The API server wire's view of the operation vocabulary.
 *
 * Exhaustive by construction: `Record<OperationName, …>` means an operation
 * added to the vocabulary fails to compile until this file says what the API server
 * wire does with it. An operation the wire deliberately does not carry is
 * written as `null`, so "absent" is always a decision someone made rather than
 * something nobody noticed.
 *
 * Channel names are historical and are NOT derived from operation names — they
 * are a published contract (docs/API.md) that third-party extensions call.
 */

import type { OperationName } from "../names";
import type { InputShaping } from "../registry";

export interface ApiServerMapping extends InputShaping {
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

export const API_SERVER_MAP: Readonly<Record<OperationName, ApiServerMapping | null>> = {
  // Every channel takes the entry's full input, target fields included: an
  // extension is its own workspace, and names another the way any caller does.
  "workspace.status": { channel: "api:workspace:getStatus" },
  "workspace.hibernate": { channel: "api:workspace:hibernate" },
  "workspace.wake": { channel: "api:workspace:wake" },
  "workspace.wakeup.set": { channel: "api:workspace:setWakeup" },
  "workspace.wakeup.clear": { channel: "api:workspace:clearWakeup" },
  "workspace.wakeup.show": { channel: "api:workspace:getWakeup" },
  "workspace.create": { channel: "api:workspace:create" },
  "workspace.delete": { channel: "api:workspace:delete" },
  "workspace.switch": { channel: "api:workspace:switch" },
  "workspace.title": { channel: "api:workspace:setTitle" },
  "workspace.tag.list": { channel: "api:workspace:listTags" },
  "workspace.tag.set": { channel: "api:workspace:setTag" },
  "workspace.tag.remove": { channel: "api:workspace:removeTag" },

  "metadata.get": { channel: "api:workspace:getMetadata" },
  "metadata.set": { channel: "api:workspace:setMetadata" },

  "agent.session": { channel: "api:workspace:getAgentSession" },
  "agent.restart": { channel: "api:workspace:restartAgentServer" },
  "agent.open": { channel: "api:workspace:openAgent" },
  "agent.close": { channel: "api:workspace:closeAgent" },
  "agent.message": { channel: "api:workspace:sendAgentMessage" },
  "agent.status.set": { channel: "api:workspace:setAgentStatus" },
  // The one event. Only an observer that witnessed the terminal event can send
  // it truthfully, and the sidekick is that observer.
  "agent.lifecycle": { channel: "api:workspace:agentLifecycle", fireAndForget: true },

  "vscode.command": { channel: "api:workspace:executeCommand" },
  "vscode.message": { channel: "api:workspace:showMessage" },
  // The notify / status-bar / ask forms exist to give the CLI three commands
  // instead of one with a mode flag. On the wire that split buys nothing, so the
  // API server carries only the general form above.
  "vscode.notify": null,
  "vscode.status-bar": null,
  "vscode.ask": null,
  "vscode.browser": { channel: "api:workspace:openBrowser" },
  "vscode.diff": { channel: "api:workspace:openDiff" },
  "vscode.goto": { channel: "api:workspace:goto" },
  "vscode.preview": { channel: "api:workspace:previewMarkdown" },
  "system.open": { channel: "api:workspace:openSystemPath" },
  "notification.show": { channel: "api:notification:show" },
  "notification.close": { channel: "api:notification:close" },

  "project.list": { channel: "api:project:list" },
  "project.open": { channel: "api:project:open" },
  "project.close": { channel: "api:project:close" },
  // No extension needs locks, and the API server surface is a published contract —
  // it grows when a consumer does, not before.
  "lock.take": null,
  "lock.release": null,
  "lock.list": null,
  "lock.hold": null,
  // Plugins are the user's and the repository's, managed from a shell or an
  // agent; no extension needs them.
  "plugin.list": null,
  "plugin.enable": null,
  "plugin.disable": null,
  "plugin.add": null,
  "plugin.remove": null,
  "plugin.update": null,
  "plugin.errors": null,
  "plugin.schema": null,
  "plugin.render": null,
  "config.get": { channel: "api:config:get" },
  "config.list": { channel: "api:config:list" },
  "config.set": { channel: "api:config:set" },
  "config.reset": { channel: "api:config:reset" },
  log: { channel: "api:log", fireAndForget: true },
  "report.issue": { channel: "api:reportIssue" },
  // For people and agents reading how CodeHydra works; an extension has no use for it.
  guide: null,
};
