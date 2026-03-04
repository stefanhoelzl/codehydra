/**
 * Tests for clone-progress state store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  startClone,
  updateCloneProgress,
  completeClone,
  stageLabel,
  getClone,
  activeClones,
  hasActiveClones,
  reset,
} from "./clone-progress.svelte";

describe("clone-progress store", () => {
  beforeEach(() => {
    reset();
  });

  describe("startClone", () => {
    it("initializes clone state with url and defaults", () => {
      startClone("https://github.com/org/repo.git");

      const state = getClone("https://github.com/org/repo.git");
      expect(state).toEqual({
        url: "https://github.com/org/repo.git",
        name: "",
        stage: null,
        progress: 0,
      });
    });

    it("allows multiple concurrent clones", () => {
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      expect(getClone("https://github.com/org/repo1.git")).toBeDefined();
      expect(getClone("https://github.com/org/repo2.git")).toBeDefined();
      expect(activeClones.value).toHaveLength(2);
    });

    it("replaces existing clone with same URL", () => {
      startClone("https://github.com/org/repo.git");
      updateCloneProgress("https://github.com/org/repo.git", "receiving", 0.5, "repo");

      startClone("https://github.com/org/repo.git");

      const state = getClone("https://github.com/org/repo.git");
      expect(state?.progress).toBe(0);
      expect(state?.stage).toBeNull();
    });
  });

  describe("updateCloneProgress", () => {
    it("updates stage, progress, and name for matching URL", () => {
      startClone("https://github.com/org/repo.git");

      updateCloneProgress("https://github.com/org/repo.git", "receiving", 0.5, "repo");

      const state = getClone("https://github.com/org/repo.git");
      expect(state?.stage).toBe("receiving");
      expect(state?.progress).toBe(0.5);
      expect(state?.name).toBe("repo");
    });

    it("is a no-op when URL is not tracked", () => {
      updateCloneProgress("https://github.com/org/repo.git", "receiving", 0.5, "repo");

      expect(getClone("https://github.com/org/repo.git")).toBeUndefined();
      expect(hasActiveClones.value).toBe(false);
    });

    it("only updates the matching clone", () => {
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      updateCloneProgress("https://github.com/org/repo1.git", "receiving", 0.5, "repo1");

      expect(getClone("https://github.com/org/repo1.git")?.progress).toBe(0.5);
      expect(getClone("https://github.com/org/repo2.git")?.progress).toBe(0);
    });
  });

  describe("completeClone", () => {
    it("removes the clone entry for the given URL", () => {
      startClone("https://github.com/org/repo.git");

      completeClone("https://github.com/org/repo.git");

      expect(getClone("https://github.com/org/repo.git")).toBeUndefined();
      expect(hasActiveClones.value).toBe(false);
    });

    it("only removes the matching clone", () => {
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      completeClone("https://github.com/org/repo1.git");

      expect(getClone("https://github.com/org/repo1.git")).toBeUndefined();
      expect(getClone("https://github.com/org/repo2.git")).toBeDefined();
      expect(activeClones.value).toHaveLength(1);
    });

    it("is a no-op when URL is not tracked", () => {
      completeClone("https://github.com/org/repo.git");
      expect(hasActiveClones.value).toBe(false);
    });
  });

  describe("getClone", () => {
    it("returns undefined for unknown URL", () => {
      expect(getClone("https://github.com/org/repo.git")).toBeUndefined();
    });

    it("returns clone state for tracked URL", () => {
      startClone("https://github.com/org/repo.git");
      updateCloneProgress("https://github.com/org/repo.git", "receiving", 0.75, "repo");

      const state = getClone("https://github.com/org/repo.git");
      expect(state?.url).toBe("https://github.com/org/repo.git");
      expect(state?.progress).toBe(0.75);
    });
  });

  describe("activeClones", () => {
    it("returns empty array when no clones", () => {
      expect(activeClones.value).toEqual([]);
    });

    it("returns all active clones", () => {
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      const clones = activeClones.value;
      expect(clones).toHaveLength(2);
      const urls = clones.map((c) => c.url);
      expect(urls).toContain("https://github.com/org/repo1.git");
      expect(urls).toContain("https://github.com/org/repo2.git");
    });
  });

  describe("hasActiveClones", () => {
    it("returns false when no clones", () => {
      expect(hasActiveClones.value).toBe(false);
    });

    it("returns true when clones are active", () => {
      startClone("https://github.com/org/repo.git");
      expect(hasActiveClones.value).toBe(true);
    });

    it("returns false after all clones complete", () => {
      startClone("https://github.com/org/repo.git");
      completeClone("https://github.com/org/repo.git");
      expect(hasActiveClones.value).toBe(false);
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
      startClone("https://github.com/org/repo1.git");
      startClone("https://github.com/org/repo2.git");

      reset();

      expect(hasActiveClones.value).toBe(false);
      expect(activeClones.value).toEqual([]);
    });
  });
});
