/**
 * Tests for the agent status store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Api } from "@shared/electron-api";
import type { AgentStatus } from "@shared/api/types";
import { createMockApi } from "../test-utils";

// Create mock API (flat structure)
const mockApi: Api = createMockApi();

// Set up window.api before importing the store
window.api = mockApi;

// Import store after setting up mock
import {
  updateStatus,
  setAllStatuses,
  getStatus,
  getCounts,
  reset,
} from "./agent-status.svelte.js";

describe("agent status store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  describe("getStatus", () => {
    it("returns 'none' status for unknown workspace", () => {
      const status = getStatus("/unknown/path");

      expect(status).toEqual({ type: "none" });
    });

    it("returns stored status for known workspace", () => {
      const path = "/test/.worktrees/feature";
      const expected: AgentStatus = {
        type: "busy",
        counts: { idle: 0, busy: 2, total: 2 },
      };

      updateStatus(path, expected);

      expect(getStatus(path)).toEqual(expected);
    });
  });

  describe("getCounts", () => {
    it("returns zero counts for unknown workspace", () => {
      const counts = getCounts("/unknown/path");

      expect(counts).toEqual({ idle: 0, busy: 0 });
    });

    it("returns zero counts for workspace with 'none' status", () => {
      const path = "/test/.worktrees/feature";
      updateStatus(path, { type: "none" });

      const counts = getCounts(path);

      expect(counts).toEqual({ idle: 0, busy: 0 });
    });

    it("returns counts for workspace with non-none status", () => {
      const path = "/test/.worktrees/feature";
      updateStatus(path, { type: "busy", counts: { idle: 1, busy: 3, total: 4 } });

      const counts = getCounts(path);

      expect(counts).toEqual({ idle: 1, busy: 3 });
    });
  });

  describe("updateStatus", () => {
    it("sets status for a workspace", () => {
      const path = "/test/.worktrees/ws1";
      const status: AgentStatus = {
        type: "idle",
        counts: { idle: 3, busy: 0, total: 3 },
      };

      updateStatus(path, status);

      expect(getStatus(path)).toEqual(status);
    });

    it("updates existing status for a workspace", () => {
      const path = "/test/.worktrees/ws1";
      const initial: AgentStatus = {
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      };
      const updated: AgentStatus = {
        type: "busy",
        counts: { idle: 0, busy: 1, total: 1 },
      };

      updateStatus(path, initial);
      updateStatus(path, updated);

      expect(getStatus(path)).toEqual(updated);
    });

    it("handles multiple workspaces independently", () => {
      const path1 = "/test/.worktrees/ws1";
      const path2 = "/test/.worktrees/ws2";
      const status1: AgentStatus = {
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      };
      const status2: AgentStatus = {
        type: "busy",
        counts: { idle: 0, busy: 2, total: 2 },
      };

      updateStatus(path1, status1);
      updateStatus(path2, status2);

      expect(getStatus(path1)).toEqual(status1);
      expect(getStatus(path2)).toEqual(status2);
    });
  });

  describe("setAllStatuses", () => {
    it("sets multiple statuses at once from record", () => {
      const statuses: Record<string, AgentStatus> = {
        "/test/.worktrees/ws1": { type: "idle", counts: { idle: 1, busy: 0, total: 1 } },
        "/test/.worktrees/ws2": { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
        "/test/.worktrees/ws3": { type: "mixed", counts: { idle: 1, busy: 1, total: 2 } },
      };

      setAllStatuses(statuses);

      expect(getStatus("/test/.worktrees/ws1")).toEqual(statuses["/test/.worktrees/ws1"]);
      expect(getStatus("/test/.worktrees/ws2")).toEqual(statuses["/test/.worktrees/ws2"]);
      expect(getStatus("/test/.worktrees/ws3")).toEqual(statuses["/test/.worktrees/ws3"]);
    });

    it("clears existing statuses before setting new ones", () => {
      const initial: AgentStatus = {
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      };
      updateStatus("/test/.worktrees/old", initial);

      const newStatuses: Record<string, AgentStatus> = {
        "/test/.worktrees/new": { type: "busy", counts: { idle: 0, busy: 1, total: 1 } },
      };

      setAllStatuses(newStatuses);

      // Old workspace should now return default 'none' status
      expect(getStatus("/test/.worktrees/old")).toEqual({ type: "none" });
      expect(getStatus("/test/.worktrees/new")).toEqual(newStatuses["/test/.worktrees/new"]);
    });

    it("handles empty record", () => {
      updateStatus("/test/.worktrees/ws1", {
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      });

      setAllStatuses({});

      expect(getStatus("/test/.worktrees/ws1")).toEqual({ type: "none" });
    });
  });

  describe("reset", () => {
    it("clears all stored statuses", () => {
      updateStatus("/test/.worktrees/ws1", {
        type: "idle",
        counts: { idle: 1, busy: 0, total: 1 },
      });
      updateStatus("/test/.worktrees/ws2", {
        type: "busy",
        counts: { idle: 0, busy: 1, total: 1 },
      });

      reset();

      expect(getStatus("/test/.worktrees/ws1")).toEqual({ type: "none" });
      expect(getStatus("/test/.worktrees/ws2")).toEqual({ type: "none" });
    });
  });
});
