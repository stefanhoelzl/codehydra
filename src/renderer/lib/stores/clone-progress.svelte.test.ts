/**
 * Tests for clone-progress state store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  startClone,
  updateCloneProgress,
  completeClone,
  failClone,
  clearClone,
  stageLabel,
  cloneState,
  reset,
} from "./clone-progress.svelte";

describe("clone-progress store", () => {
  beforeEach(() => {
    reset();
  });

  describe("startClone", () => {
    it("initializes clone state with url and defaults", () => {
      startClone("https://github.com/org/repo.git");

      const state = cloneState.value;
      expect(state).toEqual({
        url: "https://github.com/org/repo.git",
        name: "",
        stage: null,
        progress: 0,
        error: null,
      });
    });

    it("replaces existing clone state", () => {
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      expect(cloneState.value?.url).toBe("https://github.com/org/repo2.git");
    });
  });

  describe("updateCloneProgress", () => {
    it("updates stage, progress, and name", () => {
      startClone("https://github.com/org/repo.git");

      updateCloneProgress("receiving", 0.5, "repo");

      const state = cloneState.value;
      expect(state?.stage).toBe("receiving");
      expect(state?.progress).toBe(0.5);
      expect(state?.name).toBe("repo");
    });

    it("is a no-op when no clone is active", () => {
      updateCloneProgress("receiving", 0.5, "repo");

      expect(cloneState.value).toBeNull();
    });

    it("preserves url and error fields", () => {
      startClone("https://github.com/org/repo.git");
      updateCloneProgress("receiving", 0.5, "repo");

      expect(cloneState.value?.url).toBe("https://github.com/org/repo.git");
      expect(cloneState.value?.error).toBeNull();
    });
  });

  describe("completeClone", () => {
    it("clears clone state", () => {
      startClone("https://github.com/org/repo.git");
      updateCloneProgress("receiving", 1, "repo");

      completeClone();

      expect(cloneState.value).toBeNull();
    });

    it("is a no-op when no clone is active", () => {
      completeClone();
      expect(cloneState.value).toBeNull();
    });
  });

  describe("failClone", () => {
    it("sets error on clone state", () => {
      startClone("https://github.com/org/repo.git");

      failClone("Connection refused");

      expect(cloneState.value?.error).toBe("Connection refused");
      expect(cloneState.value?.url).toBe("https://github.com/org/repo.git");
    });

    it("is a no-op when no clone is active", () => {
      failClone("Connection refused");
      expect(cloneState.value).toBeNull();
    });
  });

  describe("clearClone", () => {
    it("removes clone state entirely", () => {
      startClone("https://github.com/org/repo.git");
      failClone("Connection refused");

      clearClone();

      expect(cloneState.value).toBeNull();
    });

    it("is a no-op when no clone is active", () => {
      clearClone();
      expect(cloneState.value).toBeNull();
    });
  });

  describe("stageLabel", () => {
    it("returns human-readable labels for known stages", () => {
      expect(stageLabel("receiving")).toBe("Receiving objects...");
      expect(stageLabel("resolving")).toBe("Resolving deltas...");
      expect(stageLabel("counting")).toBe("Counting objects...");
      expect(stageLabel("compressing")).toBe("Compressing objects...");
    });

    it("capitalizes and appends ellipsis for unknown stages", () => {
      expect(stageLabel("uploading")).toBe("Uploading...");
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      startClone("https://github.com/org/repo.git");
      updateCloneProgress("receiving", 0.5, "repo");

      reset();

      expect(cloneState.value).toBeNull();
    });
  });
});
