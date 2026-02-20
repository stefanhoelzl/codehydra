// @vitest-environment node
/**
 * Integration tests for ScriptModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../intents/infrastructure/hook-registry";
import { Dispatcher } from "../intents/infrastructure/dispatcher";
import { wireModules } from "../intents/infrastructure/wire";
import type { Operation, OperationContext } from "../intents/infrastructure/operation";
import type { Intent } from "../intents/infrastructure/types";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../operations/app-start";
import type { AppStartIntent, InitHookContext } from "../operations/app-start";
import { createScriptModule } from "./script-module";
import { Path } from "../../services/platform/path";

// =============================================================================
// Minimal Test Operation
// =============================================================================

/** Runs "init" hook point with InitHookContext. */
class MinimalInitOperation implements Operation<Intent, void> {
  readonly id = APP_START_OPERATION_ID;
  private readonly scripts: readonly string[];

  constructor(scripts: readonly string[] = ["ch-claude", "code"]) {
    this.scripts = scripts;
  }

  async execute(ctx: OperationContext<Intent>): Promise<void> {
    const initCtx: InitHookContext = {
      intent: ctx.intent,
      requiredScripts: this.scripts,
    };
    const { errors } = await ctx.hooks.collect<void>("init", initCtx);
    if (errors.length > 0) throw errors[0]!;
  }
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

    const pathProvider = {
      binDir: new Path("/app-data/bin"),
      binAssetsDir: new Path("/assets/bin"),
    };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    const scripts = ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "code"];
    dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation(scripts));

    const module = createScriptModule({
      fileSystem: fileSystem as never,
      pathProvider: pathProvider as never,
    });
    wireModules([module], hookRegistry, dispatcher);

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

    // Should copy each declared script
    expect(fileSystem.copyTree).toHaveBeenCalledTimes(4);
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/assets/bin/ch-claude"),
      new Path("/app-data/bin/ch-claude")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/assets/bin/ch-claude.cjs"),
      new Path("/app-data/bin/ch-claude.cjs")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/assets/bin/ch-claude.cmd"),
      new Path("/app-data/bin/ch-claude.cmd")
    );
    expect(fileSystem.copyTree).toHaveBeenCalledWith(
      new Path("/assets/bin/code"),
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

    const pathProvider = {
      binDir: new Path("/app-data/bin"),
      binAssetsDir: new Path("/assets/bin"),
    };

    const hookRegistry = new HookRegistry();
    const dispatcher = new Dispatcher(hookRegistry);

    dispatcher.registerOperation(INTENT_APP_START, new MinimalInitOperation([]));

    const module = createScriptModule({
      fileSystem: fileSystem as never,
      pathProvider: pathProvider as never,
    });
    wireModules([module], hookRegistry, dispatcher);

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
