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
import { makeWorkspaceRef, projectRefFor } from "../utils/ref";

const PROJECT_REF = projectRefFor(projPath("/projects/test"));
const REF: WorkspaceRef = makeWorkspaceRef(PROJECT_REF, "a");

const busy: AggregatedAgentStatus = { status: "busy", counts: { idle: 0, busy: 1 } };
const idle: AggregatedAgentStatus = { status: "idle", counts: { idle: 1, busy: 0 } };

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
});
