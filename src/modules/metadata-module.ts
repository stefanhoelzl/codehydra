/**
 * MetadataModule - Hook handler module for workspace metadata operations.
 *
 * Provides hook handlers for:
 * - set-metadata "set" hook point: writes metadata via GitWorktreeProvider
 * - get-metadata "get" hook point: reads metadata via GitWorktreeProvider
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { GitWorktreeProvider } from "../boundaries/platform/git-worktree-provider";
import { Path } from "../utils/path/path";
import { SET_METADATA_OPERATION_ID } from "../intents/set-metadata";
import type { SetMetadataIntent, SetHookInput } from "../intents/set-metadata";
import { GET_METADATA_OPERATION_ID } from "../intents/get-metadata";
import type { GetMetadataHookResult, GetHookInput } from "../intents/get-metadata";

interface MetadataModuleDeps {
  readonly gitWorktreeProvider: GitWorktreeProvider;
}

export function createMetadataModule(deps: MetadataModuleDeps): IntentModule {
  return {
    name: "metadata",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
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
          handler: async (ctx: HookContext): Promise<GetMetadataHookResult> => {
            const { workspacePath } = ctx as GetHookInput;
            const metadata = await deps.gitWorktreeProvider.getMetadata(new Path(workspacePath));
            return { metadata };
          },
        },
      },
    },
  };
}
