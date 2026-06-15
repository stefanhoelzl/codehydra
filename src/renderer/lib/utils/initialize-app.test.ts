/**
 * Tests for initializeApp setup function.
 * Uses behavioral mocks that verify state changes, not call tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UiState } from "@shared/ui-state";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

vi.mock("$lib/api", () => ({
  onState: vi.fn(() => vi.fn()),
  emitEvent: vi.fn(),
}));

import { initializeApp, type InitializeAppApi, type InitializeAppOptions } from "./initialize-app";
import { uiState, resetUiState } from "$lib/stores/ui-state.svelte.js";

const TEST_SNAPSHOT: UiState = makeUiState([
  makeUiProjectRow([makeUiWorkspaceRow("feature-branch", { active: true })]),
]);

/** Let the post-snapshot focus microtask (tick().then(...)) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockApi(config?: { pushOnConnected?: UiState }): InitializeAppApi {
  let listener: ((state: UiState) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });

  return {
    onState: vi.fn((callback: (state: UiState) => void) => {
      listener = callback;
      return unsubscribe;
    }),
    // The genesis push is causally downstream of ui-connected (app:ready emits
    // app:started). Deliver it through whatever listener is registered — a
    // listener registered too late would miss it.
    emitConnected: vi.fn(() => {
      if (config?.pushOnConnected) listener?.(config.pushOnConnected);
    }),
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
    resetUiState();
  });

  afterEach(() => {
    resetUiState();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("snapshot subscription", () => {
    it("subscribes before emitting ui-connected so the genesis snapshot lands", async () => {
      const api = createMockApi({ pushOnConnected: TEST_SNAPSHOT });
      const options: InitializeAppOptions = { containerRef: undefined };

      await initializeApp(options, api);

      expect(api.onState).toHaveBeenCalledTimes(1);
      expect(api.emitConnected).toHaveBeenCalledTimes(1);
      expect(uiState.value).toEqual(TEST_SNAPSHOT);
    });
  });

  describe("focus management", () => {
    it("focuses vscode-button element after the genesis snapshot", async () => {
      const container = createMockContainer("vscode-button");
      const api = createMockApi({ pushOnConnected: TEST_SNAPSHOT });

      await initializeApp({ containerRef: container }, api);
      await flush();

      expect(document.activeElement?.tagName.toLowerCase()).toBe("vscode-button");
    });

    it("focuses native button element after the genesis snapshot", async () => {
      const container = createMockContainer("button");
      const api = createMockApi({ pushOnConnected: TEST_SNAPSHOT });

      await initializeApp({ containerRef: container }, api);
      await flush();

      expect(document.activeElement?.tagName.toLowerCase()).toBe("button");
    });

    it("focuses input element after the genesis snapshot", async () => {
      const container = createMockContainer("input");
      const api = createMockApi({ pushOnConnected: TEST_SNAPSHOT });

      await initializeApp({ containerRef: container }, api);
      await flush();

      expect(document.activeElement?.tagName.toLowerCase()).toBe("input");
    });

    it("does not focus before any snapshot arrives", async () => {
      const container = createMockContainer("button");
      const api = createMockApi(); // no genesis push

      await initializeApp({ containerRef: container }, api);
      await flush();

      expect(document.activeElement?.tagName.toLowerCase()).not.toBe("button");
    });

    it("handles missing container gracefully", async () => {
      const api = createMockApi({ pushOnConnected: TEST_SNAPSHOT });
      const options: InitializeAppOptions = { containerRef: undefined };

      await expect(initializeApp(options, api)).resolves.not.toThrow();
      await flush();
    });
  });

  describe("cleanup", () => {
    it("cleanup unsubscribes the snapshot listener", async () => {
      const unsubscribe = vi.fn();
      const api: InitializeAppApi = {
        onState: vi.fn(() => unsubscribe),
        emitConnected: vi.fn(),
      };

      const cleanup = await initializeApp({ containerRef: undefined }, api);
      cleanup();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
