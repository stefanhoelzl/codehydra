// @vitest-environment node
/**
 * Tests for agent status IPC handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";
import type { AgentStatusManager } from "../../services/opencode/agent-status-manager";
import type { DiscoveryService } from "../../services/opencode/discovery-service";

// Create mock functions
const mockGetStatus = vi.fn();
const mockGetAllStatuses = vi.fn();
const mockScan = vi.fn();

// Mock AgentStatusManager
const mockAgentStatusManager: Partial<AgentStatusManager> = {
  getStatus: mockGetStatus,
  getAllStatuses: mockGetAllStatuses,
};

// Mock DiscoveryService
const mockDiscoveryService: Partial<DiscoveryService> = {
  scan: mockScan,
};

import {
  createAgentGetStatusHandler,
  createAgentGetAllStatusesHandler,
  createAgentRefreshHandler,
} from "./agent-handlers";

describe("createAgentGetStatusHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns status for valid workspace path", async () => {
    const expectedStatus: AggregatedAgentStatus = {
      status: "idle",
      counts: { idle: 2, busy: 0 },
    };
    mockGetStatus.mockReturnValue(expectedStatus);

    const handler = createAgentGetStatusHandler(mockAgentStatusManager as AgentStatusManager);

    const result = await handler({} as never, {
      workspacePath: "/project/.worktrees/feature-1" as WorkspacePath,
    });

    expect(mockGetStatus).toHaveBeenCalledWith("/project/.worktrees/feature-1");
    expect(result).toEqual(expectedStatus);
  });

  it("returns none status for unknown workspace", async () => {
    const expectedStatus: AggregatedAgentStatus = {
      status: "none",
      counts: { idle: 0, busy: 0 },
    };
    mockGetStatus.mockReturnValue(expectedStatus);

    const handler = createAgentGetStatusHandler(mockAgentStatusManager as AgentStatusManager);

    const result = await handler({} as never, {
      workspacePath: "/unknown" as WorkspacePath,
    });

    expect(result).toEqual(expectedStatus);
  });
});

describe("createAgentGetAllStatusesHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all statuses as Record", async () => {
    const statusMap = new Map<WorkspacePath, AggregatedAgentStatus>([
      ["/workspace1" as WorkspacePath, { status: "idle", counts: { idle: 1, busy: 0 } }],
      ["/workspace2" as WorkspacePath, { status: "busy", counts: { idle: 0, busy: 1 } }],
    ]);
    mockGetAllStatuses.mockReturnValue(statusMap);

    const handler = createAgentGetAllStatusesHandler(mockAgentStatusManager as AgentStatusManager);

    const result = await handler({} as never, undefined);

    expect(mockGetAllStatuses).toHaveBeenCalled();
    expect(result).toEqual({
      "/workspace1": { status: "idle", counts: { idle: 1, busy: 0 } },
      "/workspace2": { status: "busy", counts: { idle: 0, busy: 1 } },
    });
  });

  it("returns empty object when no statuses", async () => {
    mockGetAllStatuses.mockReturnValue(new Map());

    const handler = createAgentGetAllStatusesHandler(mockAgentStatusManager as AgentStatusManager);

    const result = await handler({} as never, undefined);

    expect(result).toEqual({});
  });
});

describe("createAgentRefreshHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers discovery scan", async () => {
    mockScan.mockResolvedValue({ ok: true, value: undefined });

    const handler = createAgentRefreshHandler(mockDiscoveryService as DiscoveryService);

    await handler({} as never, undefined);

    expect(mockScan).toHaveBeenCalled();
  });

  it("handles scan errors gracefully", async () => {
    mockScan.mockResolvedValue({
      ok: false,
      error: { code: "SCAN_IN_PROGRESS", message: "Scan already running" },
    });

    const handler = createAgentRefreshHandler(mockDiscoveryService as DiscoveryService);

    // Should not throw, just ignore the error
    await expect(handler({} as never, undefined)).resolves.toBeUndefined();
  });
});
