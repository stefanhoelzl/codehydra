/**
 * Tests for initializeApp setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UiState } from "@shared/ui-state";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

vi.mock("$lib/api", () => ({
  lifecycle: { ready: vi.fn() },
  onState: vi.fn(() => vi.fn()),
}));

import { initializeApp, type InitializeAppApi, type InitializeAppOptions } from "./initialize-app";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import { uiState, resetUiState } from "$lib/stores/ui-state.svelte.js";

const TEST_SNAPSHOT: UiState = makeUiState([
  makeUiProjectRow([makeUiWorkspaceRow("feature-branch", { active: true })]),
]);

function createMockApi(config?: { readyError?: Error; pushOnReady?: UiState }): InitializeAppApi {
  let listener: ((state: UiState) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });

  return {
    onState: vi.fn((callback: (state: UiState) => void) => {
      listener = callback;
      return unsubscribe;
    }),
    lifecycle: {
      ready: vi.fn(async () => {
        if (config?.readyError) {
          throw config.readyError;
        }
        // The genesis push is causally downstream of ready() (app:ready emits
        // app:started). Deliver it through whatever listener is registered —
        // a listener registered too late would miss it.
        if (config?.pushOnReady) {
          listener?.(config.pushOnReady);
        }
        return { defaultAgent: null, availableAgents: [] };
      }),
    },
  };
}

function createMockContainer(focusableElement?: string): HTMLElement {
  const container = document.createElement("div");

  if (focusableElement === "vscode-button") {
    const button = document.createElement("vscode-button") as HTMLElement;
    button.setAttribute("tabindex", "0");
    container.appendChild(button);
  } else if (focusableElement === "button") {
    const button = document.createElement("button");
    container.appendChild(button);
  } else if (focusableElement === "input") {
    const input = document.createElement("input");
    container.appendChild(input);
  }

  document.body.appendChild(container);
  return container;
}

describe("initializeApp", () => {
  beforeEach(() => {
    bootstrapStore.resetBootstrap();
    resetUiState();
  });

  afterEach(() => {
    bootstrapStore.resetBootstrap();
    resetUiState();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("snapshot subscription", () => {
    it("subscribes before ready() so the genesis snapshot lands in the holder", async () => {
      const api = createMockApi({ pushOnReady: TEST_SNAPSHOT });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(uiState.value).toEqual(TEST_SNAPSHOT);
      expect(bootstrapStore.bootstrap.initialized).toBe(true);
    });

    it("keeps the subscription alive after ready() failures", async () => {
      const api = createMockApi({ readyError: new Error("ready failed") });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(bootstrapStore.bootstrap.initialized).toBe(false);
      // The listener registered before ready() is still wired.
      expect(api.onState).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus management", () => {
    it("focuses vscode-button element", async () => {
      const container = createMockContainer("vscode-button");
      const api = createMockApi();
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("vscode-button");
    });

    it("focuses native button element", async () => {
      const container = createMockContainer("button");
      const api = createMockApi();
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    });

    it("focuses input element", async () => {
      const container = createMockContainer("input");
      const api = createMockApi();
      const options: InitializeAppOptions = { containerRef: container };

      await initializeApp(options, api);

      expect(document.activeElement?.tagName.toLowerCase()).toBe("input");
    });

    it("handles missing container gracefully", async () => {
      const api = createMockApi();
      const options: InitializeAppOptions = { containerRef: undefined };

      await expect(initializeApp(options, api)).resolves.not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("cleanup unsubscribes the snapshot listener", async () => {
      const pushes: Array<(state: UiState) => void> = [];
      const unsubscribe = vi.fn();
      const api: InitializeAppApi = {
        onState: vi.fn((callback: (state: UiState) => void) => {
          pushes.push(callback);
          return unsubscribe;
        }),
        lifecycle: {
          ready: vi.fn(async () => ({ defaultAgent: null, availableAgents: [] })),
        },
      };
      const options: InitializeAppOptions = { containerRef: undefined };

      const cleanup = await initializeApp(options, api);
      cleanup();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
