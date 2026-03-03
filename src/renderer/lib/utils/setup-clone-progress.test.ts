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

function createMockApi(): {
  api: CloneProgressApi;
  emit: (progress: CloneProgress) => void;
  unsubscribeCalled: () => boolean;
} {
  let handler: CloneProgressHandler | undefined;
  let unsubscribed = false;

  const api: CloneProgressApi = {
    on: (_event: "project:clone-progress", h: CloneProgressHandler) => {
      handler = h;
      return () => {
        handler = undefined;
        unsubscribed = true;
      };
    },
  };

  const emit = (progress: CloneProgress): void => {
    handler?.(progress);
  };

  return { api, emit, unsubscribeCalled: () => unsubscribed };
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
    const { api, emit } = createMockApi();

    // Start a clone first so the store accepts updates
    cloneStore.startClone("https://github.com/org/repo.git");

    setupCloneProgress(api);

    emit({ stage: "receiving", progress: 0.5, name: "repo" });

    const state = cloneStore.cloneState.value;
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.5);
    expect(state?.name).toBe("repo");
  });

  it("updates store with successive progress events", () => {
    const { api, emit } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    setupCloneProgress(api);

    emit({ stage: "counting", progress: 0.1, name: "repo" });
    emit({ stage: "receiving", progress: 0.75, name: "repo" });

    const state = cloneStore.cloneState.value;
    expect(state?.stage).toBe("receiving");
    expect(state?.progress).toBe(0.75);
  });

  it("cleanup stops updates", () => {
    const { api, emit, unsubscribeCalled } = createMockApi();

    cloneStore.startClone("https://github.com/org/repo.git");
    const cleanup = setupCloneProgress(api);

    emit({ stage: "receiving", progress: 0.5, name: "repo" });
    expect(cloneStore.cloneState.value?.stage).toBe("receiving");

    cleanup();

    expect(unsubscribeCalled()).toBe(true);

    // Emit after cleanup - should not update store
    emit({ stage: "resolving", progress: 0.8, name: "repo" });
    expect(cloneStore.cloneState.value?.stage).toBe("receiving");
  });

  it("does not update store when no clone is active", () => {
    const { api, emit } = createMockApi();

    // Don't call startClone
    setupCloneProgress(api);

    emit({ stage: "receiving", progress: 0.5, name: "repo" });

    expect(cloneStore.cloneState.value).toBeNull();
  });
});
