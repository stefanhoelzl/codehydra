/**
 * Tests for the dialog state store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dialogState,
  triggerElementId,
  openCreateDialog,
  openRemoveDialog,
  closeDialog,
  getTriggerElement,
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

    it("initializes with triggerElementId null", () => {
      expect(triggerElementId.value).toBeNull();
    });
  });

  describe("openCreateDialog", () => {
    it("sets type to 'create' with projectPath", () => {
      openCreateDialog("/test/project", "trigger-btn");

      expect(dialogState.value).toEqual({
        type: "create",
        projectPath: "/test/project",
      });
    });

    it("stores triggerElementId", () => {
      openCreateDialog("/test/project", "my-trigger");

      expect(triggerElementId.value).toBe("my-trigger");
    });

    it("works with null triggerElementId", () => {
      openCreateDialog("/test/project", null);

      expect(dialogState.value.type).toBe("create");
      expect(triggerElementId.value).toBeNull();
    });
  });

  describe("openRemoveDialog", () => {
    it("sets type to 'remove' with workspacePath", () => {
      openRemoveDialog("/test/project/.worktrees/ws1", "trigger-btn");

      expect(dialogState.value).toEqual({
        type: "remove",
        workspacePath: "/test/project/.worktrees/ws1",
      });
    });

    it("stores triggerElementId", () => {
      openRemoveDialog("/test/workspace", "remove-trigger");

      expect(triggerElementId.value).toBe("remove-trigger");
    });
  });

  describe("closeDialog", () => {
    it("sets type to 'closed'", () => {
      openCreateDialog("/test/project", "trigger");
      closeDialog();

      expect(dialogState.value).toEqual({ type: "closed" });
    });

    it("clears triggerElementId", () => {
      openCreateDialog("/test/project", "trigger");
      closeDialog();

      expect(triggerElementId.value).toBeNull();
    });
  });

  describe("opening new dialog closes previous (exclusive)", () => {
    it("opening create dialog after remove closes remove", () => {
      openRemoveDialog("/test/workspace", "remove-trigger");
      expect(dialogState.value.type).toBe("remove");

      openCreateDialog("/test/project", "create-trigger");
      expect(dialogState.value.type).toBe("create");
    });

    it("opening remove dialog after create closes create", () => {
      openCreateDialog("/test/project", "create-trigger");
      expect(dialogState.value.type).toBe("create");

      openRemoveDialog("/test/workspace", "remove-trigger");
      expect(dialogState.value.type).toBe("remove");
    });
  });

  describe("getTriggerElement", () => {
    it("returns element by ID when exists", () => {
      const button = document.createElement("button");
      button.id = "my-trigger-button";
      document.body.appendChild(button);

      openCreateDialog("/test/project", "my-trigger-button");

      const element = getTriggerElement();
      expect(element).toBe(button);
    });

    it("returns null if triggerElementId is null", () => {
      openCreateDialog("/test/project", null);

      const element = getTriggerElement();
      expect(element).toBeNull();
    });

    it("returns null if element does not exist", () => {
      openCreateDialog("/test/project", "nonexistent-element");

      const element = getTriggerElement();
      expect(element).toBeNull();
    });
  });
});
