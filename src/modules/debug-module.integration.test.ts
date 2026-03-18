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
import type { Config } from "../boundaries/platform/config";
import type { CheckDepsResult } from "../intents/app-start";
import type { SetupProgressReporter } from "../intents/setup";
import type { UpdateDownloadResult } from "../intents/update-apply";
import type { DeleteHookResult, DetectHookResult } from "../intents/delete-workspace";
import { DELETE_WORKSPACE_OPERATION_ID } from "../intents/delete-workspace";
import { RESOLVE_WORKSPACE_OPERATION_ID } from "../intents/resolve-workspace";
import type { ResolveHookResult } from "../intents/resolve-workspace";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { SETUP_OPERATION_ID } from "../intents/setup";
import { UPDATE_APPLY_OPERATION_ID } from "../intents/update-apply";

// =============================================================================
// Mock Config
// =============================================================================

function createMockConfig(values?: Record<string, unknown>): Config {
  const store = new Map<string, unknown>(Object.entries(values ?? {}));
  return {
    register: () => {},
    load: () => {},
    get: (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    getDefinitions: () => new Map(),
    getEffective: () => Object.fromEntries(store),
    getHelpText: () => "",
  };
}

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
      config.register = (key: string) => {
        registered.push(key);
      };
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
      } as unknown as HookContext;
    }

    it("delete hook returns simulated error and captures workspace identity", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ "debug.blocking-pids": true }),
      });
      const hook = getHook(module, DELETE_WORKSPACE_OPERATION_ID, "delete");
      const result = (await hook.handler(
        makeDeleteCtx("/projects/my-app/workspaces/test-1", "/projects/my-app")
      )) as DeleteHookResult;
      expect(result.error).toBe("Debug: simulated file lock");
    });

    it("detect hook returns fake blocking processes", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ "debug.blocking-pids": true }),
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
        configService: createMockConfig({ "debug.blocking-pids": true }),
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
        configService: createMockConfig({ "debug.blocking-pids": true }),
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
        configService: createMockConfig({ "debug.setup": true }),
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result.missingBinaries).toEqual(["claude"]);
    });

    it("binary hook calls report with progress increments", async () => {
      vi.useFakeTimers();
      try {
        const module = createDebugModule({
          configService: createMockConfig({ "debug.setup": true }),
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
    it("check-deps returns empty object", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result).toEqual({});
    });

    it("download hook returns empty object without dialogManager", async () => {
      const module = createDebugModule({ configService: createMockConfig() });
      const hook = getHook(module, UPDATE_APPLY_OPERATION_ID, "download");
      const result = (await hook.handler(makeHookContext())) as UpdateDownloadResult;
      expect(result).toEqual({});
    });
  });

  describe("update (active)", () => {
    it("check-deps returns updateNeedsChoice", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ "debug.update": true }),
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result.updateNeedsChoice).toBe(true);
    });

    it("download hook opens dialog, simulates progress, and returns cancelled", async () => {
      vi.useFakeTimers();
      try {
        const updateCalls: unknown[] = [];
        const mockHandle = {
          id: "dlg-test",
          update: vi.fn((config: unknown) => updateCalls.push(config)),
          close: vi.fn(),
          onEvent: vi.fn(() => () => {}),
          nextEvent: vi.fn(),
          closed: new Promise<void>(() => {}),
        };
        const mockDialogManager = { open: vi.fn(() => mockHandle) };
        const module = createDebugModule({
          configService: createMockConfig({ "debug.update": true }),
          dialogManager: mockDialogManager as never,
        });
        const hook = getHook(module, UPDATE_APPLY_OPERATION_ID, "download");

        const promise = hook.handler(makeHookContext());

        // Dialog should be opened
        expect(mockDialogManager.open).toHaveBeenCalledTimes(1);

        // Advance through all 20 increments (150ms each, 5% to 100%)
        for (let i = 0; i < 20; i++) {
          await vi.advanceTimersByTimeAsync(150);
        }

        const result = (await promise) as UpdateDownloadResult;

        // Should have updated dialog with progress increments
        expect(updateCalls.length).toBeGreaterThan(0);
        expect(mockHandle.close).toHaveBeenCalled();
        expect(result).toEqual({ cancelled: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("combined setup + update", () => {
    it("check-deps returns both missingBinaries and updateNeedsChoice", async () => {
      const module = createDebugModule({
        configService: createMockConfig({ "debug.setup": true, "debug.update": true }),
      });
      const hook = getHook(module, APP_START_OPERATION_ID, "check-deps");
      const result = (await hook.handler(makeHookContext())) as CheckDepsResult;
      expect(result.missingBinaries).toEqual(["claude"]);
      expect(result.updateNeedsChoice).toBe(true);
    });
  });
});
