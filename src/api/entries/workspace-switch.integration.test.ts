// @vitest-environment node
/**
 * `workspace.switch` (`ch ws switch`, MCP `workspace_switch`): a switch the
 * presenter keeps from happening — the user is filling in the New workspace
 * form — is reported as not done, with a reason, rather than as a failure.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createLockModule } from "../../modules/lock-module";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import type { Operation } from "../../intents/lib/operation";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import { INTENT_SWITCH_WORKSPACE } from "../../intents/switch-workspace";
import { projPath, workspaceRefIn } from "../../shared/test-fixtures";
import { createRegistry } from "./index";
import { SWITCH_BLOCKED_BY_CREATION_FORM } from "./workspace";

const anySchemas = (type: string) => ({ type, payload: z.unknown(), result: z.unknown() });

const FEAT = workspaceRefIn(projPath("/projects/app"), "feat");

/** A registry whose workspace:switch records each switch that got past the interceptors. */
function setup(options: { keepForm: boolean }) {
  const dispatcher = createMockDispatcher();
  const switched: unknown[] = [];
  // Nothing is listed: a workspace named by its full ref is taken at its word.
  const listProjects: Operation<ReturnType<typeof anySchemas>> = {
    id: "list-projects",
    schemas: anySchemas(INTENT_LIST_PROJECTS),
    execute: async () => [],
  };
  const switchOp: Operation<ReturnType<typeof anySchemas>> = {
    id: "record-switch",
    schemas: anySchemas(INTENT_SWITCH_WORKSPACE),
    execute: async (ctx) => {
      switched.push(ctx.intent.payload);
    },
  };
  dispatcher.registerOperation(listProjects);
  dispatcher.registerOperation(switchOp);
  // Stands in for the presenter's keep-edited-creation-form.
  dispatcher.addInterceptor({
    id: "keep-form",
    before: async (intent) =>
      options.keepForm && intent.type === INTENT_SWITCH_WORKSPACE ? null : intent,
  });
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      processes: { list: async () => null },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );
  const entry = registry.get("workspace.switch");
  const run = () =>
    entry.handler(
      { workspaceRef: null, cwd: null, signal: new AbortController().signal },
      entry.input.parse({ workspace: FEAT })
    );
  return { run, switched };
}

describe("workspace.switch", () => {
  it("switches and says so", async () => {
    const { run, switched } = setup({ keepForm: false });

    expect(await run()).toEqual({ switched: true });
    expect(switched).toEqual([{ workspaceRef: FEAT, focus: true }]);
  });

  it("reports a switch the New workspace form kept, without failing", async () => {
    const { run, switched } = setup({ keepForm: true });

    expect(await run()).toEqual({ switched: false, reason: SWITCH_BLOCKED_BY_CREATION_FORM });
    expect(switched).toEqual([]);
  });
});
