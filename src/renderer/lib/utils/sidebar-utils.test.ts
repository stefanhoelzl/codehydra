import { describe, it, expect } from "vitest";
import {
  getWorkspaceGlobalIndex,
  formatIndexDisplay,
  getShortcutHint,
  getStatusText,
} from "./sidebar-utils.js";
import { createMockProject } from "$lib/test-fixtures.js";
import type { ProjectId } from "@shared/api/types";

describe("sidebar-utils", () => {
  describe("getWorkspaceGlobalIndex", () => {
    it("returns workspace index for first project", () => {
      const projects = [
        createMockProject({
          workspaces: [{ name: "w1" }, { name: "w2" }],
        }),
      ];

      expect(getWorkspaceGlobalIndex(projects, 0, 0)).toBe(0);
      expect(getWorkspaceGlobalIndex(projects, 0, 1)).toBe(1);
    });

    it("adds previous projects workspace counts", () => {
      const projects = [
        createMockProject({
          id: "p1-12345678" as ProjectId,
          workspaces: [{ name: "w1" }, { name: "w2" }],
        }),
        createMockProject({
          id: "p2-12345678" as ProjectId,
          workspaces: [{ name: "w3" }],
        }),
      ];

      expect(getWorkspaceGlobalIndex(projects, 1, 0)).toBe(2);
    });

    it("handles multiple projects", () => {
      const projects = [
        createMockProject({
          id: "p1-12345678" as ProjectId,
          workspaces: [{ name: "w1" }],
        }),
        createMockProject({
          id: "p2-12345678" as ProjectId,
          workspaces: [{ name: "w2" }, { name: "w3" }],
        }),
        createMockProject({
          id: "p3-12345678" as ProjectId,
          workspaces: [{ name: "w4" }],
        }),
      ];

      expect(getWorkspaceGlobalIndex(projects, 2, 0)).toBe(3);
    });

    it("returns null for hibernated workspace", () => {
      const projects = [
        createMockProject({
          workspaces: [
            { name: "w1" },
            { name: "w2", metadata: { hibernated: "true" } },
            { name: "w3" },
          ],
        }),
      ];

      expect(getWorkspaceGlobalIndex(projects, 0, 1)).toBe(null);
    });

    it("skips hibernated workspaces in numbering sequence", () => {
      const projects = [
        createMockProject({
          workspaces: [
            { name: "w1" },
            { name: "w2", metadata: { hibernated: "true" } },
            { name: "w3" },
          ],
        }),
      ];

      // w1 stays at 0; w3 takes index 1 (w2 is skipped)
      expect(getWorkspaceGlobalIndex(projects, 0, 0)).toBe(0);
      expect(getWorkspaceGlobalIndex(projects, 0, 2)).toBe(1);
    });

    it("skips hibernated across project boundaries", () => {
      const projects = [
        createMockProject({
          id: "p1-12345678" as ProjectId,
          workspaces: [{ name: "w1" }, { name: "w2", metadata: { hibernated: "true" } }],
        }),
        createMockProject({
          id: "p2-12345678" as ProjectId,
          workspaces: [{ name: "w3" }],
        }),
      ];

      // p1 contributes only 1 awake workspace, so p2's first workspace is at index 1
      expect(getWorkspaceGlobalIndex(projects, 1, 0)).toBe(1);
    });
  });

  describe("formatIndexDisplay", () => {
    it("returns 1-9 for indices 0-8", () => {
      expect(formatIndexDisplay(0)).toBe("1");
      expect(formatIndexDisplay(4)).toBe("5");
      expect(formatIndexDisplay(8)).toBe("9");
    });

    it("returns 0 for index 9", () => {
      expect(formatIndexDisplay(9)).toBe("0");
    });

    it("returns null for index > 9", () => {
      expect(formatIndexDisplay(10)).toBe(null);
      expect(formatIndexDisplay(15)).toBe(null);
    });

    it("returns null for null input (hibernated)", () => {
      expect(formatIndexDisplay(null)).toBe(null);
    });
  });

  describe("getShortcutHint", () => {
    it("returns hint with key for indices 0-8", () => {
      expect(getShortcutHint(0)).toBe(" - Press 1 to jump");
      expect(getShortcutHint(4)).toBe(" - Press 5 to jump");
    });

    it("returns hint with 0 for index 9", () => {
      expect(getShortcutHint(9)).toBe(" - Press 0 to jump");
    });

    it("returns empty string for index > 9", () => {
      expect(getShortcutHint(10)).toBe("");
      expect(getShortcutHint(15)).toBe("");
    });

    it("returns empty string for null input (hibernated)", () => {
      expect(getShortcutHint(null)).toBe("");
    });
  });

  describe("getStatusText", () => {
    it("returns no agents when both counts are 0", () => {
      expect(getStatusText(0, 0)).toBe("No agents running");
    });

    it("returns idle count when only idle", () => {
      expect(getStatusText(1, 0)).toBe("1 agent idle");
      expect(getStatusText(3, 0)).toBe("3 agents idle");
    });

    it("returns busy count when only busy", () => {
      expect(getStatusText(0, 1)).toBe("1 agent busy");
      expect(getStatusText(0, 5)).toBe("5 agents busy");
    });

    it("returns mixed status when both present", () => {
      expect(getStatusText(2, 3)).toBe("2 idle, 3 busy");
    });
  });
});
