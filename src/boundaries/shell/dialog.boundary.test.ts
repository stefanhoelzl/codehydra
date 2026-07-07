/**
 * Boundary tests for DefaultDialogBoundary against a mocked Electron dialog module.
 *
 * These exercise the real implementation (not the behavioral mock) to verify how
 * it translates Electron's raw dialog results into ShowDialogResult — in
 * particular the cancel paths, where Electron's shape differs across platforms.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDialog } = vi.hoisted(() => ({
  mockDialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

vi.mock("electron", () => ({ dialog: mockDialog }));

import { DefaultDialogBoundary } from "./dialog";
import { SILENT_LOGGER } from "../platform/logging";

describe("DefaultDialogBoundary (real implementation)", () => {
  let boundary: DefaultDialogBoundary;

  beforeEach(() => {
    vi.clearAllMocks();
    boundary = new DefaultDialogBoundary(SILENT_LOGGER);
  });

  describe("save mode", () => {
    it("returns the chosen path when confirmed", async () => {
      mockDialog.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/home/user/template.liquid",
      });

      const result = await boundary.showDialog({ mode: "save" });

      expect(result.canceled).toBe(false);
      expect(result.filePaths).toHaveLength(1);
      expect(result.filePaths[0]?.toString()).toBe("/home/user/template.liquid");
    });

    it("returns no paths (no throw) when canceled with empty filePath (Windows)", async () => {
      // On Windows, canceling showSaveDialog yields filePath: "" rather than
      // undefined. Guarding on `!== undefined` would build new Path("") and throw
      // "Path cannot be empty".
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });

      const result = await boundary.showDialog({ mode: "save" });

      expect(result.canceled).toBe(true);
      expect(result.filePaths).toHaveLength(0);
    });

    it("returns no paths when canceled with undefined filePath", async () => {
      mockDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

      const result = await boundary.showDialog({ mode: "save" });

      expect(result.canceled).toBe(true);
      expect(result.filePaths).toHaveLength(0);
    });
  });

  describe("open mode", () => {
    it("maps every chosen path to a Path", async () => {
      mockDialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ["/path/a", "/path/b"],
      });

      const result = await boundary.showDialog({ properties: ["openFile", "multiSelections"] });

      expect(result.canceled).toBe(false);
      expect(result.filePaths.map((p) => p.toString())).toEqual(["/path/a", "/path/b"]);
    });

    it("returns no paths when canceled", async () => {
      mockDialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

      const result = await boundary.showDialog({ properties: ["openDirectory"] });

      expect(result.canceled).toBe(true);
      expect(result.filePaths).toHaveLength(0);
    });
  });
});
