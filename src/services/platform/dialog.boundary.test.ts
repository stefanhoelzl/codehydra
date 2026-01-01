/**
 * Boundary tests for DefaultDialogLayer against real Electron dialog.
 *
 * These tests verify that DefaultDialogLayer correctly wraps Electron's dialog module.
 * Note: Dialog methods require user interaction, so we only test that they don't crash.
 * Run with: npm run test:boundary
 */

// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DefaultDialogLayer } from "./dialog";
import { SILENT_LOGGER } from "../logging";

/**
 * Check if we're running in an Electron environment.
 * Boundary tests run within Electron, regular tests don't.
 */
const isElectronEnvironment = typeof process !== "undefined" && !!process.versions?.electron;

describe.skipIf(!isElectronEnvironment)("DefaultDialogLayer (boundary)", () => {
  let dialogLayer: DefaultDialogLayer;

  beforeEach(() => {
    dialogLayer = new DefaultDialogLayer(SILENT_LOGGER);
  });

  describe("showOpenDialog", () => {
    // Note: Actually showing a dialog would require user interaction.
    // We test with minimal options to verify the API is callable.
    // The dialog will immediately return as canceled since there's no user interaction.
    it("is callable with minimal options", async () => {
      const result = await dialogLayer.showOpenDialog({
        properties: ["openDirectory"],
      });

      // Dialog returns canceled when there's no user interaction
      expect(result).toHaveProperty("canceled");
      expect(result).toHaveProperty("filePaths");
      expect(Array.isArray(result.filePaths)).toBe(true);
    });

    it("is callable with full options", async () => {
      const result = await dialogLayer.showOpenDialog({
        title: "Test Dialog",
        buttonLabel: "Select",
        properties: ["openFile", "showHiddenFiles"],
        filters: [{ name: "All Files", extensions: ["*"] }],
      });

      expect(result).toHaveProperty("canceled");
      expect(result).toHaveProperty("filePaths");
    });
  });

  describe("showMessageBox", () => {
    // Note: Message boxes in test environments typically auto-dismiss or return default response.
    it("is callable with minimal options", async () => {
      const result = await dialogLayer.showMessageBox({
        message: "Test message",
      });

      expect(result).toHaveProperty("response");
      expect(typeof result.response).toBe("number");
      expect(result).toHaveProperty("checkboxChecked");
      expect(typeof result.checkboxChecked).toBe("boolean");
    });

    it("is callable with full options", async () => {
      const result = await dialogLayer.showMessageBox({
        type: "info",
        title: "Test Title",
        message: "Test message",
        detail: "Test detail",
        buttons: ["OK", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });

      expect(result).toHaveProperty("response");
      expect(typeof result.response).toBe("number");
    });
  });

  describe("showErrorBox", () => {
    // Note: showErrorBox is synchronous and blocking.
    // We can only verify it doesn't throw.
    it("is callable without throwing", () => {
      // This will show a blocking error dialog in a real Electron environment
      // In boundary tests, we verify it doesn't crash
      expect(() => {
        dialogLayer.showErrorBox("Test Error", "This is a test error message");
      }).not.toThrow();
    });
  });

  describe("showSaveDialog", () => {
    it("is callable with minimal options", async () => {
      const result = await dialogLayer.showSaveDialog({});

      expect(result).toHaveProperty("canceled");
      expect(result).toHaveProperty("filePath");
    });

    it("is callable with full options", async () => {
      const result = await dialogLayer.showSaveDialog({
        title: "Save Test",
        buttonLabel: "Save",
        defaultPath: "test.txt",
        filters: [{ name: "Text Files", extensions: ["txt"] }],
      });

      expect(result).toHaveProperty("canceled");
    });
  });
});
