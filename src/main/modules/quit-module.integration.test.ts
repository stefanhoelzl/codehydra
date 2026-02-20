// @vitest-environment node
/**
 * Integration tests for QuitModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> AppShutdownOperation -> quit hook -> app.quit()
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";

import { AppShutdownOperation, INTENT_APP_SHUTDOWN } from "../operations/app-shutdown";
import type { AppShutdownIntent } from "../operations/app-shutdown";
import { createQuitModule } from "./quit-module";

// =============================================================================
// Tests
// =============================================================================

describe("QuitModule Integration", () => {
  it("calls app.quit() when dispatching app:shutdown", async () => {
    const quit = vi.fn();

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_SHUTDOWN, new AppShutdownOperation());

    const module = createQuitModule({ app: { quit } });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_SHUTDOWN,
      payload: {},
    } as AppShutdownIntent);

    expect(quit).toHaveBeenCalledOnce();
  });
});
