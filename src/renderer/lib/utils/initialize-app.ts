/**
 * Initialize the application: signal ready, set focus.
 *
 * Calls lifecycle.ready() which unblocks the mount handler in app:start.
 * After mount completes, project:open dispatches fire and the renderer's
 * event bindings (set up before this function is called) populate the stores.
 */
import { tick } from "svelte";
import { setBootstrap } from "$lib/stores/bootstrap.svelte.js";
import { createLogger } from "$lib/logging";
import type { AgentInfo, LifecycleAgentType } from "@shared/ipc";
import * as api from "$lib/api";

const logger = createLogger("ui");

export interface InitializeAppOptions {
  /** Container element for focus management */
  containerRef: HTMLElement | undefined;
}

export interface InitializeAppApi {
  lifecycle: {
    ready(): Promise<{
      defaultAgent: LifecycleAgentType | null;
      availableAgents: readonly AgentInfo[];
    }>;
  };
}

/**
 * Focus selector that includes VSCode Elements components.
 * VSCode Elements are custom elements that should be focusable.
 */
const FOCUSABLE_SELECTOR = [
  'vscode-button:not([disabled]):not([tabindex="-1"])',
  'vscode-textfield:not([disabled]):not([tabindex="-1"])',
  'vscode-checkbox:not([disabled]):not([tabindex="-1"])',
  'vscode-dropdown:not([disabled]):not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const defaultApi: InitializeAppApi = {
  lifecycle: api.lifecycle,
};

/**
 * Initialize the application.
 *
 * 1. Call lifecycle.ready() — unblocks mount, project:open dispatches populate stores
 *    via domain events. Agent statuses arrive via the same event stream; the store
 *    falls back to "none" for any workspace not yet reported.
 * 2. Focus first focusable element (including VSCode Elements)
 */
export async function initializeApp(
  options: InitializeAppOptions,
  apiImpl: InitializeAppApi = defaultApi
): Promise<() => void> {
  const { containerRef } = options;

  try {
    const bootstrap = await apiImpl.lifecycle.ready();
    setBootstrap(bootstrap);

    await tick();
    const firstFocusable = containerRef?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
  } catch (err: unknown) {
    // lifecycle.ready() failure leaves bootstrap.initialized=false; the main
    // process's startup splash will fall through on its 10s timeout. Log so
    // the failure is visible in the renderer console.
    logger.error("Failed to initialize app", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return () => {};
}
