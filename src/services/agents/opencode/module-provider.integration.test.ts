// @vitest-environment node
/**
 * Integration tests for OpenCode module provider.
 *
 * Tests the createOpenCodeModuleProvider factory and resulting AgentModuleProvider
 * implementation. Validates provider lifecycle, status tracking, workspace management,
 * and OpenCode-specific behaviors like pendingPrompt handling and getEffectiveCounts().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenCodeModuleProvider, type OpenCodeModuleProviderDeps } from "./module-provider";
import type { AgentModuleProvider } from "../agent-module-provider";
import type { AggregatedAgentStatus, WorkspacePath } from "../../../shared/ipc";
import type { AgentBinaryManager } from "../../binary-download";
import type { OpenCodeServerManager } from "./server-manager";
import { SILENT_LOGGER } from "../../logging";

// =============================================================================
// Mock OpenCodeProvider via vi.mock + vi.hoisted
// =============================================================================

const {
  MockOpenCodeProvider,
  getLatestMockProvider,
  getCapturedStatusCallback,
  resetMockState,
  setNextInstanceOverrides,
} = vi.hoisted(() => {
  // Shared mutable state for the hoisted mock
  let statusCallback: ((status: string) => void) | null = null;
  let mockProvider: InstanceType<typeof MockOpenCodeProvider> | null = null;

  function setProvider(instance: InstanceType<typeof MockOpenCodeProvider>): void {
    mockProvider = instance;
  }

  /**
   * Per-method overrides applied to the next constructed instance.
   * Cleared after use.
   */
  let nextOverrides: Record<string, ReturnType<typeof vi.fn>> | null = null;

  class MockOpenCodeProvider {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    reconnect = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    onStatusChange = vi.fn((cb: (status: string) => void) => {
      statusCallback = cb;
      return vi.fn();
    });
    getSession = vi.fn().mockReturnValue({ port: 8080, sessionId: "s1" });
    getEnvironmentVariables = vi.fn().mockReturnValue({ _CH_OPENCODE_PORT: "8080" });
    markActive = vi.fn();
    fetchStatus = vi.fn().mockResolvedValue(undefined);
    setBridgePort = vi.fn();
    getEffectiveCounts = vi.fn().mockReturnValue({ idle: 0, busy: 0 });
    createSession = vi.fn().mockResolvedValue({ ok: true, value: { id: "session-1" } });
    sendPrompt = vi.fn().mockResolvedValue({ ok: true, value: {} });

    constructor() {
      statusCallback = null;
      setProvider(this);

      // Apply any overrides queued for the next instance
      if (nextOverrides) {
        for (const [key, fn] of Object.entries(nextOverrides)) {
          (this as Record<string, unknown>)[key] = fn;
        }
        nextOverrides = null;
      }
    }
  }

  return {
    MockOpenCodeProvider,
    getLatestMockProvider: () => mockProvider!,
    getCapturedStatusCallback: () => statusCallback,
    resetMockState: () => {
      statusCallback = null;
      mockProvider = null;
      nextOverrides = null;
    },
    setNextInstanceOverrides: (overrides: Record<string, ReturnType<typeof vi.fn>>) => {
      nextOverrides = overrides;
    },
  };
});

vi.mock("./provider", () => ({
  OpenCodeProvider: MockOpenCodeProvider,
}));

// =============================================================================
// Helpers
// =============================================================================

const WS_PATH = "/workspace/feature-a" as WorkspacePath;
const WS_PATH_B = "/workspace/feature-b" as WorkspacePath;

type ServerStartedHandler = (workspacePath: string, port: number, pendingPrompt: unknown) => void;
type ServerStoppedHandler = (workspacePath: string, isRestart: boolean) => void;

/**
 * Create a mock OpenCodeServerManager with vi.fn() stubs.
 */
function createMockServerManager(): OpenCodeServerManager & {
  _triggerStarted: ServerStartedHandler;
  _triggerStopped: ServerStoppedHandler;
} {
  let startedHandler: ServerStartedHandler | null = null;
  let stoppedHandler: ServerStoppedHandler | null = null;

  return {
    startServer: vi.fn().mockResolvedValue(8080),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true, port: 8080 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setMcpConfig: vi.fn(),
    setMarkActiveHandler: vi.fn(),
    getBridgePort: vi.fn().mockReturnValue(9090),
    onServerStarted: vi.fn((cb: ServerStartedHandler) => {
      startedHandler = cb;
      return vi.fn();
    }),
    onServerStopped: vi.fn((cb: ServerStoppedHandler) => {
      stoppedHandler = cb;
      return vi.fn();
    }),
    _triggerStarted(workspacePath: string, port: number, pendingPrompt: unknown) {
      startedHandler?.(workspacePath, port, pendingPrompt);
    },
    _triggerStopped(workspacePath: string, isRestart: boolean) {
      stoppedHandler?.(workspacePath, isRestart);
    },
  } as unknown as OpenCodeServerManager & {
    _triggerStarted: ServerStartedHandler;
    _triggerStopped: ServerStoppedHandler;
  };
}

/**
 * Create a mock AgentBinaryManager.
 */
function createMockBinaryManager(): AgentBinaryManager {
  return {
    getBinaryType: vi.fn().mockReturnValue("opencode"),
    preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
    downloadBinary: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentBinaryManager;
}

/**
 * Initialize the provider and trigger a server-started event so a mock
 * provider is created and registered. Returns the mock provider instance.
 */
async function initializeAndStart(
  moduleProvider: AgentModuleProvider,
  serverManager: ReturnType<typeof createMockServerManager>,
  workspacePath: WorkspacePath = WS_PATH,
  port = 8080,
  pendingPrompt?: unknown
): Promise<InstanceType<typeof MockOpenCodeProvider>> {
  moduleProvider.initialize(null);
  serverManager._triggerStarted(workspacePath, port, pendingPrompt);
  // Wait for the full handleServerStarted chain to settle.
  // addProvider is called after connect+fetchStatus+setBridgePort, and it calls onStatusChange.
  await vi.waitFor(() => {
    expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
  });
  // Give remaining microtasks (pendingPrompt handling) time to settle
  await new Promise((r) => setTimeout(r, 0));
  return getLatestMockProvider();
}

// =============================================================================
// Tests
// =============================================================================

describe("OpenCode module provider", () => {
  let serverManager: ReturnType<typeof createMockServerManager>;
  let binaryManager: AgentBinaryManager;
  let provider: AgentModuleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockState();

    serverManager = createMockServerManager();
    binaryManager = createMockBinaryManager();

    const deps: OpenCodeModuleProviderDeps = {
      serverManager: serverManager as unknown as OpenCodeServerManager,
      binaryManager,
      logger: SILENT_LOGGER,
    };
    provider = createOpenCodeModuleProvider(deps);
  });

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  describe("identity constants", () => {
    it("has correct type", () => {
      expect(provider.type).toBe("opencode");
    });

    it("has correct configKey", () => {
      expect(provider.configKey).toBe("version.opencode");
    });

    it("has correct displayName", () => {
      expect(provider.displayName).toBe("OpenCode");
    });

    it("has correct icon", () => {
      expect(provider.icon).toBe("terminal");
    });

    it("has correct serverName", () => {
      expect(provider.serverName).toBe("OpenCode");
    });

    it("has correct scripts", () => {
      expect(provider.scripts).toEqual(["ch-opencode", "ch-opencode.cjs", "ch-opencode.cmd"]);
    });

    it("has correct binaryType", () => {
      expect(provider.binaryType).toBe("opencode");
    });
  });

  // ---------------------------------------------------------------------------
  // Config definition
  // ---------------------------------------------------------------------------

  describe("getConfigDefinition", () => {
    it("returns config definition for version.opencode", () => {
      const def = provider.getConfigDefinition();
      expect(def.name).toBe("version.opencode");
      expect(def.default).toBeNull();
      expect(def.description).toBe("OpenCode agent version override");
    });
  });

  // ---------------------------------------------------------------------------
  // Preflight
  // ---------------------------------------------------------------------------

  describe("preflight", () => {
    it("returns success and needsDownload from binary manager", async () => {
      const result = await provider.preflight();
      expect(result).toEqual({ success: true, needsDownload: false });
    });

    it("returns success false when binary manager fails", async () => {
      vi.mocked(binaryManager.preflight).mockResolvedValueOnce({
        success: false,
        error: { type: "not-found", message: "Binary not found" },
      });
      const result = await provider.preflight();
      expect(result).toEqual({ success: false, needsDownload: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  describe("initialize", () => {
    it("wires server callbacks", () => {
      provider.initialize(null);
      expect(serverManager.onServerStarted).toHaveBeenCalledOnce();
      expect(serverManager.onServerStopped).toHaveBeenCalledOnce();
      expect(serverManager.setMarkActiveHandler).toHaveBeenCalledOnce();
    });

    it("sets MCP config when provided", () => {
      provider.initialize({ port: 5555 });
      expect(serverManager.setMcpConfig).toHaveBeenCalledWith({ port: 5555 });
    });

    it("does not set MCP config when null", () => {
      provider.initialize(null);
      expect(serverManager.setMcpConfig).not.toHaveBeenCalled();
    });

    it("wires callbacks only once on repeated calls", () => {
      provider.initialize(null);
      provider.initialize(null);
      expect(serverManager.onServerStarted).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // handleServerStarted - basic provider creation
  // ---------------------------------------------------------------------------

  describe("handleServerStarted", () => {
    it("creates provider, connects, fetches status, and sets bridge port", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);

      expect(mockProv.connect).toHaveBeenCalledWith(8080);
      expect(mockProv.fetchStatus).toHaveBeenCalledOnce();
      expect(mockProv.setBridgePort).toHaveBeenCalledWith(9090);
    });

    it("does not set bridge port when getBridgePort returns null", async () => {
      vi.mocked(serverManager.getBridgePort).mockReturnValue(null);
      const mockProv = await initializeAndStart(provider, serverManager);

      expect(mockProv.setBridgePort).not.toHaveBeenCalled();
    });

    it("registers onStatusChange listener on new provider", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);
      expect(mockProv.onStatusChange).toHaveBeenCalledOnce();
    });

    it("does not create duplicate provider for same workspace", async () => {
      const firstProvider = await initializeAndStart(provider, serverManager);

      // Trigger again for same path - should reconnect, not create new
      serverManager._triggerStarted(WS_PATH, 8081, undefined);
      await vi.waitFor(() => {
        expect(firstProvider.reconnect).toHaveBeenCalled();
      });

      // Should be the same provider (reconnect on existing, not a new MockOpenCodeProvider)
      expect(firstProvider.reconnect).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // handleServerStarted - pendingPrompt handling
  // ---------------------------------------------------------------------------

  describe("pendingPrompt handling", () => {
    it("sends prompt when pendingPrompt is provided", async () => {
      const pendingPrompt = { prompt: "hello world" };
      const mockProv = await initializeAndStart(
        provider,
        serverManager,
        WS_PATH,
        8080,
        pendingPrompt
      );

      expect(mockProv.createSession).toHaveBeenCalledOnce();
      expect(mockProv.sendPrompt).toHaveBeenCalledWith("session-1", "hello world", {});
    });

    it("sends prompt with agent and model options", async () => {
      const pendingPrompt = {
        prompt: "code review",
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-4" },
      };
      const mockProv = await initializeAndStart(
        provider,
        serverManager,
        WS_PATH,
        8080,
        pendingPrompt
      );

      expect(mockProv.sendPrompt).toHaveBeenCalledWith("session-1", "code review", {
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-4" },
      });
    });

    it("does not send prompt when pendingPrompt is undefined", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);

      expect(mockProv.createSession).not.toHaveBeenCalled();
      expect(mockProv.sendPrompt).not.toHaveBeenCalled();
    });

    it("logs error when createSession fails", async () => {
      const pendingPrompt = { prompt: "hello" };
      const createSessionMock = vi.fn().mockResolvedValue({
        ok: false,
        error: { message: "session creation failed" },
      });

      setNextInstanceOverrides({ createSession: createSessionMock });

      const mockProv = await initializeAndStart(
        provider,
        serverManager,
        WS_PATH,
        8080,
        pendingPrompt
      );

      expect(createSessionMock).toHaveBeenCalledOnce();
      expect(mockProv.sendPrompt).not.toHaveBeenCalled();
    });

    it("logs error when sendPrompt fails", async () => {
      const pendingPrompt = { prompt: "hello" };
      const sendPromptMock = vi.fn().mockResolvedValue({
        ok: false,
        error: { message: "send failed" },
      });

      setNextInstanceOverrides({ sendPrompt: sendPromptMock });

      const mockProv = await initializeAndStart(
        provider,
        serverManager,
        WS_PATH,
        8080,
        pendingPrompt
      );

      expect(mockProv.createSession).toHaveBeenCalledOnce();
      expect(sendPromptMock).toHaveBeenCalledOnce();
      // sendPrompt returned error - provider should not throw
    });
  });

  // ---------------------------------------------------------------------------
  // Status tracking via getEffectiveCounts
  // ---------------------------------------------------------------------------

  describe("status via getEffectiveCounts", () => {
    it("reports none when counts are both zero on addProvider", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);
      mockProv.getEffectiveCounts.mockReturnValue({ idle: 0, busy: 0 });

      // The status is set during addProvider which already ran
      const status = provider.getStatus(WS_PATH);
      expect(status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });

    it("reports idle when idle count is positive on addProvider", async () => {
      setNextInstanceOverrides({
        getEffectiveCounts: vi.fn().mockReturnValue({ idle: 1, busy: 0 }),
      });

      await initializeAndStart(provider, serverManager);

      const status = provider.getStatus(WS_PATH);
      expect(status).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
    });

    it("reports busy when busy count is positive on addProvider", async () => {
      setNextInstanceOverrides({
        getEffectiveCounts: vi.fn().mockReturnValue({ idle: 0, busy: 1 }),
      });

      await initializeAndStart(provider, serverManager);

      const status = provider.getStatus(WS_PATH);
      expect(status).toEqual({ status: "busy", counts: { idle: 0, busy: 1 } });
    });

    it("reports status change via onStatusChange callback", async () => {
      const statusChanges: Array<{ path: WorkspacePath; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((path, status) => {
        statusChanges.push({ path, status });
      });

      await initializeAndStart(provider, serverManager);

      // Simulate a status change from the provider
      expect(getCapturedStatusCallback()).not.toBeNull();
      getCapturedStatusCallback()!("busy");

      const busyChange = statusChanges.find((c) => c.status.status === "busy");
      expect(busyChange).toBeDefined();
      expect(busyChange!.path).toBe(WS_PATH);
      expect(busyChange!.status).toEqual({ status: "busy", counts: { idle: 0, busy: 1 } });
    });

    it("deduplicates identical status updates", async () => {
      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_path, status) => {
        statusChanges.push(status);
      });

      await initializeAndStart(provider, serverManager);

      // Fire the same status twice
      getCapturedStatusCallback()!("none");
      getCapturedStatusCallback()!("none");

      // Should not have added more than one "none" beyond initial
      const noneCount = statusChanges.filter((s) => s.status === "none").length;
      // At most 1 "none" notification total (from addProvider)
      expect(noneCount).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Status on reconnect
  // ---------------------------------------------------------------------------

  describe("reconnect status uses getEffectiveCounts", () => {
    it("reports status from getEffectiveCounts after reconnect", async () => {
      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_path, status) => {
        statusChanges.push(status);
      });

      const mockProv = await initializeAndStart(provider, serverManager);

      // Simulate server restart: stop (disconnect) then start (reconnect)
      serverManager._triggerStopped(WS_PATH, true);

      // Provider should be disconnected
      expect(mockProv.disconnect).toHaveBeenCalledOnce();

      // Now simulate restart completion - triggers reconnect on existing provider
      mockProv.getEffectiveCounts.mockReturnValue({ idle: 1, busy: 0 });
      serverManager._triggerStarted(WS_PATH, 8080, undefined);

      await vi.waitFor(() => {
        expect(mockProv.reconnect).toHaveBeenCalled();
      });

      const lastStatus = statusChanges[statusChanges.length - 1];
      expect(lastStatus).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
    });
  });

  // ---------------------------------------------------------------------------
  // startWorkspace
  // ---------------------------------------------------------------------------

  describe("startWorkspace", () => {
    it("passes initialPrompt to startServer options", async () => {
      provider.initialize(null);

      const initialPrompt = { prompt: "build feature X", agent: "coder" };
      // startServer will trigger the callback
      vi.mocked(serverManager.startServer).mockImplementation(async () => {
        serverManager._triggerStarted(WS_PATH, 8080, undefined);
        return 8080;
      });

      await provider.startWorkspace(WS_PATH, { initialPrompt });

      expect(serverManager.startServer).toHaveBeenCalledWith(WS_PATH, {
        initialPrompt,
      });
    });

    it("calls startServer without options when no initialPrompt", async () => {
      provider.initialize(null);

      vi.mocked(serverManager.startServer).mockImplementation(async () => {
        serverManager._triggerStarted(WS_PATH, 8080, undefined);
        return 8080;
      });

      await provider.startWorkspace(WS_PATH);

      expect(serverManager.startServer).toHaveBeenCalledWith(WS_PATH);
    });

    it("returns environment variables from provider", async () => {
      provider.initialize(null);

      vi.mocked(serverManager.startServer).mockImplementation(async () => {
        serverManager._triggerStarted(WS_PATH, 8080, undefined);
        return 8080;
      });

      const result = await provider.startWorkspace(WS_PATH);

      expect(result.envVars).toEqual({ _CH_OPENCODE_PORT: "8080" });
    });

    it("returns empty envVars when no provider available", async () => {
      provider.initialize(null);

      // startServer does not trigger callback
      vi.mocked(serverManager.startServer).mockResolvedValue(8080);

      const result = await provider.startWorkspace(WS_PATH);

      expect(result.envVars).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // stopWorkspace / restartWorkspace
  // ---------------------------------------------------------------------------

  describe("stopWorkspace", () => {
    it("delegates to serverManager.stopServer", async () => {
      const result = await provider.stopWorkspace(WS_PATH);
      expect(serverManager.stopServer).toHaveBeenCalledWith(WS_PATH);
      expect(result).toEqual({ success: true });
    });
  });

  describe("restartWorkspace", () => {
    it("delegates to serverManager.restartServer", async () => {
      const result = await provider.restartWorkspace(WS_PATH);
      expect(serverManager.restartServer).toHaveBeenCalledWith(WS_PATH);
      expect(result).toEqual({ success: true, port: 8080 });
    });
  });

  // ---------------------------------------------------------------------------
  // Server stopped handling
  // ---------------------------------------------------------------------------

  describe("server stopped", () => {
    it("disconnects provider on restart stop", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);

      serverManager._triggerStopped(WS_PATH, true);

      expect(mockProv.disconnect).toHaveBeenCalledOnce();
      expect(mockProv.dispose).not.toHaveBeenCalled();
    });

    it("removes and disposes provider on full stop", async () => {
      const mockProv = await initializeAndStart(provider, serverManager);

      serverManager._triggerStopped(WS_PATH, false);

      expect(mockProv.dispose).toHaveBeenCalledOnce();
    });

    it("emits none status on full stop", async () => {
      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_path, status) => {
        statusChanges.push(status);
      });

      await initializeAndStart(provider, serverManager);
      serverManager._triggerStopped(WS_PATH, false);

      const lastStatus = statusChanges[statusChanges.length - 1];
      expect(lastStatus).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });
  });

  // ---------------------------------------------------------------------------
  // getStatus / getSession
  // ---------------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns none for unknown workspace", () => {
      const status = provider.getStatus(WS_PATH);
      expect(status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });
  });

  describe("getSession", () => {
    it("returns session info from provider", async () => {
      await initializeAndStart(provider, serverManager);

      const session = provider.getSession(WS_PATH);
      expect(session).toEqual({ port: 8080, sessionId: "s1" });
    });

    it("returns null for unknown workspace", () => {
      const session = provider.getSession(WS_PATH);
      expect(session).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // onStatusChange
  // ---------------------------------------------------------------------------

  describe("onStatusChange", () => {
    it("returns unsubscribe function that stops notifications", async () => {
      const changes: AggregatedAgentStatus[] = [];
      const unsubscribe = provider.onStatusChange((_path, status) => {
        changes.push(status);
      });

      await initializeAndStart(provider, serverManager);
      const countAfterInit = changes.length;

      unsubscribe();

      // Fire a status change after unsubscribe
      getCapturedStatusCallback()!("busy");
      expect(changes.length).toBe(countAfterInit);
    });
  });

  // ---------------------------------------------------------------------------
  // markActive / tuiAttachedWorkspaces
  // ---------------------------------------------------------------------------

  describe("markActive", () => {
    it("calls markActive on provider when markActiveHandler fires", async () => {
      provider.initialize(null);

      // Capture the handler passed to setMarkActiveHandler
      const markActiveHandler = vi.mocked(serverManager.setMarkActiveHandler).mock.calls[0]![0];

      await initializeAndStart(provider, serverManager);

      markActiveHandler(WS_PATH);
      expect(getLatestMockProvider().markActive).toHaveBeenCalled();
    });

    it("marks provider active if workspace was already attached before provider creation", async () => {
      provider.initialize(null);

      // Mark active before provider exists
      const markActiveHandler = vi.mocked(serverManager.setMarkActiveHandler).mock.calls[0]![0];
      markActiveHandler(WS_PATH);

      // Now create the provider - should be marked active immediately in addProvider
      serverManager._triggerStarted(WS_PATH, 8080, undefined);
      await vi.waitFor(() => {
        expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
      });

      expect(getLatestMockProvider().markActive).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clearWorkspaceTracking
  // ---------------------------------------------------------------------------

  describe("clearWorkspaceTracking", () => {
    it("removes workspace from tuiAttachedWorkspaces", async () => {
      provider.initialize(null);

      // Mark active
      const markActiveHandler = vi.mocked(serverManager.setMarkActiveHandler).mock.calls[0]![0];
      markActiveHandler(WS_PATH);

      // Clear tracking
      provider.clearWorkspaceTracking(WS_PATH);

      // Now create a provider - should NOT be marked active
      serverManager._triggerStarted(WS_PATH, 8080, undefined);
      await vi.waitFor(() => {
        expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
      });

      expect(getLatestMockProvider().markActive).not.toHaveBeenCalled();
    });

    it("does not affect other workspace tracking", async () => {
      provider.initialize(null);

      const markActiveHandler = vi.mocked(serverManager.setMarkActiveHandler).mock.calls[0]![0];
      markActiveHandler(WS_PATH);
      markActiveHandler(WS_PATH_B);

      // Clear only WS_PATH
      provider.clearWorkspaceTracking(WS_PATH);

      // Start WS_PATH_B - should still be marked active
      serverManager._triggerStarted(WS_PATH_B, 8081, undefined);
      await vi.waitFor(() => {
        expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
      });

      expect(getLatestMockProvider().markActive).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  describe("dispose", () => {
    it("disposes all providers and server manager", async () => {
      await initializeAndStart(provider, serverManager);
      const mockProv = getLatestMockProvider();

      await provider.dispose();

      expect(mockProv.dispose).toHaveBeenCalledOnce();
      expect(serverManager.dispose).toHaveBeenCalledOnce();
    });

    it("clears all internal state", async () => {
      await initializeAndStart(provider, serverManager);

      await provider.dispose();

      // After dispose, getStatus returns none
      const status = provider.getStatus(WS_PATH);
      expect(status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });

      // After dispose, getSession returns null
      const session = provider.getSession(WS_PATH);
      expect(session).toBeNull();
    });

    it("allows re-initialization after dispose", async () => {
      await initializeAndStart(provider, serverManager);
      await provider.dispose();

      // Re-initialize should wire callbacks again
      provider.initialize(null);
      expect(serverManager.onServerStarted).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple workspaces
  // ---------------------------------------------------------------------------

  describe("multiple workspaces", () => {
    it("tracks status independently per workspace", async () => {
      provider.initialize(null);

      // Start workspace A
      serverManager._triggerStarted(WS_PATH, 8080, undefined);
      await vi.waitFor(() => {
        expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
      });
      const provA = getLatestMockProvider();
      // Capture A's status callback (set during addProvider's provider.onStatusChange call)
      const callbackA = getCapturedStatusCallback()!;
      expect(callbackA).not.toBeNull();

      // Start workspace B
      serverManager._triggerStarted(WS_PATH_B, 8081, undefined);
      await vi.waitFor(() => {
        // Wait for B's onStatusChange (different instance than A)
        expect(getLatestMockProvider()).not.toBe(provA);
        expect(getLatestMockProvider().onStatusChange).toHaveBeenCalled();
      });

      // Change A to busy via the captured callback
      callbackA("busy");

      const statusA = provider.getStatus(WS_PATH);
      const statusB = provider.getStatus(WS_PATH_B);

      expect(statusA.status).toBe("busy");
      expect(statusB.status).toBe("none"); // B has default getEffectiveCounts: {idle:0, busy:0}
    });
  });

  // ---------------------------------------------------------------------------
  // downloadBinary
  // ---------------------------------------------------------------------------

  describe("downloadBinary", () => {
    it("delegates to binaryManager.downloadBinary", async () => {
      const onProgress = vi.fn();
      await provider.downloadBinary(onProgress);
      expect(binaryManager.downloadBinary).toHaveBeenCalledWith(onProgress);
    });
  });
});
