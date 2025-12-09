/**
 * Tests for the setup state management store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  setupState,
  updateProgress,
  completeSetup,
  errorSetup,
  resetSetup,
  type SetupStateValue,
} from "./setup.svelte";

describe("setup store", () => {
  beforeEach(() => {
    resetSetup();
  });

  describe("initial state", () => {
    it("starts in loading state", () => {
      expect(setupState.value.type).toBe("loading");
    });
  });

  describe("updateProgress", () => {
    it("transitions to progress state with message", () => {
      updateProgress("Installing extensions...");

      expect(setupState.value.type).toBe("progress");
      expect((setupState.value as SetupStateValue & { type: "progress" }).message).toBe(
        "Installing extensions..."
      );
    });

    it("updates progress message when already in progress", () => {
      updateProgress("Step 1");
      updateProgress("Step 2");

      expect((setupState.value as SetupStateValue & { type: "progress" }).message).toBe("Step 2");
    });
  });

  describe("completeSetup", () => {
    it("transitions to complete state", () => {
      updateProgress("Working...");
      completeSetup();

      expect(setupState.value.type).toBe("complete");
    });
  });

  describe("errorSetup", () => {
    it("transitions to error state with message", () => {
      updateProgress("Working...");
      errorSetup("Network failure");

      expect(setupState.value.type).toBe("error");
      expect((setupState.value as SetupStateValue & { type: "error" }).errorMessage).toBe(
        "Network failure"
      );
    });
  });

  describe("resetSetup", () => {
    it("resets to loading state", () => {
      updateProgress("Working...");
      completeSetup();
      resetSetup();

      expect(setupState.value.type).toBe("loading");
    });
  });

  describe("state transitions", () => {
    it("allows loading -> progress -> complete", () => {
      expect(setupState.value.type).toBe("loading");

      updateProgress("Step 1");
      expect(setupState.value.type).toBe("progress");

      completeSetup();
      expect(setupState.value.type).toBe("complete");
    });

    it("allows loading -> progress -> error", () => {
      expect(setupState.value.type).toBe("loading");

      updateProgress("Step 1");
      expect(setupState.value.type).toBe("progress");

      errorSetup("Failed!");
      expect(setupState.value.type).toBe("error");
    });

    it("allows error -> progress (retry)", () => {
      errorSetup("Failed!");
      expect(setupState.value.type).toBe("error");

      updateProgress("Retrying...");
      expect(setupState.value.type).toBe("progress");
    });
  });
});
