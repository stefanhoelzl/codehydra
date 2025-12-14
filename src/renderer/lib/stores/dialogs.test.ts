/**
 * Tests for the dialog state store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dialogState,
  openCreateDialog,
  openRemoveDialog,
  closeDialog,
  reset,
} from "./dialogs.svelte.js";

describe("dialog state store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  afterEach(() => {
    // Clean up any test elements
    document.body.innerHTML = "";
  });

  describe("initial state", () => {
    it("initializes with type 'closed'", () => {
      expect(dialogState.value).toEqual({ type: "closed" });
    });
  });

  describe("openCreateDialog", () => {
    it("sets type to 'create' with projectPath", () => {
      openCreateDialog("/test/project");

      expect(dialogState.value).toEqual({
        type: "create",
        projectPath: "/test/project",
      });
    });
  });

  describe("openRemoveDialog", () => {
    it("sets type to 'remove' with workspacePath", () => {
      openRemoveDialog("/test/project/.worktrees/ws1");

      expect(dialogState.value).toEqual({
        type: "remove",
        workspacePath: "/test/project/.worktrees/ws1",
      });
    });
  });

  describe("closeDialog", () => {
    it("sets type to 'closed'", () => {
      openCreateDialog("/test/project");
      closeDialog();

      expect(dialogState.value).toEqual({ type: "closed" });
    });
  });

  describe("opening new dialog closes previous (exclusive)", () => {
    it("opening create dialog after remove closes remove", () => {
      openRemoveDialog("/test/workspace");
      expect(dialogState.value.type).toBe("remove");

      openCreateDialog("/test/project");
      expect(dialogState.value.type).toBe("create");
    });

    it("opening remove dialog after create closes create", () => {
      openCreateDialog("/test/project");
      expect(dialogState.value.type).toBe("create");

      openRemoveDialog("/test/workspace");
      expect(dialogState.value.type).toBe("remove");
    });
  });
});
