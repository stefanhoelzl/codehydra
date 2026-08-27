// @vitest-environment node
/**
 * Integration tests for the CLI module.
 *
 * Runs the module through a real dispatcher so the assertions cover the seam
 * `ch` actually depends on: what ends up in state.json after app:start, and what
 * the plugin server sees when it asks for the token.
 */

import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { createMockState } from "../boundaries/platform/state.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createCliModule, CLI_SCRIPTS } from "./cli-module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";

const INTENT_APP_START = "app:start";

/**
 * Drive the module's start hook with a given plugin port.
 *
 * The port arrives as a capability the plugin server provides, so the test
 * seeds it the same way the real operation would.
 */
async function startWith(pluginPort: number | null) {
  const state = createMockState();
  const handle = createCliModule({ stateService: state, logger: SILENT_LOGGER });

  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  dispatcher.registerModule(handle.module);
  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
      // The port reaches the hook as a capability the plugin server provides,
      // and as hook context; the module reads it from the context.
      // Capabilities only. Supplying the port on the context as well let a
      // handler that read it from the wrong place pass here and still fail
      // against the real dispatcher — which is exactly what happened once.
      hookContext: (ctx) => ({
        intent: ctx.intent,
        capabilities: { pluginPort },
      }),
    })
  );

  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} });
  return { state, handle };
}

/** Drive app:start then app:shutdown against one module instance. */
async function startThenStop(pluginPort: number) {
  const state = createMockState();
  const handle = createCliModule({ stateService: state, logger: SILENT_LOGGER });

  const dispatcher = new Dispatcher({ logger: createMockLogger() });
  dispatcher.registerModule(handle.module);
  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { pluginPort } }),
    })
  );
  dispatcher.registerOperation(
    createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
      throwOnError: false,
    })
  );

  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} });
  await dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} });
  return { state, handle };
}

describe("CliModule", () => {
  describe("scripts", () => {
    it("declares the CLI's scripts so they are synced into the bin directory", () => {
      // Both wrappers are templates: the interpreter path is baked in at sync
      // time so `ch` works outside a CodeHydra terminal. ch.cjs is the bundle.
      expect(CLI_SCRIPTS).toEqual([
        { name: "ch", template: true },
        { name: "ch.cmd", template: true },
        "ch.cjs",
      ]);
    });
  });

  describe("publishing connection details", () => {
    it("writes the bound port so ch can find the instance", async () => {
      const { state } = await startWith(45123);

      expect(state.getEffective()["plugin.port"]).toBe(45123);
    });

    it("writes a token the CLI must present", async () => {
      const { state, handle } = await startWith(45123);

      const token = state.getEffective()["plugin.token"];
      expect(typeof token).toBe("string");
      expect((token as string).length).toBeGreaterThan(32);
      expect(handle.token()).toBe(token);
    });

    it("has no token before app:start has run", async () => {
      // The plugin server is constructed first and reads this lazily; a null
      // must refuse CLI connections rather than admit unauthenticated ones.
      const handle = createCliModule({
        stateService: createMockState(),
        logger: SILENT_LOGGER,
      });

      expect(handle.token()).toBeNull();
    });

    it("mints a different token each launch", async () => {
      // A token outliving its process would authorize a connection to whatever
      // bound the port next.
      const first = await startWith(1);
      const second = await startWith(1);

      expect(first.handle.token()).not.toBe(second.handle.token());
    });
  });

  describe("shutdown", () => {
    it("withdraws the published port", async () => {
      // A port outlives the process that bound it. Leaving it behind would have
      // `ch` report a connection error rather than the truth — that CodeHydra
      // is not running — and would point it at whatever binds that port next.
      const { state } = await startThenStop(45123);

      expect(state.getEffective()["plugin.port"]).toBe(0);
    });

    it("withdraws the token, so it is never presented to a stranger", async () => {
      const { state, handle } = await startThenStop(45123);

      expect(state.getEffective()["plugin.token"]).toBeNull();
      expect(handle.token()).toBeNull();
    });
  });

  describe("when the plugin server did not start", () => {
    it("publishes no port, so ch reports the app as not running", async () => {
      const { state } = await startWith(null);

      // 0 is the sentinel discovery treats as absent.
      expect(state.getEffective()["plugin.port"]).toBe(0);
    });

    it("publishes no token", async () => {
      const { state, handle } = await startWith(null);

      expect(state.getEffective()["plugin.token"]).toBeNull();
      expect(handle.token()).toBeNull();
    });
  });
});
