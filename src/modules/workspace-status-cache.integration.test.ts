// @vitest-environment node
/**
 * Integration tests for the shared workspace agent-status cache: the map it
 * keeps from agent:status-updated / workspace:deleted, and the transition its
 * change callback reports.
 */

import { describe, it, expect, vi } from "vitest";
import { createWorkspaceStatusCache, type WorkspaceStatusChange } from "./workspace-status-cache";
import { EVENT_AGENT_STATUS_UPDATED } from "../intents/update-agent-status";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import type { AggregatedAgentStatus } from "../shared/ipc";
import type { ProjectId, WorkspaceName, WorkspaceRef } from "../intents/contract";
import type { EventFor } from "../intents/declarations";
import { projPath } from "../shared/test-fixtures";
import { makeWorkspaceRef } from "../utils/ref";
import { gitProjectRef } from "./git-project-ref";

const PROJECT_REF = gitProjectRef(projPath("/projects/test"));
const REF: WorkspaceRef = makeWorkspaceRef(PROJECT_REF, "a");

const T0 = "2026-11-05T10:00:00.000Z";
const T1 = "2026-11-05T10:05:00.000Z";
const T2 = "2026-11-05T10:09:00.000Z";
const busy: AggregatedAgentStatus = {
  status: "busy",
  counts: { idle: 0, busy: 1 },
  changedAt: T0,
};
const idle: AggregatedAgentStatus = {
  status: "idle",
  counts: { idle: 1, busy: 0 },
  changedAt: T1,
};

function statusEvent(status: AggregatedAgentStatus): EventFor<typeof EVENT_AGENT_STATUS_UPDATED> {
  return {
    type: EVENT_AGENT_STATUS_UPDATED,
    payload: {
      workspaceRef: REF,
      projectRef: PROJECT_REF,
      projectId: "test" as ProjectId,
      workspaceName: "a" as WorkspaceName,
      active: false,
      status,
    },
  };
}

function deletedEvent(): EventFor<typeof EVENT_WORKSPACE_DELETED> {
  return {
    type: EVENT_WORKSPACE_DELETED,
    payload: {
      projectId: "test" as ProjectId,
      projectRef: PROJECT_REF,
      workspaceName: "a" as WorkspaceName,
      workspaceRef: REF,
      worktreeRemoved: true,
    },
  };
}

describe("createWorkspaceStatusCache", () => {
  it("reports each change with the status before and after", async () => {
    const onChange = vi.fn<WorkspaceStatusChange>();
    const cache = createWorkspaceStatusCache(onChange);

    await cache.events[EVENT_AGENT_STATUS_UPDATED].handler(statusEvent(busy));
    await cache.events[EVENT_AGENT_STATUS_UPDATED].handler(statusEvent(idle));
    await cache.events[EVENT_WORKSPACE_DELETED].handler(deletedEvent());

    expect(onChange.mock.calls).toEqual([
      [REF, undefined, busy],
      [REF, busy, idle],
      [REF, idle, undefined],
    ]);
  });

  it("has the map updated by the time the callback runs", async () => {
    const seen: Array<AggregatedAgentStatus | undefined> = [];
    const cache = createWorkspaceStatusCache((ref) => seen.push(cache.statuses.get(ref)));

    await cache.events[EVENT_AGENT_STATUS_UPDATED].handler(statusEvent(busy));
    await cache.events[EVENT_WORKSPACE_DELETED].handler(deletedEvent());

    expect(seen).toEqual([busy, undefined]);
    expect(cache.statuses.size).toBe(0);
  });

  describe("changedAt", () => {
    async function report(
      cache: ReturnType<typeof createWorkspaceStatusCache>,
      status: AggregatedAgentStatus
    ): Promise<string | undefined> {
      await cache.events[EVENT_AGENT_STATUS_UPDATED].handler(statusEvent(status));
      return cache.statuses.get(REF)?.changedAt;
    }

    it("keeps the stamp across busy ↔ mixed and count-only changes", async () => {
      const cache = createWorkspaceStatusCache();
      expect(await report(cache, busy)).toBe(T0);
      expect(
        await report(cache, { status: "mixed", counts: { idle: 1, busy: 1 }, changedAt: T1 })
      ).toBe(T0);
      expect(
        await report(cache, { status: "busy", counts: { idle: 0, busy: 2 }, changedAt: T2 })
      ).toBe(T0);
    });

    it("takes the new stamp when the workspace moves between none, idle and working", async () => {
      const cache = createWorkspaceStatusCache();
      await report(cache, busy);
      expect(await report(cache, idle)).toBe(T1);
      expect(
        await report(cache, { status: "none", counts: { idle: 0, busy: 0 }, changedAt: T2 })
      ).toBe(T2);
    });

    it("stamps an unstamped status (an agent.status.set nudge) only when the state changes", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(T2));
        const cache = createWorkspaceStatusCache();
        await report(cache, busy);
        expect(await report(cache, { status: "busy", counts: { idle: 0, busy: 1 } })).toBe(T0);
        expect(await report(cache, { status: "idle", counts: { idle: 1, busy: 0 } })).toBe(T2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
