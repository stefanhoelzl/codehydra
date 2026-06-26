// @vitest-environment node
/**
 * Integration tests for DebugModule.
 *
 * Tests verify hook handler behavior via direct invocation with mock config.
 * Progress simulation tests use fake timers to avoid real delays.
 */

import { describe, it, expect, vi } from "vitest";
import { createDebugModule } from "./debug-module";
import type { IntentModule } from "../intents/lib/module";
import type { HookHandler, HookContext } from "../intents/lib/operation";
import { createMockConfig, createMockAccessor } from "../boundaries/platform/config.test-utils";
import type { Config } from "../boundaries/platform/config";
import type { CheckDepsResult } from "../intents/app-start";
import type { SetupProgressReporter } from "../intents/setup";
import type { DeleteHookResult, DetectHookResult } from "../intents/delete-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { RESOLVE_WORKSPACE_OPERATION_ID } from "../intents/resolve-workspace";
import type { ResolveHookResult } from "../intents/resolve-workspace";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { SETUP_OPERATION_ID } from "../intents/setup";
import { createMockNotificationManager } from "./presentation/notification-manager.state-mock";

// =============================================================================
// Test Helpers
// =============================================================================

function getHook(module: IntentModule, operationId: string, hookId: string): HookHandler {
  const hook = module.hooks?.[operationId]?.[hookId];
  if (!hook) throw new Error(`Hook ${operationId}/${hookId} not found`);
  return hook as HookHandler;
}

function makeHookContext(): HookContext {
  return { intent: { type: "test", payload: {} } };
}

interface ReportCall {
  id: string;
  status: string;
  message: string | undefined;
  error: string | undefined;
  progress: number | undefined;
}

function makeReportSpy(): {
  report: SetupProgressReporter;
  calls: ReportCall[];
} {
  const calls: ReportCall[] = [];
  const report: SetupProgressReporter = (id, status, message?, error?, progress?) => {
    calls.push({ id, status, message, error, progress });
  };
  return { report, calls };
}

// =============================================================================
// Tests
// =============================================================================

describe("DebugModule Integration", () => {
  describe("module metadata", () => {
    it("has name 'debug' and requires development", () => {
      const module = createDebugModule({ configService: createMockConfig() });
      expect(module.name).toBe("debug");
      expect(module.requires).toEqual({ development: true });
    });

    it("registers 3 config keys", () => {
      const registered: string[] = [];
      const config = createMockConfig();
      config.register = ((key: string, _definition: unknown) => {
        void _definition;
        registered.push(key);
        return createMockAccessor(key, false);
      }) as Config["register"];
      createDebugModule({ configService: config });
      expect(registered).toEqual(["debug.blocking-pids", "debug.setup", "debug.update"]);
    });
  });

  describe("blocking PIDs (inactive)", () => {
    it("delete hook returns empty object", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "delete");
      const result = (await hook.handler(makeHookContext())) as DeleteHookResult;
      expect(result).toEqual({});
    });

    it("detect hook returns empty object", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "detect");
      const result = (await hook.handler(makeHookContext())) as DetectHookResult;
      expect(result).toEqual({});
    });
  });

  describe("blocking PIDs (active)", () => {
    function makeDeleteCtx(workspacePath: string, projectPath: string): HookContext {
      return {
        intent: { type: "workspace:delete", payload: {} },
        projectPath,
        workspacePath,
        workspaceName: workspacePath.split("/").pop(),
      } as unknown as HookContext;
    }

    it("delete hook returns simulated error and captures workspace identity", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.blocking-pids": true } }),
      });
      const hook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "delete");
      const result = (await hook.handler(
        makeDeleteCtx("/projects/my-app/workspaces/test-1", "/projects/my-app")
      )) as DeleteHookResult;
      expect(result.error).toBe("Debug: simulated file lock");
    });

    it("detect hook returns fake blocking processes", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.blocking-pids": true } }),
      });
      const hook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "detect");
      const result = (await hook.handler(makeHookContext())) as DetectHookResult;
      expect(result.blockingProcesses).toHaveLength(1);
      expect(result.blockingProcesses![0]).toEqual({
        pid: 99999,
        name: "debug-blocker",
        commandLine: "debug --simulated",
        files: ["locked-file.txt"],
        cwd: null,
      });
    });

    it("resolve hook returns cached identity after delete captures it", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.blocking-pids": true } }),
      });

      // Run delete hook to capture workspace identity
      const deleteHook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "delete");
      await deleteHook.handler(
        makeDeleteCtx("/projects/my-app/workspaces/test-1", "/projects/my-app")
      );

      // Resolve hook should return the cached data
      const resolveHook = getHook(module, RESOLVE_WORKSPACE_OPERATION_ID, "resolve");
      const resolveCtx = {
        intent: { type: "workspace:resolve", payload: {} },
        workspacePath: "/projects/my-app/workspaces/test-1",
      } as unknown as HookContext;
      const result = (await resolveHook.handler(resolveCtx)) as ResolveHookResult;
      expect(result).toEqual({
        projectPath: "/projects/my-app",
        workspaceName: "test-1",
      });
    });

    it("resolve hook returns empty for unknown workspace", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.blocking-pids": true } }),
      });
      const resolveHook = getHook(module, RESOLVE_WORKSPACE_OPERATION_ID, "resolve");
      const ctx = {
        intent: { type: "workspace:resolve", payload: {} },
        workspacePath: "/unknown/path",
      } as unknown as HookContext;
      const result = (await resolveHook.handler(ctx)) as ResolveHookResult;
      expect(result).toEqual({});
    });
  });

  describe("setup (inactive)", () => {
    it("check-deps returns empty object", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result).toEqual({});
    });

    it("binary hook returns immediately", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, SETUP_OPERATION_ID, "binary");
      const { report, calls } = makeReportSpy();
      const ctx = { ...makeHookContext(), report } as unknown as HookContext;
      await hook.handler(ctx);
      expect(calls).toHaveLength(0);
    });
  });

  describe("setup (active)", () => {
    it("check-deps returns missingBinaries", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.setup": true } }),
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result.missingBinaries).toEqual(["claude"]);
    });

    it("binary hook calls report with progress increments", async () => {
      vi.useFakeTimers();
      try {
        const module = createDebugModule({
          configService: createMockConfig({ defaults: { "debug.setup": true } }),
        });
        const hook = getHook(module, SETUP_OPERATION_ID, "binary");
        const { report, calls } = makeReportSpy();
        const ctx = { ...makeHookContext(), report } as unknown as HookContext;

        const promise = hook.handler(ctx);

        // Initial report("agent", "running", ..., 0)
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({
          id: "agent",
          status: "running",
          message: undefined,
          error: undefined,
          progress: 0,
        });

        // Advance through all 10 increments (300ms each)
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(300);
        }

        await promise;

        // 1 initial + 10 progress + 1 done = 12 calls
        expect(calls).toHaveLength(12);
        expect(calls[calls.length - 1]).toEqual({
          id: "agent",
          status: "done",
          message: undefined,
          error: undefined,
          progress: undefined,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("update (inactive)", () => {
    it("start hook opens nothing when debug.update is off", async () => {
      const { ui, notifications } = createMockNotificationManager();
      const module = createDebugModule({
        configService: createMockConfig(),
        ui,
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "start");
      await hook.handler(makeHookContext());
      expect(notifications).toHaveLength(0);
    });
  });

  describe("update (active)", () => {
    it("start hook opens 'Update available' notification when debug.update is 'pending'", async () => {
      const { ui, notifications } = createMockNotificationManager();
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.update": "pending" } }),
        ui,
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "start");
      await hook.handler(makeHookContext());

      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.opened.title).toBe("Update available");
      expect(notifications[0]!.opened.actions).toEqual([{ id: "install", label: "Install" }]);
    });

    it("bare flag value 'true' behaves like 'pending'", async () => {
      const { ui, notifications } = createMockNotificationManager();
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.update": "true" } }),
        ui,
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "start");
      await hook.handler(makeHookContext());

      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.opened.title).toBe("Update available");
    });

    it("start hook opens 'Update ready' notification when debug.update is 'downloaded'", async () => {
      const { ui, notifications } = createMockNotificationManager();
      const module = createDebugModule({
        configService: createMockConfig({ defaults: { "debug.update": "downloaded" } }),
        ui,
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "start");
      await hook.handler(makeHookContext());

      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.opened.title).toBe("Update ready");
      expect(notifications[0]!.opened.actions).toEqual([{ id: "restart", label: "Restart Now" }]);
    });

    it("clicking Install transitions to downloading then ready", async () => {
      vi.useFakeTimers();
      try {
        const { ui, notifications, emitEvent } = createMockNotificationManager();
        const module = createDebugModule({
          configService: createMockConfig({ defaults: { "debug.update": "pending" } }),
          ui,
        });
        const hook = getHook(module, APP_START_OPERATION_ID, "start");
        await hook.handler(makeHookContext());

        emitEvent(0, { actionId: "install" });

        // 20 increments of 150ms
        for (let i = 0; i < 20; i++) {
          await vi.advanceTimersByTimeAsync(150);
        }
        await vi.runAllTimersAsync();

        const slot = notifications[0]!;
        expect(slot.updates.length).toBeGreaterThan(0);
        const last = slot.updates[slot.updates.length - 1]!;
        expect(last.title).toBe("Update ready");
        expect(last.actions).toEqual([{ id: "restart", label: "Restart Now" }]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("combined setup + update", () => {
    it("check-deps returns missingBinaries when debug.setup is on", async () => {
      const module = createDebugModule({
        configService: createMockConfig({
          defaults: { "debug.setup": true, "debug.update": "pending" },
        }),
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result.missingBinaries).toEqual(["claude"]);
    });
  });
});
