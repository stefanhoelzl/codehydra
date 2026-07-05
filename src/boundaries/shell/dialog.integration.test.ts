/**
 * Integration tests for DialogBoundary behavioral mock.
 *
 * Tests verify the behavioral mock provides correct contract behavior
 * that matches the real DefaultDialogBoundary implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBehavioralDialogBoundary, type BehavioralDialogBoundary } from "./dialog.test-utils";

describe("DialogBoundary (behavioral mock)", () => {
  let dialogLayer: BehavioralDialogBoundary;

  beforeEach(() => {
    dialogLayer = createBehavioralDialogBoundary();
  });

  describe("showDialog", () => {
    it("returns canceled by default", async () => {
      const result = await dialogLayer.showDialog({ properties: ["openDirectory"] });

      expect(result.canceled).toBe(true);
      expect(result.filePaths).toHaveLength(0);
    });

    it("returns configured response when set", async () => {
      dialogLayer._setNextOpenDialogResponse({
        canceled: false,
        filePaths: ["/path/to/folder"],
      });

      const result = await dialogLayer.showDialog({ properties: ["openDirectory"] });

      expect(result.canceled).toBe(false);
      expect(result.filePaths).toHaveLength(1);
      expect(result.filePaths[0]?.toString()).toBe("/path/to/folder");
    });

    it("returns Path objects for file paths", async () => {
      dialogLayer._setNextOpenDialogResponse({
        canceled: false,
        filePaths: ["/home/user/documents"],
      });

      const result = await dialogLayer.showDialog({ properties: ["openDirectory"] });

      // Verify it's a Path object with expected methods
      const path = result.filePaths[0];
      expect(path?.toString()).toBe("/home/user/documents");
      expect(path?.basename).toBe("documents");
    });

    it("records call in state", async () => {
      const options = { title: "Select Folder", properties: ["openDirectory"] as const };
      await dialogLayer.showDialog(options);

      const state = dialogLayer._getState();
      expect(state.openDialogCount).toBe(1);
      expect(state.calls).toHaveLength(1);
      expect(state.calls[0]).toEqual({
        method: "showDialog",
        options,
      });
    });

    it("configured response is used once then resets", async () => {
      dialogLayer._setNextOpenDialogResponse({
        canceled: false,
        filePaths: ["/first/path"],
      });

      const first = await dialogLayer.showDialog({ properties: ["openFile"] });
      const second = await dialogLayer.showDialog({ properties: ["openFile"] });

      expect(first.canceled).toBe(false);
      expect(second.canceled).toBe(true); // Back to default
    });

    it("supports multiple file paths", async () => {
      dialogLayer._setNextOpenDialogResponse({
        canceled: false,
        filePaths: ["/path/a", "/path/b", "/path/c"],
      });

      const result = await dialogLayer.showDialog({ properties: ["multiSelections"] });

      expect(result.filePaths).toHaveLength(3);
      expect(result.filePaths.map((p) => p.toString())).toEqual(["/path/a", "/path/b", "/path/c"]);
    });

    it("records the save mode and returns the chosen path", async () => {
      dialogLayer._setNextOpenDialogResponse({
        canceled: false,
        filePaths: ["/new/template.liquid"],
      });

      const options = {
        mode: "save" as const,
        filters: [{ name: "Liquid", extensions: ["liquid"] }],
      };
      const result = await dialogLayer.showDialog(options);

      expect(result.canceled).toBe(false);
      expect(result.filePaths).toHaveLength(1);
      expect(result.filePaths[0]?.toString()).toBe("/new/template.liquid");
      expect(dialogLayer._getState().calls[0]).toEqual({ method: "showDialog", options });
    });
  });

  describe("showMessageBox", () => {
    it("returns button index 0 by default", async () => {
      const result = await dialogLayer.showMessageBox({
        message: "Are you sure?",
        buttons: ["OK", "Cancel"],
      });

      expect(result.response).toBe(0);
      expect(result.checkboxChecked).toBe(false);
    });

    it("returns configured response when set", async () => {
      dialogLayer._setNextMessageBoxResponse({
        response: 1,
        checkboxChecked: true,
      });

      const result = await dialogLayer.showMessageBox({
        message: "Continue?",
        buttons: ["Yes", "No"],
      });

      expect(result.response).toBe(1);
      expect(result.checkboxChecked).toBe(true);
    });

    it("records call in state", async () => {
      const options = {
        type: "question" as const,
        title: "Confirm",
        message: "Delete this file?",
        buttons: ["Yes", "No"],
      };
      await dialogLayer.showMessageBox(options);

      const state = dialogLayer._getState();
      expect(state.messageBoxCount).toBe(1);
      expect(state.calls[0]).toEqual({
        method: "showMessageBox",
        options,
      });
    });
  });

  describe("showErrorBox", () => {
    it("records call in state", () => {
      dialogLayer.showErrorBox("Error", "Something went wrong");

      const state = dialogLayer._getState();
      expect(state.errorBoxCount).toBe(1);
      expect(state.calls[0]).toEqual({
        method: "showErrorBox",
        title: "Error",
        content: "Something went wrong",
      });
    });

    it("is synchronous (no return value)", () => {
      const result = dialogLayer.showErrorBox("Title", "Content");
      expect(result).toBeUndefined();
    });
  });

  describe("_getState", () => {
    it("tracks all call types", async () => {
      await dialogLayer.showDialog({ properties: ["openFile"] });
      await dialogLayer.showMessageBox({ message: "Hello" });
      dialogLayer.showErrorBox("Error", "Details");

      const state = dialogLayer._getState();
      expect(state.openDialogCount).toBe(1);
      expect(state.messageBoxCount).toBe(1);
      expect(state.errorBoxCount).toBe(1);
      expect(state.calls).toHaveLength(3);
    });

    it("returns copies of arrays (not mutable references)", async () => {
      await dialogLayer.showDialog({ properties: ["openFile"] });

      const state1 = dialogLayer._getState();
      await dialogLayer.showDialog({ properties: ["openDirectory"] });
      const state2 = dialogLayer._getState();

      // state1 should not have been modified
      expect(state1.calls).toHaveLength(1);
      expect(state2.calls).toHaveLength(2);
    });
  });

  describe("_reset", () => {
    it("clears all state", async () => {
      dialogLayer._setNextOpenDialogResponse({ canceled: false, filePaths: ["/path"] });
      await dialogLayer.showDialog({ properties: ["openFile"] });
      dialogLayer.showErrorBox("Error", "Details");

      dialogLayer._reset();

      const state = dialogLayer._getState();
      expect(state.calls).toHaveLength(0);
      expect(state.openDialogCount).toBe(0);
      expect(state.errorBoxCount).toBe(0);
    });

    it("clears pending responses", async () => {
      dialogLayer._setNextOpenDialogResponse({ canceled: false, filePaths: ["/path"] });
      dialogLayer._reset();

      const result = await dialogLayer.showDialog({ properties: ["openFile"] });
      expect(result.canceled).toBe(true); // Default, not the configured response
    });
  });
});
