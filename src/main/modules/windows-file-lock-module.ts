/**
 * WindowsFileLockModule — Handles Windows file lock detection/removal during workspace deletion.
 *
 * Hooks:
 * - delete-workspace → release: CWD-only scan + kill blocking processes (best-effort)
 * - delete-workspace → detect: full handle detection
 * - delete-workspace → flush: kill PIDs collected by detect
 *
 * All hooks are no-ops when workspaceLockHandler is undefined (non-Windows).
 */

import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { Logger } from "../../services/logging/types";
import type { WorkspaceLockHandler } from "../../services/platform/workspace-lock-handler";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteWorkspaceIntent,
  type ReleaseHookResult,
  type DetectHookResult,
  type FlushHookResult,
  type FlushHookInput,
} from "../operations/delete-workspace";
import { Path } from "../../services/platform/path";
import { getErrorMessage } from "../../shared/error-utils";

interface WindowsFileLockModuleDeps {
  readonly workspaceLockHandler: WorkspaceLockHandler | undefined;
  readonly logger: Logger;
}

export function createWindowsFileLockModule(deps: WindowsFileLockModuleDeps): IntentModule {
  return {
    hooks: {
      [DELETE_WORKSPACE_OPERATION_ID]: {
        release: {
          handler: async (ctx: HookContext): Promise<ReleaseHookResult> => {
            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            if (payload.force || !deps.workspaceLockHandler) {
              return {};
            }

            // CWD-only scan: find and kill processes whose CWD is under workspace
            try {
              const cwdProcesses = await deps.workspaceLockHandler.detectCwd(
                new Path(payload.workspacePath)
              );
              if (cwdProcesses.length > 0) {
                deps.logger.info("Killing CWD-blocking processes before deletion", {
                  workspacePath: payload.workspacePath,
                  pids: cwdProcesses.map((p) => p.pid).join(","),
                });
                await deps.workspaceLockHandler.killProcesses(cwdProcesses.map((p) => p.pid));
              }
            } catch {
              // Non-fatal: CWD detection/kill failure shouldn't block deletion
            }
            return {};
          },
        },
        detect: {
          handler: async (ctx: HookContext): Promise<DetectHookResult> => {
            if (!deps.workspaceLockHandler) return {};

            const { payload } = ctx.intent as DeleteWorkspaceIntent;

            try {
              const detected = await deps.workspaceLockHandler.detect(
                new Path(payload.workspacePath)
              );
              return { blockingProcesses: detected };
            } catch (error) {
              deps.logger.warn("Detection failed", {
                workspacePath: payload.workspacePath,
                error: getErrorMessage(error),
              });
              return { blockingProcesses: [] };
            }
          },
        },
        flush: {
          handler: async (ctx: HookContext): Promise<FlushHookResult> => {
            if (!deps.workspaceLockHandler) return {};

            const { blockingPids } = ctx as FlushHookInput;
            if (blockingPids.length > 0) {
              try {
                await deps.workspaceLockHandler.killProcesses([...blockingPids]);
              } catch (error) {
                return { error: getErrorMessage(error) };
              }
            }
            return {};
          },
        },
      },
    },
  };
}
