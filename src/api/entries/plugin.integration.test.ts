// @vitest-environment node
/**
 * The `plugin.*` registry entries, run through the real registry with a fake
 * plugin table: which scope a caller's list is read in, and the rows it gets.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { INTENT_RESOLVE_WORKSPACE } from "../../intents/resolve-workspace";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { Operation, OperationSchemas } from "../../intents/lib/operation";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import { createLockModule } from "../../modules/lock-module";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import type { PluginListing, PluginScope, Plugins, PluginState } from "./deps";
import { createRegistry } from "./index";

const APP = projPath("/projects/app");
const FEAT_PATH = wsPath("/projects/app/workspaces/feat");
const FEAT = makeWorkspaceRef(projectRefFor(APP), "feat");
/** The scope a caller in (or naming) `feat` lists in. */
const FEAT_SCOPE: PluginScope = {
  workspace: { workspacePath: FEAT_PATH, projectRef: projectRefFor(APP), projectPath: APP },
};

const resolveSchemas = {
  type: INTENT_RESOLVE_WORKSPACE,
  payload: z.unknown(),
  result: z.unknown(),
} satisfies OperationSchemas;

class ResolveWorkspaceOp implements Operation<typeof resolveSchemas> {
  readonly id = "resolve-workspace";
  readonly schemas = resolveSchemas;
  async execute(): Promise<unknown> {
    return {
      workspaceRef: FEAT,
      workspacePath: FEAT_PATH,
      projectRef: projectRefFor(APP),
      projectPath: APP,
      workspaceName: "feat",
      branch: "feat",
      metadata: {},
    };
  }
}

const listProjectsSchemas = {
  type: INTENT_LIST_PROJECTS,
  payload: z.unknown(),
  result: z.unknown(),
} satisfies OperationSchemas;

/** Nothing is listed: a workspace named by its full ref is taken at its word. */
class ListNoProjectsOp implements Operation<typeof listProjectsSchemas> {
  readonly id = "list-projects";
  readonly schemas = listProjectsSchemas;
  async execute(): Promise<unknown[]> {
    return [];
  }
}

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new ResolveWorkspaceOp());
  dispatcher.registerOperation(new ListNoProjectsOp());
  const scopes: PluginScope[] = [];
  const states: Array<[string, PluginState]> = [];
  const listing = (id: string, state: PluginState, platforms: string[]): PluginListing => ({
    id,
    name: id.slice(id.indexOf(":") + 1),
    origin: id.startsWith("local:") ? "local" : "workspace",
    state,
    platforms,
    path: `/plugins/${id}`,
  });
  const plugins: Plugins = {
    list: async (scope) => {
      scopes.push(scope);
      return [
        listing("local:github", "enabled", ["linux", "windows", "macos"]),
        ...(scope.workspace === null ? [] : [listing("workspace:setup", "ask", ["linux"])]),
      ];
    },
    setState: async (_scope, id, state) => {
      if (id === "local:nope") throw new ApiError("not-found", "No plugin local:nope");
      states.push([id, state]);
      return listing(id, state, ["linux"]);
    },
    errors: () => [
      {
        plugin: "local:github",
        entry: "automations.prs",
        message: "exit 1",
        logPath: "/logs/x.failed.log",
        at: "2026-09-26T10:00:00.000Z",
      },
      { plugin: "local:broken", message: "document 1: unknown key x", at: "2026-09-26T10:00:00Z" },
    ],
    schema: (which) => ({ type: which === "items" ? "array" : "object" }),
    render: async (template, itemsJson) =>
      (JSON.parse(itemsJson) as unknown[]).map((item) => ({ template, item })),
  };
  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
      plugins: () => plugins,
    },
    SILENT_LOGGER
  );
  const call = (name: Parameters<typeof registry.get>[0], ctx: OperationContext, input = {}) =>
    registry.invoke(registry.get(name), ctx, input);
  return { call, scopes, states };
}

const inWorkspace: OperationContext = {
  workspaceRef: FEAT,
  cwd: null,
  signal: new AbortController().signal,
};
const outside: OperationContext = {
  workspaceRef: null,
  cwd: null,
  signal: new AbortController().signal,
};

describe("plugin.list", () => {
  it("reads the caller's repository too, as table rows", async () => {
    const { call, scopes } = setup();

    const rows = await call("plugin.list", inWorkspace);

    expect(scopes).toEqual([FEAT_SCOPE]);
    expect(rows).toEqual([
      {
        name: "local:github",
        origin: "local",
        state: "enabled",
        platforms: "all",
        path: "/plugins/local:github",
      },
      {
        name: "workspace:setup",
        origin: "workspace",
        state: "ask",
        platforms: "linux",
        path: "/plugins/workspace:setup",
      },
    ]);
  });

  it("shows only the user's own plugins outside every workspace", async () => {
    const { call } = setup();

    const rows = (await call("plugin.list", outside)) as unknown[];

    expect(rows).toHaveLength(1);
  });

  it("reads the repository of the workspace the input names, from outside every workspace", async () => {
    const { call, scopes } = setup();

    const rows = (await call("plugin.list", outside, { workspace: FEAT })) as unknown[];

    expect(rows).toHaveLength(2);
    expect(scopes).toEqual([FEAT_SCOPE]);
  });
});

describe("plugin.enable / plugin.disable", () => {
  it("sets the state and answers with the plugin's row", async () => {
    const { call, states } = setup();

    await call("plugin.enable", inWorkspace, { id: "workspace:setup" });
    const row = await call("plugin.disable", outside, { id: "local:github" });

    expect(states).toEqual([
      ["workspace:setup", "enabled"],
      ["local:github", "disabled"],
    ]);
    expect(row).toMatchObject({ name: "local:github", state: "disabled" });
  });

  it("refuses an id that is not a plugin name", async () => {
    const { call } = setup();

    await expect(call("plugin.enable", outside, { id: "github" })).rejects.toThrow(
      /local:<name> or workspace:<name>/
    );
  });

  it("passes a missing plugin's not-found through", async () => {
    const { call } = setup();

    await expect(call("plugin.enable", outside, { id: "local:nope" })).rejects.toMatchObject({
      category: "not-found",
    });
  });
});

describe("plugin.errors", () => {
  it("lists problems and failures with their logs, as rows", async () => {
    const { call } = setup();

    expect(await call("plugin.errors", outside)).toEqual([
      {
        plugin: "local:github",
        entry: "automations.prs",
        message: "exit 1",
        log: "/logs/x.failed.log",
        at: "2026-09-26T10:00:00.000Z",
      },
      {
        plugin: "local:broken",
        entry: "",
        message: "document 1: unknown key x",
        log: "",
        at: "2026-09-26T10:00:00Z",
      },
    ]);
  });
});
