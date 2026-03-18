/**
 * DebugModule - Dev-only module for simulating hard-to-trigger UI flows.
 *
 * Controlled by config keys (env vars / CLI flags):
 * - debug.blocking-pids: Simulate blocking processes during workspace deletion
 * - debug.setup: Force setup flow with simulated binary download progress
 * - debug.update: Simulate available update with download progress
 *
 * Only active in development mode (requires: { development: true }).
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { Config } from "../boundaries/platform/config";
import { configBoolean } from "../boundaries/platform/config-definition";
import { APP_START_OPERATION_ID, type CheckDepsResult } from "../intents/app-start";
import type { BinaryType } from "../utils/binary-resolution/types";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteHookResult,
  type DeletePipelineHookInput,
  type DetectHookResult,
} from "../intents/delete-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookInput,
  type ResolveHookResult,
} from "../intents/resolve-workspace";
import { extractWorkspaceName } from "../shared/api/id-utils";
import type { WorkspaceName } from "../shared/api/types";
import { SETUP_OPERATION_ID, type BinaryHookInput } from "../intents/setup";
import {
  UPDATE_APPLY_OPERATION_ID,
  type UpdateChoiceResult,
  type UpdateDownloadResult,
} from "../intents/update-apply";
import type { DialogManager } from "./dialog-manager";
import type { DialogConfig, DialogAction } from "../shared/dialog-types";

interface DebugModuleDeps {
  readonly configService: Config;
  readonly dialogManager?: DialogManager;
}

export function createDebugModule(deps: DebugModuleDeps): IntentModule {
  const { configService } = deps;

  // Register debug config keys
  configService.register("debug.blocking-pids", {
    name: "debug.blocking-pids",
    default: false,
    description: "Simulate blocking processes during workspace deletion",
    ...configBoolean(),
  });
  configService.register("debug.setup", {
    name: "debug.setup",
    default: false,
    description: "Force setup flow with simulated binary download progress",
    ...configBoolean(),
  });
  configService.register("debug.update", {
    name: "debug.update",
    default: false,
    description: "Simulate available update with download progress",
    ...configBoolean(),
  });

  function isActive(key: string): boolean {
    return configService.get(key) === true;
  }

  // Workspaces kept alive by debug.blocking-pids after deletion
  const debugWorkspaces = new Map<string, { projectPath: string; workspaceName: WorkspaceName }>();

  return {
    name: "debug",
    requires: { development: true },
    hooks: {
      // --- Blocking PIDs scenario ---
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx: HookContext): Promise<DeleteHookResult> => {
            if (!isActive("debug.blocking-pids")) return {};
            const { projectPath, workspacePath } = ctx as DeletePipelineHookInput;
            debugWorkspaces.set(workspacePath, {
              projectPath,
              workspaceName: extractWorkspaceName(workspacePath),
            });
            return { error: "Debug: simulated file lock" };
          },
        },
        detect: {
          handler: async (): Promise<DetectHookResult> => {
            if (!isActive("debug.blocking-pids")) return {};
            return {
              blockingProcesses: [
                {
                  pid: 99999,
                  name: "debug-blocker",
                  commandLine: "debug --simulated",
                  files: ["locked-file.txt"],
                  cwd: null,
                },
              ],
            };
          },
        },
      },

      // --- Blocking PIDs: resolve cached workspace identity ---
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult> => {
            const { workspacePath } = ctx as ResolveHookInput;
            const cached = debugWorkspaces.get(workspacePath);
            if (!cached) return {};
            return {
              projectPath: cached.projectPath,
              workspaceName: cached.workspaceName,
            };
          },
        },
      },

      // --- Setup + Update: check-deps hook ---
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            const debugSetup = isActive("debug.setup");
            const debugUpdate = isActive("debug.update");
            if (!debugSetup && !debugUpdate) return {};
            return {
              ...(debugSetup && { missingBinaries: ["claude" as BinaryType] }),
              ...(debugUpdate && { updateNeedsChoice: true }),
            };
          },
        },
      },

      // --- Setup: binary download simulation ---
      [SETUP_OPERATION_ID]: {
        binary: {
          handler: async (ctx: HookContext): Promise<void> => {
            if (!isActive("debug.setup")) return;
            const { report } = ctx as BinaryHookInput;
            report("agent", "running", undefined, undefined, 0);
            for (let progress = 10; progress <= 100; progress += 10) {
              await delay(300);
              report("agent", "running", undefined, undefined, progress);
            }
            report("agent", "done");
          },
        },
      },

      // --- Update: choice + download simulation via DialogManager ---
      [UPDATE_APPLY_OPERATION_ID]: {
        "await-choice": {
          handler: async (): Promise<UpdateChoiceResult> => {
            if (!isActive("debug.update") || !deps.dialogManager) return {};
            const version = "99.0.0-debug";
            const config: DialogConfig = {
              sections: [
                { type: "text", content: "Update Available", style: "heading" },
                { type: "text", content: `Version ${version} is ready to install.` },
              ],
              actions: [
                { id: "always", label: "Always", variant: "secondary" },
                { id: "yes", label: "Yes" },
                { id: "skip", label: "Skip", variant: "secondary" },
                { id: "never", label: "Never", variant: "secondary" },
              ],
            };
            const handle = deps.dialogManager.open(config);
            const event = await handle.nextEvent(5 * 60_000);
            handle.close();
            const choiceMap: Record<string, "always" | "yes" | "skip" | "never"> = {
              always: "always",
              yes: "yes",
              skip: "skip",
              never: "never",
            };
            const choice = choiceMap[event.actionId];
            return choice ? { choice } : {};
          },
        },
        download: {
          handler: async (): Promise<UpdateDownloadResult> => {
            if (!isActive("debug.update") || !deps.dialogManager) return {};
            const version = "99.0.0-debug";
            const buildConfig = (pct: number): DialogConfig => {
              const actions: DialogAction[] = [
                { id: "cancel", label: "Cancel", variant: "secondary" },
              ];
              return {
                sections: [
                  { type: "text", content: "Updating CodeHydra", style: "heading" },
                  {
                    type: "progress",
                    items: [
                      {
                        id: "dl",
                        label: `Downloading v${version}`,
                        status: "running",
                        ...(pct > 0 && { progress: pct }),
                        ...(pct > 0 && { message: `${pct}%` }),
                      },
                    ],
                  },
                  {
                    type: "text",
                    content: "The app will restart automatically.",
                    style: "subtitle",
                  },
                ],
                actions,
              };
            };
            const handle = deps.dialogManager.open(buildConfig(0));
            let cancelled = false;
            handle.onEvent((evt) => {
              if (evt.actionId === "cancel") cancelled = true;
            });
            for (let percent = 5; percent <= 100 && !cancelled; percent += 5) {
              await delay(150);
              handle.update(buildConfig(percent));
            }
            handle.close();
            return { cancelled: true }; // Don't actually install in debug mode
          },
        },
      },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
