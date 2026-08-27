/**
 * Focused tests for progress rendering.
 */

import { describe, it, expect } from "vitest";
import { renderEvent } from "./progress";

describe("renderEvent", () => {
  describe("cloning", () => {
    it("reports the stage and percentage", () => {
      // The longest thing any command does, and the reason progress exists.
      expect(
        renderEvent({
          type: "clone:progress",
          payload: { stage: "receiving objects", progress: 42.6, name: "ohi", url: "u" },
        })
      ).toBe("cloning ohi: receiving objects 43%");
    });

    it("copes with a stage that carries no percentage", () => {
      expect(
        renderEvent({ type: "clone:progress", payload: { stage: "resolving deltas", name: "ohi" } })
      ).toBe("cloning ohi: resolving deltas");
    });
  });

  describe("deletion", () => {
    const progress = (extra: Record<string, unknown>) => ({
      type: "workspace:deletion-progress",
      payload: { operations: [], completed: false, hasErrors: false, ...extra },
    });

    it("reports the step currently running", () => {
      expect(
        renderEvent(
          progress({
            operations: [
              { id: "a", label: "Stopping agent", status: "done" },
              { id: "b", label: "Removing worktree", status: "running" },
            ],
          })
        )
      ).toBe("Removing worktree…");
    });

    it("says nothing while no step is in flight", () => {
      expect(
        renderEvent(progress({ operations: [{ id: "a", label: "x", status: "pending" }] }))
      ).toBeUndefined();
    });

    it("reports success once", () => {
      expect(renderEvent(progress({ completed: true }))).toBe("deleted");
    });

    it("names what is blocking the worktree", () => {
      // The single most useful thing to see when a delete will not complete.
      expect(
        renderEvent(
          progress({
            completed: true,
            hasErrors: true,
            blockingProcesses: [{ pid: 42, name: "node" }],
          })
        )
      ).toBe("blocked by node (pid 42)");
    });

    it("falls back to the step that failed", () => {
      expect(
        renderEvent(
          progress({
            completed: true,
            hasErrors: true,
            operations: [{ id: "a", label: "Removing worktree", status: "error", error: "EBUSY" }],
          })
        )
      ).toBe("failed: Removing worktree: EBUSY");
    });
  });

  describe("workspaces and projects", () => {
    it("reports a creation starting and finishing", () => {
      expect(
        renderEvent({ type: "workspace:loading", payload: { workspaceName: "feature-x" } })
      ).toBe("creating feature-x…");
      // The event carries the name directly; a nested workspace object was a
      // guess that rendered a bare "created" against a real app.
      expect(
        renderEvent({ type: "workspace:created", payload: { workspaceName: "feature-x" } })
      ).toBe("created feature-x");
    });

    it("reports a project opening", () => {
      expect(renderEvent({ type: "project:opened", payload: { project: { name: "ohi" } } })).toBe(
        "opened project ohi"
      );
    });

    it("reports failures with their reason", () => {
      expect(
        renderEvent({ type: "workspace:create-failed", payload: { error: "branch exists" } })
      ).toBe("could not create workspace: branch exists");
    });
  });

  it("says nothing for an event it does not know", () => {
    // Forwarding is opt-in, but a client may be older than the app it talks to.
    expect(renderEvent({ type: "something:new", payload: {} })).toBeUndefined();
  });

  it("survives a payload of the wrong shape", () => {
    expect(renderEvent({ type: "clone:progress", payload: null })).toBe("cloning : cloning");
  });
});
