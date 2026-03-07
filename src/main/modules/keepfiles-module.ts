/**
 * KeepFilesModule - Copies .keepfiles to new workspaces (best-effort).
 *
 * Hooks:
 * - open-workspace → setup: copies keepfiles from project root to workspace
 *
 * Errors are caught and logged — keepfiles is non-fatal.
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IKeepFilesService } from "../../services/keepfiles/types";
import type { Logger } from "../../services/logging/types";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  type OpenWorkspaceIntent,
  type SetupHookInput,
  type SetupHookResult,
} from "../operations/open-workspace";
import { Path } from "../../services/platform/path";

interface KeepFilesModuleDeps {
  readonly keepFilesService: IKeepFilesService;
  readonly logger: Logger;
}

export function createKeepFilesModule(deps: KeepFilesModuleDeps): IntentModule {
  return {
    name: "keepfiles",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<SetupHookResult> => {
            const setupCtx = ctx as SetupHookInput;
            const intent = ctx.intent as OpenWorkspaceIntent;

            // Skip keepfiles for re-opened workspaces — only copy for newly created ones
            if (intent.payload.existingWorkspace !== undefined) {
              return {};
            }

            try {
              await deps.keepFilesService.copyToWorkspace(
                new Path(setupCtx.projectPath),
                new Path(setupCtx.workspacePath)
              );
            } catch (error) {
              deps.logger.error(
                "Keepfiles copy failed for workspace (non-fatal)",
                { workspacePath: setupCtx.workspacePath },
                error instanceof Error ? error : undefined
              );
              // Do not re-throw -- keepfiles is best-effort
            }

            return {};
          },
        },
      },
    },
  };
}
