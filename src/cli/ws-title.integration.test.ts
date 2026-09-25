// @vitest-environment node
/**
 * `ch ws title` against the real registry and CLI adapter.
 *
 * Clearing a title is a null on the wire, which argv cannot spell. The CLI
 * mapping supplies it when no title is given, so these drive the whole path —
 * run(), describe, the adapter's shaping, the entry — and read back the
 * metadata write it dispatches.
 */

import { describe, it, expect } from "vitest";
import { run } from "./run";
import { EXIT } from "./output";
import { CallError, type Client } from "./client";
import { attachPluginAdapter, type PluginResult } from "../api/adapters/plugin";
import { createRegistry } from "../api/entries";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createLockModule } from "../modules/lock-module";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { schemas as setMetadataSchemas, type SetMetadataPayload } from "../intents/set-metadata";
import { workspacePathSchema } from "../intents/contract";
import { testPath } from "../shared/test-fixtures";

const WS = workspacePathSchema.parse(testPath("/repo/wt/feature").toNative());

/** A `ch` client wired straight into a CLI connection, recording metadata writes. */
function wire(): { client: Client; writes: SetMetadataPayload[] } {
  const writes: SetMetadataPayload[] = [];
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation({
    id: "recording-set-metadata",
    schemas: setMetadataSchemas,
    execute: async (ctx) => {
      writes.push(ctx.intent.payload);
    },
  });
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
    },
    SILENT_LOGGER
  );

  const handlers = new Map<string, (...args: unknown[]) => void>();
  attachPluginAdapter({
    socket: { on: (event, listener) => void handlers.set(event, listener) },
    registry,
    workspacePath: WS,
    logger: SILENT_LOGGER,
    kind: "cli",
  });

  const client: Client = {
    async call<T>(channel: string, request?: unknown): Promise<T> {
      const result = await new Promise<PluginResult<unknown>>((resolve) =>
        handlers.get(channel)!(request, resolve)
      );
      if (!result.success) throw new CallError(result.error, "failed");
      return result.data as T;
    },
    onEvent: () => () => {},
    close: () => {},
  };
  return { client, writes };
}

function ch(argv: readonly string[], client: Client) {
  return run({ argv, isTty: true, connect: async () => client });
}

describe("ch ws title", () => {
  it("sets the title given", async () => {
    const { client, writes } = wire();

    const result = await ch(["ws", "title", "Auth rework"], client);

    expect(result).toMatchObject({ exitCode: EXIT.OK, stdout: "" });
    expect(writes).toEqual([{ workspacePath: WS, key: "title", value: "Auth rework" }]);
  });

  it("clears the title when given none", async () => {
    const { client, writes } = wire();

    const result = await ch(["ws", "title"], client);

    expect(result).toMatchObject({ exitCode: EXIT.OK, stdout: "", stderr: "" });
    expect(writes).toEqual([{ workspacePath: WS, key: "title", value: null }]);
  });

  it("clears the title given an empty one", async () => {
    const { client, writes } = wire();

    await ch(["ws", "title", ""], client);

    expect(writes).toEqual([{ workspacePath: WS, key: "title", value: null }]);
  });

  it("clears the title given a null through --input", async () => {
    const { client, writes } = wire();

    await ch(["ws", "title", "--input", '{"title":null}'], client);

    expect(writes).toEqual([{ workspacePath: WS, key: "title", value: null }]);
  });

  it("says in its help how to clear, and offers no null the shell cannot pass", async () => {
    const { client } = wire();

    const { stdout } = await ch(["ws", "title", "--help"], client);

    expect(stdout).toContain("Usage: ch ws title [<title>]");
    expect(stdout).toContain("`ch ws title` with no title clears it");
    expect(stdout).toContain("--title <string>");
    expect(stdout).not.toContain("(required)");
  });
});
