/**
 * MetadataModule - Hook handler module for workspace metadata operations.
 *
 * Provides hook handlers for:
 * - set-metadata "set" hook point: writes metadata via GitWorktreeProvider
 * - get-metadata "get" hook point: reads metadata via GitWorktreeProvider
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import { Path } from "../utils/path/path";
import { SET_METADATA_OPERATION_ID } from "../intents/set-metadata";
import { GET_METADATA_OPERATION_ID } from "../intents/get-metadata";
import type { GetMetadataHookResult } from "../intents/get-metadata";
import { defineHooks } from "../intents/declarations";

interface MetadataModuleDeps {
  readonly gitWorktreeProvider: GitWorktreeProvider;
}

export function createMetadataModule(deps: MetadataModuleDeps): IntentModule {
  return {
    name: "metadata",
    hooks: defineHooks({
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx) => {
            const { workspacePath } = ctx;
            const { intent } = ctx;
            await deps.gitWorktreeProvider.setMetadata(
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
            const { workspacePath } = ctx;
            const metadata = await deps.gitWorktreeProvider.getMetadata(new Path(workspacePath));
            return { result: { metadata } };
          },
        },
      },
    }),
  };
}
