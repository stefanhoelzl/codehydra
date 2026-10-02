/**
 * DebugModule - Dev-only module for simulating hard-to-trigger UI flows.
 *
 * Controlled by config keys (env vars / CLI flags):
 * - debug.blocking-pids: Simulate blocking processes during workspace deletion
 * - debug.setup: Force setup flow with simulated binary download progress
 * - debug.update: Simulate an update notification. "pending" (or bare flag)
 *   shows "Update available" with the full install → download → ready flow;
 *   "downloaded" jumps straight to "Update ready".
 *
 * Only active in development mode (requires: { development: true }).
 */

import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Config } from "../boundaries/platform/config";
import { storeBoolean, storeEnum } from "../boundaries/platform/store-definition";
import { APP_START_OPERATION_ID, type CheckDepsResult } from "../intents/app-start";
import type { BinaryType } from "../utils/binary-resolution/types";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  type DeleteHookResult,
  type DetectHookResult,
} from "../intents/delete-workspace";
import {
  RESOLVE_WORKSPACE_OPERATION_ID,
  type ResolveHookResult,
} from "../intents/resolve-workspace";

import { SETUP_OPERATION_ID, type SetupProgressPayload } from "../intents/setup";
import type { Dispatcher } from "../intents/lib/dispatcher";
import { NotificationCard, notify } from "./presentation/notification-card";
import type { NotificationConfig } from "../shared/notification-types";
import type { WorkspacePath } from "../intents/contract";
import { Path } from "../utils/path/path";
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";
import { defineHooks } from "../intents/declarations";

interface DebugModuleDeps {
  readonly configService: Config;
  /** Raises the simulated update cards; without it the update simulation is off. */
  readonly dispatcher?: Pick<Dispatcher, "dispatch">;
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
    ].map((accessor) => [accessor.name, accessor] as const)
  );

  // "true" is what a bare --debug.update CLI flag parses to; treat it as "pending".
  const updateModeConfig = configService.register("debug.update", {
    default: null,
    description:
      "Simulate update notification: pending = available + install flow, downloaded = ready to install",
    ...storeEnum(["true", "pending", "downloaded"], { nullable: true }),
  });

  function isActive(key: string): boolean {
    return debugConfigs.get(key)?.get() === true;
  }

  function updateMode(): "pending" | "downloaded" | null {
    const value = updateModeConfig.get();
    return value === "true" ? "pending" : value;
  }

  // Workspaces kept alive by debug.blocking-pids after deletion
  const debugWorkspaces = new Map<WorkspacePath, ResolveHookResult>();

  return {
    name: "debug",
    requires: { development: true },
    hooks: defineHooks({
      // --- Blocking PIDs scenario ---
      [DELETE_WORKSPACE_OPERATION_ID]: {
        delete: {
          handler: async (ctx): Promise<HookOutput<DeleteHookResult>> => {
            if (!isActive("debug.blocking-pids")) return { result: {} };
            const { projectPath, workspacePath, workspaceName } = ctx;
            const projectRef = projectRefFor(projectPath);
            debugWorkspaces.set(workspacePath, {
              workspaceRef: makeWorkspaceRef(projectRef, workspaceName),
              workspacePath,
              projectRef,
              projectPath,
              workspaceName,
              branch: null,
              metadata: {},
            });
            return { result: { error: "Debug: simulated file lock" } };
          },
        },
        detect: {
          handler: async (): Promise<HookOutput<DetectHookResult>> => {
            if (!isActive("debug.blocking-pids")) return { result: {} };
            return {
              result: {
                blockingProcesses: [
                  {
                    pid: 99999,
                    name: "debug-blocker",
                    commandLine: "debug --simulated",
                    files: ["locked-file.txt"],
                    cwd: null,
                  },
                ],
              },
            };
          },
        },
      },

      // --- Blocking PIDs: resolve cached workspace identity ---
      [RESOLVE_WORKSPACE_OPERATION_ID]: {
        resolve: {
          handler: async (ctx): Promise<HookOutput<ResolveHookResult>> => {
            const { payload } = ctx.intent;
            for (const cached of debugWorkspaces.values()) {
              // A path compares as a path: a caller may hand it over in the OS's form.
              const byPath =
                payload.workspacePath !== undefined &&
                cached.workspacePath !== undefined &&
                new Path(cached.workspacePath).equals(payload.workspacePath);
              if (cached.workspaceRef === payload.workspaceRef || byPath) {
                return { result: cached };
              }
            }
            return { result: {} };
          },
        },
      },

      // --- Setup: check-deps + binary download simulation ---
      [APP_START_OPERATION_ID]: {
        "check-deps": {
          handler: async (): Promise<HookOutput<CheckDepsResult>> => {
            if (!isActive("debug.setup")) return { result: {} };
            return { result: { missingBinaries: ["claude" as BinaryType] } };
          },
        },
        start: {
          handler: async (): Promise<void> => {
            const mode = updateMode();
            if (mode === null || !deps.dispatcher) return;
            const version = "99.0.0-debug";
            if (mode === "downloaded") {
              notify(deps.dispatcher, readyConfig(version));
            } else {
              void simulateUpdateNotification(deps.dispatcher, version);
            }
          },
        },
      },

      // --- Setup: binary download simulation ---
      [SETUP_OPERATION_ID]: {
        binary: {
          // Streaming handler: yield progress frames; the setup operation emits them.
          handler: async function* (): AsyncGenerator<SetupProgressPayload, void, void> {
            if (!isActive("debug.setup")) return;
            yield { id: "agent", status: "running", progress: 0 };
            for (let progress = 10; progress <= 100; progress += 10) {
              await delay(300);
              yield { id: "agent", status: "running", progress };
            }
            yield { id: "agent", status: "done" };
          },
        },
      },
    }),
  };
}

function readyConfig(version: string): NotificationConfig {
  return {
    type: "info",
    title: "Update ready",
    message: `Version ${version} will be installed when CodeHydra quits.`,
    dismissible: false,
    actions: [{ id: "restart", label: "Restart Now" }],
  };
}

async function simulateUpdateNotification(
  dispatcher: Pick<Dispatcher, "dispatch">,
  version: string
): Promise<void> {
  const available: NotificationConfig = {
    type: "info",
    title: "Update available",
    message: `Version ${version} is ready to download.`,
    dismissible: true,
    actions: [{ id: "install", label: "Install" }],
  };
  const card = new NotificationCard(dispatcher);
  if ((await card.ask(available)) === "install") {
    await simulateDownload(card, version);
  }
}

async function simulateDownload(card: NotificationCard, version: string): Promise<void> {
  for (let percent = 5; percent <= 100; percent += 5) {
    card.show({
      type: "spinner",
      title: "Downloading update",
      message: `Version ${version}`,
      progress: percent / 100,
      dismissible: false,
    });
    await delay(150);
  }
  card.show(readyConfig(version));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
