/**
 * State module integration tests.
 *
 * Exercises the config→state migration end-to-end with a real Config (holding a
 * read-only `deprecated` shadow) and a real StateService over a shared fs mock,
 * driven through the app:start "init" hook.
 */

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import {
  createFileSystemMock,
  file,
  directory,
} from "../boundaries/platform/filesystem.state-mock";
import { DefaultConfig } from "../boundaries/platform/config";
import type { ConfigDeps } from "../boundaries/platform/config";
import { DefaultStateService } from "../boundaries/platform/state-service";
import { storeString } from "../boundaries/platform/store-definition";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import {
  INTENT_APP_START,
  APP_START_OPERATION_ID,
  type AppStartIntent,
} from "../intents/app-start";
import { createStateModule, createStateMigrationRegistry } from "./state-module";
import { testPath } from "../shared/test-fixtures";

const CONFIG_PATH = testPath("/app/config.json");
const STATE_PATH = testPath("/app/state.json");
const KEY = "telemetry.distinct-id";

type Entries = Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>;

function syncReader(entries: Entries): (path: string) => string {
  // Fixtures are written in the OS-native form; both sides go through Path.
  const normalized = new Map(
    Object.entries(entries).map(([key, entry]) => [testPath(key).toString(), entry])
  );
  return (path: string) => {
    const entry = normalized.get(testPath(path).toString());
    if (!entry || entry.type !== "file") {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return entry.content as string;
  };
}

/**
 * Wire a real Config (deprecated shadow) + StateService (live key) + state
 * module over a shared fs mock, run config.load() (sync) and the init hook, then
 * return the live state accessor and the fs for on-disk assertions.
 */
async function runMigration(entries: Entries): Promise<{
  fs: ReturnType<typeof createFileSystemMock>;
  stateValue: unknown;
}> {
  const fs = createFileSystemMock({ entries });
  const syncWrites: [string, string][] = [];

  const configDeps: ConfigDeps = {
    configPath: CONFIG_PATH,
    fileSystem: fs,
    logger: SILENT_LOGGER,
    isDevelopment: false,
    isPackaged: true,
    env: {},
    argv: [],
    readFileSync: syncReader(entries),
    // config.json here carries a key this test never registers, so `load()`
    // takes its "strip unknown keys" branch and rewrites the file. That branch
    // defaults to the real `node:fs` and swallows its own failures, so without
    // these the test silently writes to disk — and succeeds whenever the
    // directory happens to exist. Capture the writes instead.
    writeFileSync: (path, content) => {
      syncWrites.push([path, content]);
    },
    renameSync: (from, to) => {
      syncWrites.push([from, to]);
    },
  };
  const config = new DefaultConfig(configDeps);
  const state = new DefaultStateService({
    statePath: STATE_PATH,
    fileSystem: fs,
    logger: SILENT_LOGGER,
  });
  const migrations = createStateMigrationRegistry();

  const stateAccessor = state.register(KEY, { default: null, ...storeString({ nullable: true }) });
  const legacyShadow = config.register(KEY, {
    default: null,
    deprecated: true,
    ...storeString({ nullable: true }),
  });
  migrations.add({ from: legacyShadow, to: stateAccessor });

  config.load();

  const dispatcher = createMockDispatcher();
  // The state module's init handler requires the "app-ready" capability
  // (provided in production by electron-lifecycle); seed it for the test.
  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
      hookContext: (ctx) => ({ intent: ctx.intent, capabilities: { "app-ready": true } }),
    })
  );
  dispatcher.registerModule(
    createStateModule({ stateService: state, migrations, logger: SILENT_LOGGER })
  );

  await dispatcher.dispatch({ type: INTENT_APP_START, payload: {} as AppStartIntent["payload"] });

  return { fs, stateValue: stateAccessor.get() };
}

describe("state module migration", () => {
  it("migrates a deprecated config value into state.json and strips it from config", async () => {
    const { fs, stateValue } = await runMigration({
      "/app": directory(),
      "/app/config.json": file(JSON.stringify({ [KEY]: "legacy-uuid", agent: "claude" })),
    });

    // Seeded into state.
    expect(stateValue).toBe("legacy-uuid");
    expect(JSON.parse(await fs.readFile(STATE_PATH))).toEqual({ [KEY]: "legacy-uuid" });

    // Stripped from config (other keys preserved).
    expect(JSON.parse(await fs.readFile(CONFIG_PATH))).toEqual({ agent: "claude" });
  });

  it("leaves state untouched when state.json already holds the value", async () => {
    const { fs, stateValue } = await runMigration({
      "/app": directory(),
      "/app/config.json": file(JSON.stringify({ [KEY]: "legacy-uuid" })),
      "/app/state.json": file(JSON.stringify({ [KEY]: "existing-uuid" })),
    });

    // State wins; no migration.
    expect(stateValue).toBe("existing-uuid");
    // The deprecated shadow is left in config (not stripped) since nothing migrated.
    expect(JSON.parse(await fs.readFile(CONFIG_PATH))).toEqual({ [KEY]: "legacy-uuid" });
  });

  it("does nothing when there is no legacy value to migrate", async () => {
    const { fs, stateValue } = await runMigration({
      "/app": directory(),
      "/app/config.json": file(JSON.stringify({ agent: "claude" })),
    });

    expect(stateValue).toBeNull();
    // No state file written (no migration occurred).
    await expect(fs.readFile(STATE_PATH)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(CONFIG_PATH))).toEqual({ agent: "claude" });
  });
});
