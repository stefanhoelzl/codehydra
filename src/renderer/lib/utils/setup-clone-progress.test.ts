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
type CloneFailedHandler = (payload: { reason: string }) => void;

function createMockApi(): {
  api: CloneProgressApi;
  emitProgress: (progress: CloneProgress) => void;
  emitFailed: (reason: string) => void;
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
    emitFailed: (reason) => failedHandler?.({ reason }),
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

    // Start a clone first so the store accepts updates
    cloneStore.startClone("https://github.com/org/repo.git");

    setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo" });

    const state = cloneStore.cloneState.value;
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.5);
    expect(state?.name).toBe("repo");
  });

  it("updates store with successive progress events", () => {
    const { api, emitProgress } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    setupCloneProgress(api);

    emitProgress({ stage: "counting", progress: 0.1, name: "repo" });
    emitProgress({ stage: "receiving", progress: 0.75, name: "repo" });

    const state = cloneStore.cloneState.value;
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.75);
  });

  it("clears clone state when clone-failed event is emitted", () => {
    const { api, emitFailed } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    setupCloneProgress(api);

    expect(cloneStore.cloneState.value).not.toBeNull();

    emitFailed("Connection refused");

    expect(cloneStore.cloneState.value).toBeNull();
  });

  it("cleanup stops progress updates", () => {
    const { api, emitProgress, unsubscribeProgressCalled } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    const cleanup = setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo" });
    expect(cloneStore.cloneState.value?.stage).toBe("receiving");

    cleanup();

    expect(unsubscribeProgressCalled()).toBe(true);

    // Emit after cleanup - should not update store
    emitProgress({ stage: "resolving", progress: 0.8, name: "repo" });
    expect(cloneStore.cloneState.value?.stage).toBe("receiving");
  });

  it("cleanup stops failed updates", () => {
    const { api, emitFailed, unsubscribeFailedCalled } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    const cleanup = setupCloneProgress(api);

    cleanup();

    expect(unsubscribeFailedCalled()).toBe(true);

    // Emit after cleanup - should not clear store
    emitFailed("Connection refused");
    expect(cloneStore.cloneState.value).not.toBeNull();
  });

  it("does not update store when no clone is active", () => {
    const { api, emitProgress } = createMockApi();

    // Don't call startClone
    setupCloneProgress(api);

    emitProgress({ stage: "receiving", progress: 0.5, name: "repo" });

    expect(cloneStore.cloneState.value).toBeNull();
  });
});
