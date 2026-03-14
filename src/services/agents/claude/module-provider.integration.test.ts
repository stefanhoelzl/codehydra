// @vitest-environment node
/**
 * Integration tests for createClaudeModuleProvider.
 *
 * Tests the AgentModuleProvider implementation for Claude Code:
 * - Server callback wiring and MCP config initialization
 * - Provider lifecycle (create, connect, reconnect, dispose)
 * - Status tracking and deduplication
 * - Per-workspace operations (start, stop, restart)
 * - Query methods (getStatus, getSession)
 * - Cleanup and disposal
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClaudeModuleProvider } from "./module-provider";
import type { ClaudeCodeServerManager } from "./server-manager";
import type { AgentBinaryManager } from "../../binary-download";
import type { AgentProvider, AgentStatus } from "../types";
import type { AggregatedAgentStatus, WorkspacePath } from "../../../shared/ipc";
import { SILENT_LOGGER } from "../../logging";

// =============================================================================
// Mock ClaudeCodeProvider via vi.mock
// =============================================================================

/** Captured status callback from the latest mock provider's onStatusChange. */
let capturedStatusCallback: ((status: AgentStatus) => void) | null = null;

/** Reference to the latest mock provider instance for assertions. */
let latestMockProvider: AgentProvider;

vi.mock("./provider", () => ({
  ClaudeCodeProvider: class MockClaudeCodeProvider {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    reconnect = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    onStatusChange = vi.fn((cb: (status: AgentStatus) => void) => {
      capturedStatusCallback = cb;
      return vi.fn();
    });
    getSession = vi.fn().mockReturnValue({ port: 8080, sessionId: "s1" });
    getEnvironmentVariables = vi.fn().mockReturnValue({ CLAUDE_PORT: "8080" });
    markActive = vi.fn();
    constructor() {
      capturedStatusCallback = null;
      latestMockProvider = this as unknown as AgentProvider;
    }
  },
}));

// =============================================================================
// Mock factories
// =============================================================================

function createMockServerManager(): ClaudeCodeServerManager {
  return {
    startServer: vi.fn().mockResolvedValue(8080),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true, port: 8080 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setMcpConfig: vi.fn(),
    setMarkActiveHandler: vi.fn(),
    setInitialPrompt: vi.fn().mockResolvedValue(undefined),
    setNoSessionMarker: vi.fn().mockResolvedValue(undefined),
    onServerStarted: vi.fn().mockReturnValue(vi.fn()),
    onServerStopped: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as ClaudeCodeServerManager;
}

function createMockBinaryManager(): AgentBinaryManager {
  return {
    preflight: vi.fn().mockResolvedValue({ success: true, needsDownload: false }),
    downloadBinary: vi.fn().mockResolvedValue(undefined),
    getBinaryType: vi.fn().mockReturnValue("claude"),
  } as unknown as AgentBinaryManager;
}

const WS_PATH = "/workspace/feature-a" as WorkspacePath;
const WS_PATH_B = "/workspace/feature-b" as WorkspacePath;

// =============================================================================
// Tests
// =============================================================================

describe("createClaudeModuleProvider", () => {
  let mockServerManager: ClaudeCodeServerManager;
  let mockBinaryManager: AgentBinaryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedStatusCallback = null;
    mockServerManager = createMockServerManager();
    mockBinaryManager = createMockBinaryManager();
  });

  function createProvider() {
    return createClaudeModuleProvider({
      serverManager: mockServerManager,
      binaryManager: mockBinaryManager,
      logger: SILENT_LOGGER,
    });
  }

  // ---------------------------------------------------------------------------
  // Identity constants
  // ---------------------------------------------------------------------------

  describe("identity", () => {
    it("returns correct type, configKey, displayName, icon, and serverName", () => {
      const provider = createProvider();

      expect(provider.type).toBe("claude");
      expect(provider.configKey).toBe("version.claude");
      expect(provider.displayName).toBe("Claude Code");
      expect(provider.icon).toBe("sparkle");
      expect(provider.serverName).toBe("Claude Code hook");
    });

    it("returns expected scripts list", () => {
      const provider = createProvider();

      expect(provider.scripts).toEqual([
        "ch-claude",
        "ch-claude.cjs",
        "ch-claude.cmd",
        "claude-code-hook-handler.cjs",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Binary delegation
  // ---------------------------------------------------------------------------

  describe("binary management", () => {
    it("binaryType delegates to binaryManager.getBinaryType()", () => {
      const provider = createProvider();

      expect(provider.binaryType).toBe("claude");
      expect(
        (mockBinaryManager as unknown as { getBinaryType: ReturnType<typeof vi.fn> }).getBinaryType
      ).toHaveBeenCalled();
    });

    it("preflight delegates to binaryManager", async () => {
      const provider = createProvider();
      const result = await provider.preflight();

      expect(result).toEqual({ success: true, needsDownload: false });
      expect(mockBinaryManager.preflight).toHaveBeenCalled();
    });

    it("preflight returns needsDownload: false on failure", async () => {
      (mockBinaryManager.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
      });
      const provider = createProvider();
      const result = await provider.preflight();

      expect(result).toEqual({ success: false, needsDownload: false });
    });

    it("downloadBinary delegates to binaryManager", async () => {
      const provider = createProvider();
      const onProgress = vi.fn();
      await provider.downloadBinary(onProgress);

      expect(mockBinaryManager.downloadBinary).toHaveBeenCalledWith(onProgress);
    });
  });

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  describe("getConfigDefinition", () => {
    it("returns config definition with correct name and default", () => {
      const provider = createProvider();
      const config = provider.getConfigDefinition();

      expect(config.name).toBe("version.claude");
      expect(config.default).toBeNull();
      expect(config.description).toBe("Claude agent version override");
    });
  });

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  describe("initialize", () => {
    it("wires server callbacks and sets MCP config", () => {
      const provider = createProvider();

      provider.initialize({ port: 9999 });

      expect(mockServerManager.setMarkActiveHandler).toHaveBeenCalled();
      expect(mockServerManager.onServerStarted).toHaveBeenCalled();
      expect(mockServerManager.onServerStopped).toHaveBeenCalled();
      expect(mockServerManager.setMcpConfig).toHaveBeenCalledWith({ port: 9999 });
    });

    it("does not set MCP config when null", () => {
      const provider = createProvider();

      provider.initialize(null);

      expect(mockServerManager.setMarkActiveHandler).toHaveBeenCalled();
      expect(mockServerManager.onServerStarted).toHaveBeenCalled();
      expect(mockServerManager.onServerStopped).toHaveBeenCalled();
      expect(mockServerManager.setMcpConfig).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Server started -> provider creation
  // ---------------------------------------------------------------------------

  describe("server started callback", () => {
    it("creates provider on server started, connects it, and emits initial status", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      // Get the captured onServerStarted callback
      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;

      // Simulate server started
      await onStartedCb(WS_PATH, 8080);

      // Provider should have been created and connected
      expect(latestMockProvider.connect).toHaveBeenCalledWith(8080);

      // Initial status should be emitted (none, since addProvider calls handleStatusUpdate with "none")
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });

    it("reconnects existing provider on restart (server started again)", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;

      // First start: creates provider
      await onStartedCb(WS_PATH, 8080);
      const firstProvider = latestMockProvider;

      // Second start (restart): should reconnect existing provider, not create new
      await onStartedCb(WS_PATH, 8080);

      expect(firstProvider.reconnect).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Server stopped callback
  // ---------------------------------------------------------------------------

  describe("server stopped callback", () => {
    it("disconnects provider on restart (isRestart=true)", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      const onStoppedCb = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, isRestart: boolean) => void;

      // Create a provider
      await onStartedCb(WS_PATH, 8080);
      const createdProvider = latestMockProvider;

      // Stop with restart flag
      onStoppedCb(WS_PATH, true);

      expect(createdProvider.disconnect).toHaveBeenCalled();
      // Provider should still exist (not disposed) for reconnection
      expect(createdProvider.dispose).not.toHaveBeenCalled();
    });

    it("removes provider on full stop (isRestart=false)", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: Array<{ path: WorkspacePath; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      const onStoppedCb = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, isRestart: boolean) => void;

      // Create a provider
      await onStartedCb(WS_PATH, 8080);
      const createdProvider = latestMockProvider;
      statusChanges.length = 0; // Reset after initial status

      // Full stop
      onStoppedCb(WS_PATH, false);

      expect(createdProvider.dispose).toHaveBeenCalled();

      // Should emit "none" status after removal
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]!.status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });
  });

  // ---------------------------------------------------------------------------
  // Status tracking and deduplication
  // ---------------------------------------------------------------------------

  describe("status tracking", () => {
    it("forwards status changes from provider to registered callbacks", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: Array<{ path: WorkspacePath; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);
      statusChanges.length = 0; // Reset after initial "none"

      // Simulate provider status change to "busy"
      expect(capturedStatusCallback).not.toBeNull();
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({
        path: WS_PATH,
        status: { status: "busy", counts: { idle: 0, busy: 1 } },
      });
    });

    it("deduplicates status changes - same status not emitted twice", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);
      statusChanges.length = 0; // Reset after initial "none"

      // Emit "idle" twice
      capturedStatusCallback!("idle");
      capturedStatusCallback!("idle");

      // Only one change should be emitted
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
    });

    it("emits when status changes from idle to busy", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);
      statusChanges.length = 0;

      capturedStatusCallback!("idle");
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(2);
      expect(statusChanges[0]!.status).toBe("idle");
      expect(statusChanges[1]!.status).toBe("busy");
    });

    it("unsubscribe removes the callback", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: AggregatedAgentStatus[] = [];
      const unsubscribe = provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);
      statusChanges.length = 0;

      unsubscribe();
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns none for unknown workspace", () => {
      const provider = createProvider();
      const status = provider.getStatus(WS_PATH);

      expect(status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });

    it("returns cached status after provider emits", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);

      capturedStatusCallback!("busy");

      expect(provider.getStatus(WS_PATH)).toEqual({
        status: "busy",
        counts: { idle: 0, busy: 1 },
      });
    });
  });

  describe("getSession", () => {
    it("returns null for unknown workspace", () => {
      const provider = createProvider();
      const session = provider.getSession(WS_PATH);

      expect(session).toBeNull();
    });

    it("delegates to provider.getSession() when provider exists", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);

      const session = provider.getSession(WS_PATH);

      expect(session).toEqual({ port: 8080, sessionId: "s1" });
    });
  });

  // ---------------------------------------------------------------------------
  // Per-workspace operations
  // ---------------------------------------------------------------------------

  describe("startWorkspace", () => {
    it("starts server and returns environment variables", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      // Make startServer trigger the onServerStarted callback
      (mockServerManager.startServer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as (workspacePath: string, port: number) => void;
        await onStartedCb(WS_PATH, 8080);
        return 8080;
      });

      const result = await provider.startWorkspace(WS_PATH);

      expect(mockServerManager.startServer).toHaveBeenCalledWith(WS_PATH);
      expect(result.envVars).toEqual({ CLAUDE_PORT: "8080" });
    });

    it("calls setInitialPrompt when initialPrompt option is provided", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      (mockServerManager.startServer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as (workspacePath: string, port: number) => void;
        await onStartedCb(WS_PATH, 8080);
        return 8080;
      });

      const initialPrompt = { prompt: "Hello" };
      await provider.startWorkspace(WS_PATH, { initialPrompt });

      expect(mockServerManager.setInitialPrompt).toHaveBeenCalledWith(WS_PATH, initialPrompt);
    });

    it("calls setNoSessionMarker when isNewWorkspace option is true", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      (mockServerManager.startServer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as (workspacePath: string, port: number) => void;
        await onStartedCb(WS_PATH, 8080);
        return 8080;
      });

      await provider.startWorkspace(WS_PATH, { isNewWorkspace: true });

      expect(mockServerManager.setNoSessionMarker).toHaveBeenCalledWith(WS_PATH);
    });

    it("does not call setInitialPrompt or setNoSessionMarker without options", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      (mockServerManager.startServer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as (workspacePath: string, port: number) => void;
        await onStartedCb(WS_PATH, 8080);
        return 8080;
      });

      await provider.startWorkspace(WS_PATH);

      expect(mockServerManager.setInitialPrompt).not.toHaveBeenCalled();
      expect(mockServerManager.setNoSessionMarker).not.toHaveBeenCalled();
    });

    it("returns empty envVars when provider does not exist", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      // startServer does not trigger onServerStarted callback
      const result = await provider.startWorkspace(WS_PATH);

      expect(result.envVars).toEqual({});
    });
  });

  describe("stopWorkspace", () => {
    it("delegates to server manager", async () => {
      const provider = createProvider();
      const result = await provider.stopWorkspace(WS_PATH);

      expect(mockServerManager.stopServer).toHaveBeenCalledWith(WS_PATH);
      expect(result).toEqual({ success: true });
    });
  });

  describe("restartWorkspace", () => {
    it("delegates to server manager", async () => {
      const provider = createProvider();
      const result = await provider.restartWorkspace(WS_PATH);

      expect(mockServerManager.restartServer).toHaveBeenCalledWith(WS_PATH);
      expect(result).toEqual({ success: true, port: 8080 });
    });
  });

  // ---------------------------------------------------------------------------
  // markActive via setMarkActiveHandler
  // ---------------------------------------------------------------------------

  describe("markActive handler", () => {
    it("marks provider active when setMarkActiveHandler fires", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);

      // Get the markActiveHandler
      const markActiveHandler = (mockServerManager.setMarkActiveHandler as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0] as (workspacePath: string) => void;

      markActiveHandler(WS_PATH);

      expect(latestMockProvider.markActive).toHaveBeenCalled();
    });

    it("restores markActive on server restart when workspace was previously attached", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      const markActiveHandler = (mockServerManager.setMarkActiveHandler as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0] as (workspacePath: string) => void;

      // First start + mark active
      await onStartedCb(WS_PATH, 8080);
      markActiveHandler(WS_PATH);

      const firstProvider = latestMockProvider;
      expect(firstProvider.markActive).toHaveBeenCalledTimes(1);

      // Simulate restart: stop, remove old provider, start new
      const onStoppedCb = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, isRestart: boolean) => void;

      // Full stop to remove provider, then re-create
      onStoppedCb(WS_PATH, false);

      // New server start creates a new provider
      await onStartedCb(WS_PATH, 8080);
      const newProvider = latestMockProvider;

      // New provider should be marked active because workspace was in tuiAttachedWorkspaces
      expect(newProvider.markActive).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clearWorkspaceTracking
  // ---------------------------------------------------------------------------

  describe("clearWorkspaceTracking", () => {
    it("removes workspace from tuiAttachedWorkspaces", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      const markActiveHandler = (mockServerManager.setMarkActiveHandler as ReturnType<typeof vi.fn>)
        .mock.calls[0]![0] as (workspacePath: string) => void;

      // Start and mark active
      await onStartedCb(WS_PATH, 8080);
      markActiveHandler(WS_PATH);

      // Clear tracking
      provider.clearWorkspaceTracking(WS_PATH);

      // Remove existing provider via full stop
      const onStoppedCb = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, isRestart: boolean) => void;
      onStoppedCb(WS_PATH, false);

      // Create new provider: should NOT be auto-marked active
      await onStartedCb(WS_PATH, 8080);
      const newProvider = latestMockProvider;

      // markActive should not have been called on the new provider
      expect(newProvider.markActive).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  describe("dispose", () => {
    it("cleans up server callbacks, disposes server manager, and all providers", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      // Capture cleanup functions returned by onServerStarted/onServerStopped
      const startedCleanup = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .results[0]!.value as ReturnType<typeof vi.fn>;
      const stoppedCleanup = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .results[0]!.value as ReturnType<typeof vi.fn>;

      // Create a provider
      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;
      await onStartedCb(WS_PATH, 8080);
      const createdProvider = latestMockProvider;

      await provider.dispose();

      // Cleanup functions should have been called
      expect(startedCleanup).toHaveBeenCalled();
      expect(stoppedCleanup).toHaveBeenCalled();

      // Server manager should be disposed
      expect(mockServerManager.dispose).toHaveBeenCalled();

      // Provider should be disposed
      expect(createdProvider.dispose).toHaveBeenCalled();
    });

    it("can be called multiple times safely", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      await provider.dispose();
      await provider.dispose();

      // Server manager dispose called only once per call
      expect(mockServerManager.dispose).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple workspaces
  // ---------------------------------------------------------------------------

  describe("multiple workspaces", () => {
    it("tracks status independently per workspace", async () => {
      const provider = createProvider();
      provider.initialize({ port: 9999 });

      const statusChanges: Array<{ path: WorkspacePath; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as (workspacePath: string, port: number) => void;

      // Start workspace A
      await onStartedCb(WS_PATH, 8080);
      const callbackA = capturedStatusCallback!;

      // Start workspace B
      await onStartedCb(WS_PATH_B, 8081);
      const callbackB = capturedStatusCallback!;

      statusChanges.length = 0;

      // Change A to busy
      callbackA("busy");
      // Change B to idle
      callbackB("idle");

      expect(provider.getStatus(WS_PATH)).toEqual({
        status: "busy",
        counts: { idle: 0, busy: 1 },
      });
      expect(provider.getStatus(WS_PATH_B)).toEqual({
        status: "idle",
        counts: { idle: 1, busy: 0 },
      });

      // Verify both emitted separately
      expect(statusChanges).toHaveLength(2);
      expect(statusChanges[0]!.path).toBe(WS_PATH);
      expect(statusChanges[1]!.path).toBe(WS_PATH_B);
    });
  });
});
