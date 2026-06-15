/**
 * Initialize the application: connect, then set focus.
 *
 * Subscribes to ui:state, emits the `ui-connected` event (which triggers
 * app:ready → project restore → app:started → the genesis snapshot), and
 * focuses the first control once the genesis snapshot has rendered.
 */
import { tick } from "svelte";
import { setUiState } from "$lib/stores/ui-state.svelte.js";
import { getFocusables } from "$lib/utils/focus-trap";
import type { UiState } from "@shared/ui-state";
import type { Unsubscribe } from "@shared/electron-api";
import * as api from "$lib/api";

export interface InitializeAppOptions {
  /** Container element for focus management */
  containerRef: HTMLElement | undefined;
}

export interface InitializeAppApi {
  onState(callback: (state: UiState) => void): Unsubscribe;
  /** Emit the `ui-connected` startup handshake (fire-and-forget). */
  emitConnected(): void;
}

const defaultApi: InitializeAppApi = {
  onState: api.onState,
  emitConnected: () => api.emitEvent({ kind: "ui-connected" }),
};

/**
 * Initialize the application.
 *
 * 1. Subscribe to ui:state snapshots. MUST happen before emitting
 *    `ui-connected`: the genesis push is emitted by the app:ready operation
 *    that ui-connected triggers, and there is no replay — a listener
 *    registered later misses it.
 * 2. Emit `ui-connected` (fire-and-forget) — main loads projects and opens
 *    the snapshot stream; the genesis snapshot arrives on ui:state.
 * 3. Focus the first focusable element once the genesis snapshot has rendered.
 */
export async function initializeApp(
  options: InitializeAppOptions,
  apiImpl: InitializeAppApi = defaultApi
): Promise<() => void> {
  const { containerRef } = options;

  // Focus the first control once, after the genesis snapshot has rendered
  // (there is no ready() promise to await — the snapshot is the signal).
  let focused = false;
  const unsubscribeState: Unsubscribe = apiImpl.onState((state) => {
    setUiState(state);
    if (focused) return;
    focused = true;
    void tick().then(() => {
      const firstFocusable = containerRef ? getFocusables(containerRef)[0] : undefined;
      firstFocusable?.focus();
    });
  });

  // Subscription is in place; signal main to start the snapshot stream.
  apiImpl.emitConnected();

  return () => {
    unsubscribeState();
  };
}
