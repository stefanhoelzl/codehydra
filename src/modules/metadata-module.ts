/**
 * MetadataModule - Hook handler module for workspace metadata operations.
 *
 * Provides hook handlers for:
 * - set-metadata "set" hook point: writes metadata through the core workspace registry
 * - get-metadata "get" hook point: reads metadata from the core workspace registry
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import { Path } from "../utils/path/path";
import { SET_METADATA_OPERATION_ID } from "../intents/set-metadata";
import { GET_METADATA_OPERATION_ID } from "../intents/get-metadata";
import type { GetMetadataHookResult } from "../intents/get-metadata";
import { defineHooks } from "../intents/declarations";
import type { WorkspaceRegistry } from "./workspace-registry-module";

interface MetadataModuleDeps {
  readonly registry: Pick<WorkspaceRegistry, "metadata" | "setMetadata">;
}

export function createMetadataModule(deps: MetadataModuleDeps): IntentModule {
  return {
    name: "metadata",
    hooks: defineHooks({
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx) => {
            const { workspacePath, intent } = ctx;
            await deps.registry.setMetadata(
              new Path(workspacePath),
              intent.payload.key,
              intent.payload.value
            );
          },
        },
      },
      [GET_METADATA_OPERATION_ID]: {
        get: {
          handler: async (ctx): Promise<HookOutput<GetMetadataHookResult>> => {
            const metadata = deps.registry.metadata(new Path(ctx.workspacePath));
            return { result: { metadata } };
          },
        },
      },
    }),
  };
}
