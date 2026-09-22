/**
 * State module integration tests.
 *
 * Drives the app:start "init" hook against a real StateService over an fs mock.
 */

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import {
  createFileSystemMock,
  file,
  directory,
} from "../boundaries/platform/filesystem.state-mock";
import { DefaultStateService } from "../boundaries/platform/state-service";
import { storeString } from "../boundaries/platform/store-definition";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  type AppStartIntent,
} from "../intents/app-start";
import { createStateModule } from "./state-module";
import { testPath } from "../shared/test-fixtures";

const STATE_PATH = testPath("/app/state.json");
const KEY = "telemetry.distinct-id";

type Entries = Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>;

/** Wire a StateService + state module over an fs mock and run the init hook. */
async function runInit(entries: Entries): Promise<unknown> {
  const fs = createFileSystemMock({ entries });
  const state = new DefaultStateService({
    statePath: STATE_PATH,
    fileSystem: fs,
    logger: SILENT_LOGGER,
  });
  const accessor = state.register(KEY, { default: null, ...storeString({ nullable: true }) });

  const dispatcher = createMockDispatcher();
  // The state module's init handler requires the "app-ready" capability
  // (provided in production by electron-lifecycle); seed it for the test.
  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
    })
  );
  dispatcher.registerModule(createStateModule({ stateService: state }));

  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] });

  return accessor.get();
}

describe("state module", () => {
  it("loads state.json in app:start init", async () => {
    const value = await runInit({
      "/app": directory(),
      "/app/state.json": file(JSON.stringify({ [KEY]: "stored-uuid" })),
    });

    expect(value).toBe("stored-uuid");
  });

  it("leaves defaults when there is no state.json", async () => {
    const value = await runInit({ "/app": directory() });

    expect(value).toBeNull();
  });
});
