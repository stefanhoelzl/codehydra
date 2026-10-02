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
import type { AgentProvider, AgentActivity } from "../types";
import type { AggregatedAgentStatus } from "../../../shared/ipc";
import { Path } from "../../../utils/path/path";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import {
  createFakeBinaryResolver,
  createMockServerManager as createServerManagerBase,
  type FakeBinaryResolver,
} from "../module-provider.test-utils";
import type { ResolvedAgentBinary } from "../binary-resolver";
import {
  createMockProcessRunner,
  type MockProcessRunner,
} from "../../../boundaries/platform/process.state-mock";
import { testPath } from "../../../shared/test-fixtures";
import { workspaceRefSchema, type WorkspaceRef } from "../../../intents/contract";

// =============================================================================
// Mock ClaudeCodeProvider via vi.mock
// =============================================================================

/** Captured status callback from the latest mock provider's onStatusChange. */
let capturedStatusCallback: ((status: AgentActivity) => void) | null = null;

/** Reference to the latest mock provider instance for assertions. */
let latestMockProvider: AgentProvider;

vi.mock("./provider", () => ({
  ClaudeCodeProvider: class MockClaudeCodeProvider {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    reconnect = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    onStatusChange = vi.fn((cb: (status: AgentActivity) => void) => {
      capturedStatusCallback = cb;
      return vi.fn();
    });
    getSession = vi.fn().mockReturnValue({ port: 8080, sessionId: "s1" });
    getEnvironmentVariables = vi.fn().mockReturnValue({ CLAUDE_PORT: "8080" });
    sendMessage = vi.fn().mockResolvedValue(undefined);
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
  return createServerManagerBase({
    setInitialPrompt: vi.fn().mockResolvedValue(undefined),
    setNoSessionMarker: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ClaudeCodeServerManager;
}

const WS_PATH = testPath("/workspace/feature-a").toNative();
const WS_REF = workspaceRefSchema.parse("ch::local::/test::ws");
const WS_REF_B = workspaceRefSchema.parse("ch::local::/test::ws-b");

// =============================================================================
// Tests
// =============================================================================

describe("createClaudeModuleProvider", () => {
  let mockServerManager: ClaudeCodeServerManager;
  let binary: FakeBinaryResolver;
  let processRunner: MockProcessRunner;

  const SYSTEM_CLAUDE: ResolvedAgentBinary = {
    path: "/usr/local/bin/claude",
    source: "system",
    version: null,
  };
  const DOWNLOADED_CLAUDE: ResolvedAgentBinary = {
    path: "/bundles/claude/2.1.274/claude",
    source: "download",
    version: "2.1.274",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedStatusCallback = null;
    mockServerManager = createMockServerManager();
    binary = createFakeBinaryResolver({ binary: SYSTEM_CLAUDE });
  });

  function createProvider(
    helpStdout = '--permission-mode <mode>  mode (choices: "plan", "acceptEdits")'
  ) {
    processRunner = createMockProcessRunner({ defaultResult: { stdout: helpStdout } });
    return createClaudeModuleProvider({
      serverManager: mockServerManager,
      binary,
      platform: "linux",
      logger: SILENT_LOGGER,
      processRunner,
    });
  }

  /** A provider initialized with an MCP config, as at app start. */
  function createInitializedProvider() {
    const provider = createProvider();
    provider.initialize({
      nodePath: testPath("/ide/node").toNative(),
      cliPath: testPath("/data/bin/ch.cjs").toNative(),
      port: 9999,
      token: "test-token",
    });
    return provider;
  }

  /** The callback the provider registered with the server manager's onServerStarted. */
  function serverStartedCallback(): (workspaceRef: WorkspaceRef, port: number) => void {
    return (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      workspaceRef: WorkspaceRef,
      port: number
    ) => void;
  }

  /** The callback the provider registered with the server manager's onServerStopped. */
  function serverStoppedCallback(): (workspaceRef: WorkspaceRef, isRestart: boolean) => void {
    return (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      workspaceRef: WorkspaceRef,
      isRestart: boolean
    ) => void;
  }

  /** Make startServer report WS_REF's server started on 8080, as the real manager does. */
  function startServerFiresStarted(): void {
    (mockServerManager.startServer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await serverStartedCallback()(WS_REF, 8080);
      return 8080;
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

      expect(provider.scripts).toEqual(["claude-code-hook-handler.cjs", "ch-bg", "ch-bg.cmd"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Binary delegation
  // ---------------------------------------------------------------------------

  describe("launch options", () => {
    it("parses permission modes from `claude --help`", async () => {
      const provider = createProvider();

      expect(await provider.getLaunchOptions?.()).toEqual({
        permissionModes: ["plan", "acceptEdits"],
      });
    });

    it("parses a multi-line choices list", async () => {
      const help = [
        "  --permission-mode <mode>  Permission mode to use",
        '                            (choices: "acceptEdits", "auto",',
        '                            "bypassPermissions", "default", "plan")',
      ].join("\n");
      const provider = createProvider(help);

      expect(await provider.getLaunchOptions?.()).toEqual({
        permissionModes: ["acceptEdits", "auto", "bypassPermissions", "default", "plan"],
      });
    });

    it("reports no modes when the help output has no choices list", async () => {
      const provider = createProvider("usage: claude [options]");

      expect(await provider.getLaunchOptions?.()).toEqual({ permissionModes: [] });
    });

    it("asks the binary workspaces run, not whatever is on PATH", async () => {
      binary = createFakeBinaryResolver({ binary: DOWNLOADED_CLAUDE });
      const provider = createProvider();

      await provider.getLaunchOptions?.();

      expect(processRunner).toHaveSpawned([
        { command: "/bundles/claude/2.1.274/claude", args: ["--help"] },
      ]);
    });

    it("offers only the default mode until the binary is known, then detects", async () => {
      binary = createFakeBinaryResolver({ needsDownload: true });
      const provider = createProvider();

      expect(await provider.getLaunchOptions?.()).toEqual({ permissionModes: [] });
      await provider.downloadBinary();
      expect(await provider.getLaunchOptions?.()).toEqual({
        permissionModes: ["plan", "acceptEdits"],
      });
    });
  });

  describe("binary management", () => {
    it("binaryType is claude", () => {
      const provider = createProvider();

      expect(provider.binaryType).toBe("claude");
    });

    it("preflight reports no download when the binary is resolved", async () => {
      const provider = createProvider();
      const result = await provider.preflight();

      expect(result).toEqual({ success: true, needsDownload: false });
    });

    it("preflight reports a download when nothing is installed, and downloadBinary fetches it", async () => {
      binary = createFakeBinaryResolver({ binary: DOWNLOADED_CLAUDE, needsDownload: true });
      const provider = createProvider();

      expect(await provider.preflight()).toEqual({ success: true, needsDownload: true });
      await provider.downloadBinary();

      expect(binary.downloads).toBe(1);
      expect(await provider.preflight()).toEqual({ success: true, needsDownload: false });
    });

    it("reports the version directories in use for cleanup", () => {
      binary = createFakeBinaryResolver({ binary: DOWNLOADED_CLAUDE });
      const provider = createProvider();

      expect(provider.bundleVersionsInUse()).toEqual(["2.1.274"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  describe("initialize", () => {
    it("wires server callbacks and sets MCP config", () => {
      createInitializedProvider();

      expect(mockServerManager.onServerStarted).toHaveBeenCalled();
      expect(mockServerManager.onServerStopped).toHaveBeenCalled();
      expect(mockServerManager.setMcpConfig).toHaveBeenCalledWith({
        nodePath: testPath("/ide/node").toNative(),
        cliPath: testPath("/data/bin/ch.cjs").toNative(),
        port: 9999,
        token: "test-token",
      });
    });

    it("does not set MCP config when null", () => {
      const provider = createProvider();

      provider.initialize(null);

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
      const provider = createInitializedProvider();

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      // Get the captured onServerStarted callback
      const onStartedCb = serverStartedCallback();

      // Simulate server started
      await onStartedCb(WS_REF, 8080);

      // Provider should have been created and connected
      expect(latestMockProvider.connect).toHaveBeenCalledWith(8080);

      // Initial status should be emitted (none, since addProvider calls handleStatusUpdate with "none")
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });

    it("reconnects existing provider on restart (server started again)", async () => {
      createInitializedProvider();

      const onStartedCb = serverStartedCallback();

      // First start: creates provider
      await onStartedCb(WS_REF, 8080);
      const firstProvider = latestMockProvider;

      // Second start (restart): should reconnect existing provider, not create new
      await onStartedCb(WS_REF, 8080);

      expect(firstProvider.reconnect).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Server stopped callback
  // ---------------------------------------------------------------------------

  describe("server stopped callback", () => {
    it("disconnects provider on restart (isRestart=true)", async () => {
      createInitializedProvider();

      const onStartedCb = serverStartedCallback();
      const onStoppedCb = serverStoppedCallback();

      // Create a provider
      await onStartedCb(WS_REF, 8080);
      const createdProvider = latestMockProvider;

      // Stop with restart flag
      onStoppedCb(WS_REF, true);

      expect(createdProvider.disconnect).toHaveBeenCalled();
      // Provider should still exist (not disposed) for reconnection
      expect(createdProvider.dispose).not.toHaveBeenCalled();
    });

    it("removes provider on full stop (isRestart=false)", async () => {
      const provider = createInitializedProvider();

      const statusChanges: Array<{ path: WorkspaceRef; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = serverStartedCallback();
      const onStoppedCb = serverStoppedCallback();

      // Create a provider
      await onStartedCb(WS_REF, 8080);
      const createdProvider = latestMockProvider;
      statusChanges.length = 0; // Reset after initial status

      // Full stop
      onStoppedCb(WS_REF, false);

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
      const provider = createInitializedProvider();

      const statusChanges: Array<{ path: WorkspaceRef; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
      statusChanges.length = 0; // Reset after initial "none"

      // Simulate provider status change to "busy"
      expect(capturedStatusCallback).not.toBeNull();
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({
        path: WS_REF,
        status: { status: "busy", counts: { idle: 0, busy: 1 } },
      });
    });

    it("deduplicates status changes - same status not emitted twice", async () => {
      const provider = createInitializedProvider();

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
      statusChanges.length = 0; // Reset after initial "none"

      // Emit "idle" twice
      capturedStatusCallback!("idle");
      capturedStatusCallback!("idle");

      // Only one change should be emitted
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]).toEqual({ status: "idle", counts: { idle: 1, busy: 0 } });
    });

    it("emits when status changes from idle to busy", async () => {
      const provider = createInitializedProvider();

      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
      statusChanges.length = 0;

      capturedStatusCallback!("idle");
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(2);
      expect(statusChanges[0]!.status).toBe("idle");
      expect(statusChanges[1]!.status).toBe("busy");
    });

    it("unsubscribe removes the callback", async () => {
      const provider = createInitializedProvider();

      const statusChanges: AggregatedAgentStatus[] = [];
      const unsubscribe = provider.onStatusChange((_wp, status) => statusChanges.push(status));

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
      statusChanges.length = 0;

      unsubscribe();
      capturedStatusCallback!("busy");

      expect(statusChanges).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Open-modal overlay
  // ---------------------------------------------------------------------------

  describe("modal overlay", () => {
    const IDLE = { status: "idle", counts: { idle: 1, busy: 0 } };
    const BUSY = { status: "busy", counts: { idle: 0, busy: 1 } };
    const NONE = { status: "none", counts: { idle: 0, busy: 0 } };

    async function startedProvider() {
      const provider = createInitializedProvider();
      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));
      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
      statusChanges.length = 0;
      return { provider, statusChanges };
    }

    it("parks a busy workspace on idle until the modal closes", async () => {
      const { provider, statusChanges } = await startedProvider();
      capturedStatusCallback!("busy");

      provider.setModalOpen(WS_REF, true);
      expect(provider.getStatus(WS_REF)).toEqual(IDLE);

      provider.setModalOpen(WS_REF, false);
      expect(provider.getStatus(WS_REF)).toEqual(BUSY);
      expect(statusChanges).toEqual([BUSY, IDLE, BUSY]);
    });

    it("records agent changes while parked without reporting them", async () => {
      const { provider, statusChanges } = await startedProvider();
      capturedStatusCallback!("busy");
      provider.setModalOpen(WS_REF, true);
      statusChanges.length = 0;

      capturedStatusCallback!("idle");
      capturedStatusCallback!("busy");
      expect(statusChanges).toEqual([]);

      provider.setModalOpen(WS_REF, false);
      expect(statusChanges).toEqual([BUSY]);
    });

    it("parks a workspace with no agent session, and returns it to none", async () => {
      const provider = createProvider();
      const statusChanges: AggregatedAgentStatus[] = [];
      provider.onStatusChange((_wp, status) => statusChanges.push(status));

      provider.setModalOpen(WS_REF, true);
      expect(provider.getStatus(WS_REF)).toEqual(IDLE);

      provider.setModalOpen(WS_REF, false);
      expect(provider.getStatus(WS_REF)).toEqual(NONE);
      expect(statusChanges).toEqual([IDLE, NONE]);
    });

    it("re-reports on every edge, even when the status did not change", async () => {
      const { provider, statusChanges } = await startedProvider();
      capturedStatusCallback!("idle");
      statusChanges.length = 0;

      provider.setModalOpen(WS_REF, true);
      provider.setModalOpen(WS_REF, false);

      // An agent.status.set nudge bypasses the core, so the last report here is
      // not necessarily what the UI shows — each edge corrects it.
      expect(statusChanges).toEqual([IDLE, IDLE]);
    });

    it("stays parked when the provider is removed mid-modal", async () => {
      const { provider, statusChanges } = await startedProvider();
      capturedStatusCallback!("busy");
      provider.setModalOpen(WS_REF, true);
      statusChanges.length = 0;

      const onStoppedCb = serverStoppedCallback();
      onStoppedCb(WS_REF, false);

      expect(statusChanges).toEqual([IDLE]);
    });

    it("clearWorkspaceTracking drops the park", async () => {
      const { provider } = await startedProvider();
      capturedStatusCallback!("busy");
      provider.setModalOpen(WS_REF, true);

      provider.clearWorkspaceTracking(WS_REF);

      expect(provider.getStatus(WS_REF)).toEqual(BUSY);
    });

    it("parks only the workspace showing the modal", async () => {
      const { provider } = await startedProvider();
      capturedStatusCallback!("busy");

      provider.setModalOpen(WS_REF_B, true);

      expect(provider.getStatus(WS_REF)).toEqual(BUSY);
      expect(provider.getStatus(WS_REF_B)).toEqual(IDLE);
    });
  });

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  describe("getStatus", () => {
    it("returns none for unknown workspace", () => {
      const provider = createProvider();
      const status = provider.getStatus(WS_REF);

      expect(status).toEqual({ status: "none", counts: { idle: 0, busy: 0 } });
    });

    it("returns cached status after provider emits", async () => {
      const provider = createInitializedProvider();

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);

      capturedStatusCallback!("busy");

      expect(provider.getStatus(WS_REF)).toEqual({
        status: "busy",
        counts: { idle: 0, busy: 1 },
      });
    });
  });

  describe("getSession", () => {
    it("returns null for unknown workspace", () => {
      const provider = createProvider();
      const session = provider.getSession(WS_REF);

      expect(session).toBeNull();
    });

    it("delegates to provider.getSession() when provider exists", async () => {
      const provider = createInitializedProvider();

      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);

      const session = provider.getSession(WS_REF);

      expect(session).toEqual({ port: 8080, sessionId: "s1" });
    });
  });

  describe("sendMessage", () => {
    const message = { text: "hello", from: "CodeHydra · ch" };

    it("fails for a workspace with no provider", async () => {
      const provider = createProvider();

      await expect(provider.sendMessage(WS_REF, message, { waitMs: 0 })).rejects.toThrow(
        "No Claude Code agent is running in this workspace."
      );
    });

    it("delegates to the workspace's provider", async () => {
      const provider = createProvider();
      provider.initialize(null);
      const onStartedCb = serverStartedCallback();
      onStartedCb(WS_REF, 8080);

      // Sent while the provider is still being registered: it waits for it.
      await provider.sendMessage(WS_REF, message, { waitMs: 500 });

      expect(latestMockProvider.sendMessage).toHaveBeenCalledWith(message, { waitMs: 500 });
    });
  });

  // ---------------------------------------------------------------------------
  // Per-workspace operations
  // ---------------------------------------------------------------------------

  describe("startWorkspace", () => {
    it("starts server and returns environment variables", async () => {
      const provider = createInitializedProvider();

      // Make startServer trigger the onServerStarted callback
      startServerFiresStarted();

      const result = await provider.startWorkspace(WS_REF, new Path(WS_PATH));

      expect(mockServerManager.startServer).toHaveBeenCalledWith(WS_REF);
      expect(result.envVars).toEqual({
        CLAUDE_PORT: "8080",
        _CH_CLAUDE_BIN: "/usr/local/bin/claude",
      });
    });

    it("points the terminal at a downloaded binary and turns off its self-update", async () => {
      binary = createFakeBinaryResolver({ binary: DOWNLOADED_CLAUDE });
      const provider = createProvider();

      const result = await provider.startWorkspace(WS_REF, new Path(WS_PATH));

      expect(result.envVars).toMatchObject({
        _CH_CLAUDE_BIN: "/bundles/claude/2.1.274/claude",
        DISABLE_AUTOUPDATER: "1",
      });
    });

    it("leaves a system install's self-update alone", async () => {
      const provider = createProvider();

      const result = await provider.startWorkspace(WS_REF, new Path(WS_PATH));

      expect(result.envVars).not.toHaveProperty("DISABLE_AUTOUPDATER");
    });

    it("calls setInitialPrompt when initialPrompt option is provided", async () => {
      const provider = createInitializedProvider();

      startServerFiresStarted();

      const initialPrompt = { prompt: "Hello" };
      const onInitialPromptDelivered = vi.fn();
      await provider.startWorkspace(WS_REF, new Path(WS_PATH), {
        initialPrompt,
        onInitialPromptDelivered,
      });

      expect(mockServerManager.setInitialPrompt).toHaveBeenCalledWith(
        WS_REF,
        initialPrompt,
        onInitialPromptDelivered
      );
    });

    it("calls setNoSessionMarker when isNewWorkspace option is true", async () => {
      const provider = createInitializedProvider();

      startServerFiresStarted();

      await provider.startWorkspace(WS_REF, new Path(WS_PATH), { isNewWorkspace: true });

      expect(mockServerManager.setNoSessionMarker).toHaveBeenCalledWith(WS_REF);
    });

    it("does not call setInitialPrompt or setNoSessionMarker without options", async () => {
      const provider = createInitializedProvider();

      startServerFiresStarted();

      await provider.startWorkspace(WS_REF, new Path(WS_PATH));

      expect(mockServerManager.setInitialPrompt).not.toHaveBeenCalled();
      expect(mockServerManager.setNoSessionMarker).not.toHaveBeenCalled();
    });

    it("returns only the binary path when provider does not exist", async () => {
      const provider = createInitializedProvider();

      // startServer does not trigger onServerStarted callback
      const result = await provider.startWorkspace(WS_REF, new Path(WS_PATH));

      expect(result.envVars).toEqual({ _CH_CLAUDE_BIN: "/usr/local/bin/claude" });
    });
  });

  describe("stopWorkspace", () => {
    it("delegates to server manager", async () => {
      const provider = createProvider();
      const result = await provider.stopWorkspace(WS_REF);

      expect(mockServerManager.stopServer).toHaveBeenCalledWith(WS_REF);
      expect(result).toEqual({ success: true });
    });
  });

  describe("restartWorkspace", () => {
    it("delegates to server manager", async () => {
      const provider = createProvider();
      const result = await provider.restartWorkspace(WS_REF);

      expect(mockServerManager.restartServer).toHaveBeenCalledWith(WS_REF);
      expect(result).toEqual({ success: true, port: 8080 });
    });
  });

  // ---------------------------------------------------------------------------
  // Dispose
  // ---------------------------------------------------------------------------

  describe("dispose", () => {
    it("cleans up server callbacks, disposes server manager, and all providers", async () => {
      const provider = createInitializedProvider();

      // Capture cleanup functions returned by onServerStarted/onServerStopped
      const startedCleanup = (mockServerManager.onServerStarted as ReturnType<typeof vi.fn>).mock
        .results[0]!.value as ReturnType<typeof vi.fn>;
      const stoppedCleanup = (mockServerManager.onServerStopped as ReturnType<typeof vi.fn>).mock
        .results[0]!.value as ReturnType<typeof vi.fn>;

      // Create a provider
      const onStartedCb = serverStartedCallback();
      await onStartedCb(WS_REF, 8080);
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
      const provider = createInitializedProvider();

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
      const provider = createInitializedProvider();

      const statusChanges: Array<{ path: WorkspaceRef; status: AggregatedAgentStatus }> = [];
      provider.onStatusChange((wp, status) => statusChanges.push({ path: wp, status }));

      const onStartedCb = serverStartedCallback();

      // Start workspace A
      await onStartedCb(WS_REF, 8080);
      const callbackA = capturedStatusCallback!;

      // Start workspace B
      await onStartedCb(WS_REF_B, 8081);
      const callbackB = capturedStatusCallback!;

      statusChanges.length = 0;

      // Change A to busy
      callbackA("busy");
      // Change B to idle
      callbackB("idle");

      expect(provider.getStatus(WS_REF)).toEqual({
        status: "busy",
        counts: { idle: 0, busy: 1 },
      });
      expect(provider.getStatus(WS_REF_B)).toEqual({
        status: "idle",
        counts: { idle: 1, busy: 0 },
      });

      // Verify both emitted separately
      expect(statusChanges).toHaveLength(2);
      expect(statusChanges[0]!.path).toBe(WS_REF);
      expect(statusChanges[1]!.path).toBe(WS_REF_B);
    });
  });
});
