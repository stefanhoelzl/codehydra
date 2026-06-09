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
import { storeBoolean } from "../boundaries/platform/store-definition";
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
import type { NotificationManager, NotificationHandle } from "./notification-manager";
import type { NotificationConfig } from "../shared/notification-types";

interface DebugModuleDeps {
  readonly configService: Config;
  readonly notificationManager?: NotificationManager;
}

export function createDebugModule(deps: DebugModuleDeps): IntentModule {
  const { configService } = deps;

  // Register debug config keys, then index the accessors by their key name so
  // the key string isn't duplicated between registration and lookup.
  const debugConfigs = new Map(
    [
      configService.register("debug.blocking-pids", {
        default: false,
        description: "Simulate blocking processes during workspace deletion",
        ...storeBoolean(),
      }),
      configService.register("debug.setup", {
        default: false,
        description: "Force setup flow with simulated binary download progress",
        ...storeBoolean(),
      }),
      configService.register("debug.update", {
        default: false,
        description: "Simulate available update with download progress",
        ...storeBoolean(),
      }),
    ].map((accessor) => [accessor.name, accessor] as const)
  );

  function isActive(key: string): boolean {
    return debugConfigs.get(key)?.get() === true;
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

      // --- Setup: check-deps + binary download simulation ---
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<CheckDepsResult> => {
            if (!isActive("debug.setup")) return {};
            return { missingBinaries: ["claude" as BinaryType] };
          },
        },
        start: {
          handler: async (): Promise<void> => {
            if (!isActive("debug.update") || !deps.notificationManager) return;
            const version = "99.0.0-debug";
            simulateUpdateNotification(deps.notificationManager, version);
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
    },
  };
}

function simulateUpdateNotification(manager: NotificationManager, version: string): void {
  const available: NotificationConfig = {
    type: "info",
    title: "Update available",
    message: `Version ${version} is ready to download.`,
    dismissible: true,
    actions: [{ id: "install", label: "Install" }],
  };
  const handle: NotificationHandle = manager.open(available);
  handle.onEvent((event) => {
    if (event.actionId === "install") {
      void simulateDownload(handle, version);
    }
  });
}

async function simulateDownload(handle: NotificationHandle, version: string): Promise<void> {
  for (let percent = 5; percent <= 100; percent += 5) {
    handle.update({
      type: "spinner",
      title: "Downloading update",
      message: `Version ${version}`,
      progress: percent / 100,
      dismissible: false,
    });
    await delay(150);
  }
  handle.update({
    type: "info",
    title: "Update ready",
    message: `Version ${version} is ready to install.`,
    dismissible: false,
    actions: [{ id: "restart", label: "Restart Now" }],
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
