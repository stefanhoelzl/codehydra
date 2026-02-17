/**
 * MetadataModule - Hook handler module for workspace metadata operations.
 *
 * Provides hook handlers for:
 * - set-metadata "set" hook point: writes metadata via GitWorktreeProvider
 * - get-metadata "get" hook point: reads metadata via GitWorktreeProvider
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { GitWorktreeProvider } from "../../services/git/git-worktree-provider";
import { Path } from "../../services/platform/path";
import { SET_METADATA_OPERATION_ID } from "../operations/set-metadata";
import type { SetMetadataIntent, SetHookInput } from "../operations/set-metadata";
import { GET_METADATA_OPERATION_ID } from "../operations/get-metadata";
import type { GetMetadataHookResult, GetHookInput } from "../operations/get-metadata";

interface MetadataModuleDeps {
  readonly globalProvider: GitWorktreeProvider;
}

export function createMetadataModule(deps: MetadataModuleDeps): IntentModule {
  return {
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext) => {
            const { workspacePath } = ctx as SetHookInput;
            const intent = ctx.intent as SetMetadataIntent;
            await deps.globalProvider.setMetadata(
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
            const metadata = await deps.globalProvider.getMetadata(new Path(workspacePath));
            return { metadata };
          },
        },
      },
    },
  };
}
