/**
 * Tests for setupCloneProgress setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CloneProgress } from "@shared/api/types";

// Mock the API module before importing the setup function
vi.mock("$lib/api", () => ({
  on: vi.fn(() => vi.fn()),
}));

import { setupCloneProgress, type CloneProgressApi } from "./setup-clone-progress";
import * as cloneStore from "$lib/stores/clone-progress.svelte.js";

// =============================================================================
// Mock API Factory
// =============================================================================

type CloneProgressHandler = (payload: CloneProgress) => void;
type CloneFailedHandler = (payload: { reason: string; url?: string }) => void;

function createMockApi(): {
  api: CloneProgressApi;
  emitProgress: (progress: CloneProgress) => void;
  emitFailed: (reason: string, url?: string) => void;
  unsubscribeProgressCalled: () => boolean;
  unsubscribeFailedCalled: () => boolean;
} {
  let progressHandler: CloneProgressHandler | undefined;
  let failedHandler: CloneFailedHandler | undefined;
  let progressUnsubscribed = false;
  let failedUnsubscribed = false;

  const api: CloneProgressApi = {
    on: ((event: string, h: (...args: never[]) => void) => {
      if (event === "project:clone-progress") {
        progressHandler = h as CloneProgressHandler;
        return () => {
          progressHandler = undefined;
          progressUnsubscribed = true;
        };
      }
      if (event === "project:clone-failed") {
        failedHandler = h as CloneFailedHandler;
        return () => {
          failedHandler = undefined;
          failedUnsubscribed = true;
        };
      }
      return () => {};
    }) as CloneProgressApi["on"],
  };

  return {
    api,
    emitProgress: (progress) => progressHandler?.(progress),
    emitFailed: (reason, url) => failedHandler?.(url !== undefined ? { reason, url } : { reason }),
    unsubscribeProgressCalled: () => progressUnsubscribed,
    unsubscribeFailedCalled: () => failedUnsubscribed,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("setupCloneProgress", () => {
  beforeEach(() => {
    cloneStore.reset();
  });

  afterEach(() => {
    cloneStore.reset();
  });

  it("updates store when clone progress event is emitted", () => {
    const { api, emitProgress } = createMockApi();
    const url = "https://github.com/org/repo.git";

    // Start a clone first so the store accepts updates
    cloneStore.startClone(url);

    setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo", url });

    const state = cloneStore.getClone(url);
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.5);
    expect(state?.name).toBe("repo");
  });

  it("updates store with successive progress events", () => {
    const { api, emitProgress } = createMockApi();
    const url = "https://github.com/org/repo.git";

    cloneStore.startClone(url);
    setupCloneProgress(api);

    emitProgress({ stage: "counting", progress: 0.1, name: "repo", url });
    emitProgress({ stage: "receiving", progress: 0.75, name: "repo", url });

    const state = cloneStore.getClone(url);
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.75);
  });

  it("routes progress to the correct clone by URL", () => {
    const { api, emitProgress } = createMockApi();
    const url1 = "https://github.com/org/repo1.git";
    const url2 = "https://github.com/org/repo2.git";

    cloneStore.startClone(url1);
    cloneStore.startClone(url2);
    setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.3, name: "repo1", url: url1 });
    emitProgress({ stage: "counting", progress: 0.8, name: "repo2", url: url2 });

    expect(cloneStore.getClone(url1)?.progress).toBe(0.3);
    expect(cloneStore.getClone(url1)?.stage).toBe("receiving");
    expect(cloneStore.getClone(url2)?.progress).toBe(0.8);
    expect(cloneStore.getClone(url2)?.stage).toBe("counting");
  });

  it("clears correct clone when clone-failed event with URL is emitted", () => {
    const { api, emitFailed } = createMockApi();
    const url1 = "https://github.com/org/repo1.git";
    const url2 = "https://github.com/org/repo2.git";

    cloneStore.startClone(url1);
    cloneStore.startClone(url2);
    setupCloneProgress(api);

    emitFailed("Connection refused", url1);

    expect(cloneStore.getClone(url1)).toBeUndefined();
    expect(cloneStore.getClone(url2)).toBeDefined();
  });

  it("does not clear any clone when clone-failed event has no URL", () => {
    const { api, emitFailed } = createMockApi();
    const url = "https://github.com/org/repo.git";

    cloneStore.startClone(url);
    setupCloneProgress(api);

    emitFailed("Connection refused");

    // Without URL, no clone should be cleared
    expect(cloneStore.getClone(url)).toBeDefined();
  });

  it("cleanup stops progress updates", () => {
    const { api, emitProgress, unsubscribeProgressCalled } = createMockApi();
    const url = "https://github.com/org/repo.git";

    cloneStore.startClone(url);
    const cleanup = setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo", url });
    expect(cloneStore.getClone(url)?.stage).toBe("receiving");

    cleanup();

    expect(unsubscribeProgressCalled()).toBe(true);

    // Emit after cleanup - should not update store
    emitProgress({ stage: "resolving", progress: 0.8, name: "repo", url });
    expect(cloneStore.getClone(url)?.stage).toBe("receiving");
  });

  it("cleanup stops failed updates", () => {
    const { api, emitFailed, unsubscribeFailedCalled } = createMockApi();
    const url = "https://github.com/org/repo.git";

    cloneStore.startClone(url);
    const cleanup = setupCloneProgress(api);

    cleanup();

    expect(unsubscribeFailedCalled()).toBe(true);

    // Emit after cleanup - should not clear store
    emitFailed("Connection refused", url);
    expect(cloneStore.getClone(url)).toBeDefined();
  });

  it("does not update store when URL is not tracked", () => {
    const { api, emitProgress } = createMockApi();
    const url = "https://github.com/org/repo.git";

    // Don't call startClone
    setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo", url });

    expect(cloneStore.getClone(url)).toBeUndefined();
    expect(cloneStore.hasActiveClones.value).toBe(false);
  });
});
