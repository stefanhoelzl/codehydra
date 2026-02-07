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
  };

  return { events };
}
