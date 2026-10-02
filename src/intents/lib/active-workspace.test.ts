/**
 * Focused tests for the active-workspace lookup helpers.
 */

import { describe, it, expect } from "vitest";
import { activeWorkspace, activeWorkspaceRef } from "./active-workspace";
import type { GetActiveWorkspaceIntent, GetActiveWorkspaceResult } from "../get-active-workspace";
import { INTENT_GET_ACTIVE_WORKSPACE } from "../get-active-workspace";
import type { ProjectId, WorkspaceName } from "../contract";
import { workspaceRefIn } from "../../shared/test-fixtures";

const LOCATOR = {
  ref: workspaceRefIn("/project", "feature-x"),
  projectId: "project-ea0135bc" as ProjectId,
  workspaceName: "feature-x" as WorkspaceName,
};

function answering(result: GetActiveWorkspaceResult): {
  dispatch: (intent: GetActiveWorkspaceIntent) => Promise<GetActiveWorkspaceResult>;
  seen: GetActiveWorkspaceIntent[];
} {
  const seen: GetActiveWorkspaceIntent[] = [];
  return {
    seen,
    dispatch: async (intent) => {
      seen.push(intent);
      return result;
    },
  };
}

describe("activeWorkspace", () => {
  it("dispatches ui:get-active-workspace and returns its locator", async () => {
    const { dispatch, seen } = answering(LOCATOR);
    expect(await activeWorkspace(dispatch)).toEqual(LOCATOR);
    expect(seen).toEqual([{ type: INTENT_GET_ACTIVE_WORKSPACE, payload: {} }]);
  });

  it("returns null when nothing is active", async () => {
    expect(await activeWorkspace(answering(null).dispatch)).toBeNull();
  });
});

describe("activeWorkspaceRef", () => {
  it("returns the active workspace's ref", async () => {
    expect(await activeWorkspaceRef(answering(LOCATOR).dispatch)).toBe(LOCATOR.ref);
  });

  it("returns null when nothing is active", async () => {
    expect(await activeWorkspaceRef(answering(null).dispatch)).toBeNull();
  });

  it("rejects when the lookup fails", async () => {
    const failing = (): Promise<GetActiveWorkspaceResult> => Promise.reject(new Error("down"));
    await expect(activeWorkspaceRef(failing)).rejects.toThrow("down");
  });
});
