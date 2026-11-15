// @vitest-environment node
/**
 * Integration tests for the CLI module.
 *
 * Runs the module through a real dispatcher so the assertions cover the seam
 * `ch` actually depends on: what `session.json` holds after app:start and
 * app:shutdown, and what the API server sees when it asks for the token.
 */

import { AsyncLogScopeStore } from "../boundaries/platform/log-scope";
import { describe, it, expect } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import { createMockState, type MockStateService } from "../boundaries/platform/state.test-utils";
import {
  createFileSystemMock,
  directory,
  file,
  type MockFileSystemBoundary,
} from "../boundaries/platform/filesystem.state-mock";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createCliModule, CLI_SCRIPTS } from "./cli-module";
import { APP_START_OPERATION_ID } from "../intents/app-start";
import { APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN } from "../intents/app-shutdown";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { Operation } from "../intents/lib/operation";
import { z } from "zod/v4";
import { testPath } from "../shared/test-fixtures";
import { Path } from "../utils/path/path";
import type { SessionFile } from "../cli/discovery";

const INTENT_APP_START = "app:start";
const DATA_ROOT = testPath("app-data");
const SESSION_PATH = new Path(DATA_ROOT.toString(), "session.json");
const PID = 4242;

interface SetupOptions {
  readonly state?: MockStateService;
  readonly fileSystem?: MockFileSystemBoundary;
  /** Wraps the filesystem the module sees, e.g. to observe its writes. */
  readonly wrapFs?: (fs: FileSystemBoundary) => FileSystemBoundary;
}

/**
 * The module wired to a dispatcher that runs app:start (migrations + start)
 * and app:shutdown (stop), with the API server's port supplied as the
 * capability the real operation provides.
 */
function setup(apiPort: number | null, options: SetupOptions = {}) {
  const state = options.state ?? createMockState();
  const fileSystem =
    options.fileSystem ??
    createFileSystemMock({ entries: { [DATA_ROOT.toString()]: directory() } });
  const handle = createCliModule({
    stateService: state,
    fileSystem: options.wrapFs ? options.wrapFs(fileSystem) : fileSystem,
    sessionPath: SESSION_PATH,
    pid: PID,
    logger: SILENT_LOGGER,
  });

  const dispatcher = new Dispatcher({
    logger: createMockLogger(),
    logScope: new AsyncLogScopeStore(),
  });
  dispatcher.registerModule(handle.module);
  // The two app:start hook points the module uses, in the real order.
  // Capabilities only for the port: supplying it on the context as well let a
  // handler that read it from the wrong place pass here and still fail
  // against the real dispatcher — which is exactly what happened once.
  const appStart: Operation<{
    readonly type: string;
    readonly payload: z.ZodUnknown;
    readonly result: z.ZodUnknown;
  }> = {
    id: APP_START_OPERATION_ID,
    schemas: { type: INTENT_APP_START, payload: z.unknown(), result: z.unknown() },
    async execute(ctx) {
      for (const hookPoint of ["migrations", "start"]) {
        const { errors } = await ctx.hooks.collect(hookPoint, {
          intent: ctx.intent,
          capabilities: { apiPort },
        });
        if (errors.length > 0) throw errors[0]!;
      }
    },
  };
  dispatcher.registerOperation(appStart);
  dispatcher.registerOperation(
    createMinimalOperation(APP_SHUTDOWN_OPERATION_ID, INTENT_APP_SHUTDOWN, "stop", {
      throwOnError: false,
    })
  );

  return {
    state,
    fileSystem,
    handle,
    start: () => dispatcher.dispatch({ type: INTENT_APP_START, payload: {} }),
    stop: () => dispatcher.dispatch({ type: INTENT_APP_SHUTDOWN, payload: {} }),
  };
}

async function readSession(fileSystem: FileSystemBoundary): Promise<SessionFile> {
  return JSON.parse(await fileSystem.readFile(SESSION_PATH)) as SessionFile;
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
    it("writes the bound port, a token and its pid to session.json", async () => {
      const { fileSystem, handle, start } = setup(45123);

      await start();

      const session = await readSession(fileSystem);
      expect(session.port).toBe(45123);
      expect(session.pid).toBe(PID);
      expect(session.token.length).toBeGreaterThan(32);
      expect(handle.token()).toBe(session.token);
    });

    it("has no token before app:start has run", () => {
      // The API server is constructed first and reads this lazily; a null
      // must refuse CLI connections rather than admit unauthenticated ones.
      const { handle } = setup(45123);

      expect(handle.token()).toBeNull();
    });

    it("never writes session.json in place, so a reader sees all of it or none", async () => {
      // `ch` reads the file once and requires port and token both; a
      // half-written file would make a healthy app look dead.
      const written: string[] = [];
      const { fileSystem, start } = setup(45123, {
        wrapFs: (fs) => ({
          ...fs,
          writeFile: (path, content, options) => {
            written.push(path.toString());
            return fs.writeFile(path, content, options);
          },
        }),
      });

      await start();

      expect(written).not.toContain(SESSION_PATH.toString());
      expect(fileSystem).toHaveFile(SESSION_PATH);
    });

    it("replaces a session file a crashed launch left behind", async () => {
      const fileSystem = createFileSystemMock({
        entries: {
          [DATA_ROOT.toString()]: directory(),
          [SESSION_PATH.toString()]: file(JSON.stringify({ port: 1, token: "old", pid: 1 })),
        },
      });
      const { start } = setup(45123, { fileSystem });

      await start();

      expect((await readSession(fileSystem)).port).toBe(45123);
    });

    it("mints a different token each launch", async () => {
      // A token outliving its process would authorize a connection to whatever
      // bound the port next.
      const first = setup(1);
      const second = setup(1);
      await first.start();
      await second.start();

      expect(first.handle.token()).not.toBe(second.handle.token());
    });

    it("keeps the connection out of state.json", async () => {
      const { state, start } = setup(45123);

      await start();

      expect(state.getEffective()["api.port"]).toBe(0);
      expect(state.getEffective()["api.token"]).toBeNull();
    });
  });

  describe("an earlier release's state.json", () => {
    it("is stripped of the connection it used to hold there", async () => {
      const state = createMockState({ values: { "api.port": 41000, "api.token": "stale" } });
      const { start } = setup(45123, { state });

      await start();

      expect(state.getEffective()["api.port"]).toBe(0);
      expect(state.getEffective()["api.token"]).toBeNull();
    });
  });

  describe("shutdown", () => {
    it("removes session.json, so ch reports the app as not running", async () => {
      // A port outlives the process that bound it. Leaving it behind would have
      // `ch` present this instance's token to whatever binds that port next.
      const { fileSystem, handle, start, stop } = setup(45123);
      await start();

      await stop();

      expect(fileSystem).not.toHaveFile(SESSION_PATH);
      expect(handle.token()).toBeNull();
    });
  });

  describe("when the API server did not start", () => {
    it("publishes nothing, and removes a stale session file", async () => {
      const fileSystem = createFileSystemMock({
        entries: {
          [DATA_ROOT.toString()]: directory(),
          [SESSION_PATH.toString()]: file(JSON.stringify({ port: 1, token: "old", pid: 1 })),
        },
      });
      const { handle, start } = setup(null, { fileSystem });

      await start();

      expect(fileSystem).not.toHaveFile(SESSION_PATH);
      expect(handle.token()).toBeNull();
    });
  });
});
