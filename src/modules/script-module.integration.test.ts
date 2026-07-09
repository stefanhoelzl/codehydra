// @vitest-environment node
/**
 * Integration tests for ScriptModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";

import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, InitHookContext } from "../intents/app-start";
import { createScriptModule } from "./script-module";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { Path } from "../utils/path/path";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "init" hook point with InitHookContext. */
function createMinimalInitOperation(scripts: readonly string[] = ["ch-claude", "code"]) {
  return createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
    hookContext: (ctx): InitHookContext => ({
      intent: ctx.intent,
      requiredScripts: scripts,
      capabilities: { "app-ready": true },
    }),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("ScriptModule Integration", () => {
  it("copies only declared scripts from requiredScripts", async () => {
    const fileSystem = {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      copyTree: vi.fn().mockResolvedValue(undefined),
      makeExecutable: vi.fn().mockResolvedValue(undefined),
    };

    // Distinct runtime vs asset roots: the wrappers MUST be copied from
    // runtimePath (extraResources / resources/bin, real files), NOT assetPath
    // (inside app.asar, unreadable via original-fs in the packaged app). If this
    // regresses to assetPath, the /runtime assertions below fail.
    const pathProvider = createMockPathProvider({
      dataRootDir: "/app-data",
      runtimeRootDir: "/runtime",
      assetsRootDir: "/assets",
    });

    const dispatcher = createMockDispatcher();

    const scripts = ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "code"];
    dispatcher.registerOperation(createMinimalInitOperation(scripts));

    const module = createScriptModule({
      fileSystem: fileSystem as never,
      pathProvider: pathProvider as never,
    });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    // Should clean and recreate bin dir
    expect(fileSystem.rm).toHaveBeenCalledWith(
      new Path("/app-data/bin"),
      expect.objectContaining({ recursive: true, force: true })
    );
    expect(fileSystem.mkdir).toHaveBeenCalledWith(new Path("/app-data/bin"));

    // Should copy each declared script from runtimePath (/runtime/bin), not assetPath
    expect(fileSystem.copyTree).toHaveBeenCalledTimes(4);
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/runtime/bin/ch-claude"),
      new Path("/app-data/bin/ch-claude")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/runtime/bin/ch-claude.cjs"),
      new Path("/app-data/bin/ch-claude.cjs")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/runtime/bin/ch-claude.cmd"),
      new Path("/app-data/bin/ch-claude.cmd")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/runtime/bin/code"),
      new Path("/app-data/bin/code")
    );

    // Should make non-.cmd, non-.cjs files executable
    expect(fileSystem.makeExecutable).toHaveBeenCalledTimes(2);
    expect(fileSystem.makeExecutable).toHaveBeenCalledWith(new Path("/app-data/bin/ch-claude"));
    expect(fileSystem.makeExecutable).toHaveBeenCalledWith(new Path("/app-data/bin/code"));
  });

  it("handles empty requiredScripts list", async () => {
    const fileSystem = {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      copyTree: vi.fn().mockResolvedValue(undefined),
      makeExecutable: vi.fn().mockResolvedValue(undefined),
    };

    const pathProvider = createMockPathProvider({
      dataRootDir: "/app-data",
      assetsRootDir: "/assets",
    });

    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(createMinimalInitOperation([]));

    const module = createScriptModule({
      fileSystem: fileSystem as never,
      pathProvider: pathProvider as never,
    });
    dispatcher.registerModule(module);

    await dispatcher.dispatch({
      type: INTENT_APP_START,
      payload: {},
    } as AppStartIntent);

    // Should still clean and recreate bin dir
    expect(fileSystem.rm).toHaveBeenCalled();
    expect(fileSystem.mkdir).toHaveBeenCalled();

    // Should not copy anything
    expect(fileSystem.copyTree).not.toHaveBeenCalled();
    expect(fileSystem.makeExecutable).not.toHaveBeenCalled();
  });
});
