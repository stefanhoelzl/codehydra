/**
 * IpcEventBridge - Bridges domain events to the ApiRegistry event system.
 *
 * This is an IntentModule that subscribes to domain events emitted by operations
 * and forwards them to ApiRegistry.emit() for IPC notification to the renderer.
 *
 * Temporary bridge between old (ApiRegistry events) and new (domain events)
 * patterns. Will be removed when the old module system is fully replaced.
 */

import type { IntentModule, EventDeclarations } from "../intents/infrastructure/module";
import type { DomainEvent } from "../intents/infrastructure/types";
import type { IApiRegistry } from "../api/registry-types";
import type { MetadataChangedPayload, MetadataChangedEvent } from "../operations/set-metadata";
import { EVENT_METADATA_CHANGED } from "../operations/set-metadata";
import type { ModeChangedPayload, ModeChangedEvent } from "../operations/set-mode";
import { EVENT_MODE_CHANGED } from "../operations/set-mode";
import type { WorkspaceCreatedEvent } from "../operations/open-workspace";
import { EVENT_WORKSPACE_CREATED } from "../operations/open-workspace";
import type { ProjectOpenedEvent } from "../operations/open-project";
import { EVENT_PROJECT_OPENED } from "../operations/open-project";
import type { ProjectClosedEvent } from "../operations/close-project";
import { EVENT_PROJECT_CLOSED } from "../operations/close-project";
import type { WorkspaceSwitchedEvent } from "../operations/switch-workspace";
import { EVENT_WORKSPACE_SWITCHED } from "../operations/switch-workspace";
import type { AgentStatusUpdatedEvent } from "../operations/update-agent-status";
import { EVENT_AGENT_STATUS_UPDATED } from "../operations/update-agent-status";
import type { WorkspaceStatus } from "../../shared/api/types";

/**
 * Create an IpcEventBridge module that forwards domain events to the API registry.
 *
 * @param apiRegistry - The API registry to emit events on
 * @returns IntentModule with event subscriptions
 */
export function createIpcEventBridge(apiRegistry: IApiRegistry): IntentModule {
  const events: EventDeclarations = {
    [EVENT_METADATA_CHANGED]: (event: DomainEvent) => {
      const payload = (event as MetadataChangedEvent).payload as MetadataChangedPayload;
      apiRegistry.emit("workspace:metadata-changed", {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        key: payload.key,
        value: payload.value,
      });
    },
    [EVENT_MODE_CHANGED]: (event: DomainEvent) => {
      const payload = (event as ModeChangedEvent).payload as ModeChangedPayload;
      apiRegistry.emit("ui:mode-changed", {
        mode: payload.mode,
        previousMode: payload.previousMode,
      });
    },
    [EVENT_WORKSPACE_CREATED]: (event: DomainEvent) => {
      const p = (event as WorkspaceCreatedEvent).payload;
      apiRegistry.emit("workspace:created", {
        projectId: p.projectId,
        workspace: {
          projectId: p.projectId,
          name: p.workspaceName,
          branch: p.branch,
          metadata: p.metadata,
          path: p.workspacePath,
        },
        ...(p.initialPrompt && { hasInitialPrompt: true }),
        ...(p.keepInBackground && { keepInBackground: true }),
      });
    },
    [EVENT_PROJECT_OPENED]: (event: DomainEvent) => {
      const p = (event as ProjectOpenedEvent).payload;
      apiRegistry.emit("project:opened", { project: p.project });
    },
    [EVENT_PROJECT_CLOSED]: (event: DomainEvent) => {
      const p = (event as ProjectClosedEvent).payload;
      apiRegistry.emit("project:closed", { projectId: p.projectId });
    },
    [EVENT_WORKSPACE_SWITCHED]: (event: DomainEvent) => {
      const payload = (event as WorkspaceSwitchedEvent).payload;
      if (payload === null) {
        apiRegistry.emit("workspace:switched", null);
      } else {
        apiRegistry.emit("workspace:switched", {
          projectId: payload.projectId,
          workspaceName: payload.workspaceName,
          path: payload.path,
        });
      }
    },
    [EVENT_AGENT_STATUS_UPDATED]: (event: DomainEvent) => {
      const {
        workspacePath,
        projectId,
        workspaceName,
        status: aggregatedStatus,
      } = (event as AgentStatusUpdatedEvent).payload;

      const status: WorkspaceStatus =
        aggregatedStatus.status === "none"
          ? { isDirty: false, agent: { type: "none" } }
          : {
              isDirty: false,
              agent: {
                type: aggregatedStatus.status,
                counts: {
                  idle: aggregatedStatus.counts.idle,
                  busy: aggregatedStatus.counts.busy,
                  total: aggregatedStatus.counts.idle + aggregatedStatus.counts.busy,
                },
              },
            };

      apiRegistry.emit("workspace:status-changed", {
        projectId,
        workspaceName,
        path: workspacePath,
        status,
      });
    },
  };

  return { events };
}
