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
import { projPath, wsPath, workspaceRefIn } from "../../shared/test-fixtures";
import { projectRefFor } from "../../utils/ref";
import { createLockModule } from "../../modules/lock-module";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import type {
  PluginAddRequest,
  PluginListing,
  PluginScope,
  PluginSourceListing,
  Plugins,
  PluginState,
} from "./deps";
import { createRegistry } from "./index";

const APP = projPath("/projects/app");
const FEAT_PATH = wsPath("/projects/app/workspaces/feat");
const FEAT = workspaceRefIn(APP, "feat");
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
  const added: PluginAddRequest[] = [];
  const updated: Array<string | undefined> = [];
  const listing = (id: string, state: PluginState, platforms: string[]): PluginListing => {
    const [type, source] = id.split(":") as [PluginListing["type"], string];
    return {
      id,
      name: id.slice(id.lastIndexOf(":") + 1),
      type,
      source,
      state,
      platforms,
      path: `/plugins/${id}`,
      ...(type === "remote" && { status: "9f1e2c3, fetched 2m ago" }),
    };
  };
  const acme: PluginSourceListing = {
    id: "remote:acme",
    type: "remote",
    name: "acme",
    location: "git@github.com:acme/ch-plugins.git",
    ref: "main",
    status: "9f1e2c3, fetched just now",
  };
  const plugins: Plugins = {
    list: async (scope) => {
      scopes.push(scope);
      return [
        listing("local:default:github", "enabled", ["linux", "windows", "macos"]),
        listing("remote:acme:deploy", "enabled", ["linux"]),
        ...(scope.workspace === null ? [] : [listing("project:app:setup", "ask", ["linux"])]),
      ];
    },
    setState: async (_scope, id, state) => {
      if (id === "local:default:nope") {
        throw new ApiError("not-found", "No plugin local:default:nope");
      }
      states.push([id, state]);
      return listing(id, state, ["linux"]);
    },
    add: async (request) => {
      added.push(request);
      return acme;
    },
    remove: async (name) => {
      if (name !== "acme") throw new ApiError("not-found", `No plugins.config entry ${name}`);
      return acme;
    },
    update: async (name) => {
      updated.push(name);
      return [acme];
    },
    errors: () => [
      {
        plugin: "local:default:github",
        entry: "automations.prs",
        message: "exit 1",
        logPath: "/logs/x.failed.log",
        at: "2026-09-26T10:00:00.000Z",
      },
      {
        plugin: "local:default:broken",
        message: "document 1: unknown key x",
        at: "2026-09-26T10:00:00Z",
      },
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
      wakeups: { set: async () => {}, show: async () => null },
      readUserGuide: async () => "",
      plugins: () => plugins,
    },
    SILENT_LOGGER
  );
  const call = (name: Parameters<typeof registry.get>[0], ctx: OperationContext, input = {}) =>
    registry.invoke(registry.get(name), ctx, input);
  return { call, scopes, states, added, updated };
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
        name: "local:default:github",
        state: "enabled",
        platforms: "all",
        status: "",
        path: "/plugins/local:default:github",
      },
      {
        name: "remote:acme:deploy",
        state: "enabled",
        platforms: "linux",
        status: "9f1e2c3, fetched 2m ago",
        path: "/plugins/remote:acme:deploy",
      },
      {
        name: "project:app:setup",
        state: "ask",
        platforms: "linux",
        status: "",
        path: "/plugins/project:app:setup",
      },
    ]);
  });

  it("shows only the user's own plugins outside every workspace", async () => {
    const { call } = setup();

    const rows = (await call("plugin.list", outside)) as unknown[];

    expect(rows).toHaveLength(2);
  });

  it("reads the repository of the workspace the input names, from outside every workspace", async () => {
    const { call, scopes } = setup();

    const rows = (await call("plugin.list", outside, { workspace: FEAT })) as unknown[];

    expect(rows).toHaveLength(3);
    expect(scopes).toEqual([FEAT_SCOPE]);
  });
});

describe("plugin.enable / plugin.disable", () => {
  it("sets the state and answers with the plugin's row", async () => {
    const { call, states } = setup();

    await call("plugin.enable", inWorkspace, { id: "project:app:setup" });
    const row = await call("plugin.disable", outside, { id: "local:default:github" });

    expect(states).toEqual([
      ["project:app:setup", "enabled"],
      ["local:default:github", "disabled"],
    ]);
    expect(row).toMatchObject({ name: "local:default:github", state: "disabled" });
  });

  it("refuses an id that is not a plugin name", async () => {
    const { call } = setup();

    await expect(call("plugin.enable", outside, { id: "github" })).rejects.toThrow(
      /<type>:<entry>:<name>/
    );
    // The names before sources existed are no longer names.
    await expect(call("plugin.enable", outside, { id: "local:github" })).rejects.toThrow(
      /<type>:<entry>:<name>/
    );
    await expect(call("plugin.enable", inWorkspace, { id: "workspace:setup" })).rejects.toThrow(
      /<type>:<entry>:<name>/
    );
  });

  it("takes a project name that holds a colon", async () => {
    const { call, states } = setup();

    await call("plugin.enable", inWorkspace, { id: "project:my:app:setup" });

    expect(states).toEqual([["project:my:app:setup", "enabled"]]);
  });

  it("passes a missing plugin's not-found through", async () => {
    const { call } = setup();

    await expect(
      call("plugin.enable", outside, { id: "local:default:nope" })
    ).rejects.toMatchObject({
      category: "not-found",
    });
  });
});

describe("plugin.errors", () => {
  it("lists problems and failures with their logs, as rows", async () => {
    const { call } = setup();

    expect(await call("plugin.errors", outside)).toEqual([
      {
        plugin: "local:default:github",
        entry: "automations.prs",
        message: "exit 1",
        log: "/logs/x.failed.log",
        at: "2026-09-26T10:00:00.000Z",
      },
      {
        plugin: "local:default:broken",
        entry: "",
        message: "document 1: unknown key x",
        log: "",
        at: "2026-09-26T10:00:00Z",
      },
    ]);
  });
});

describe("plugin.add / plugin.remove / plugin.update", () => {
  const acmeRow = {
    name: "acme",
    type: "remote",
    location: "git@github.com:acme/ch-plugins.git",
    ref: "main",
    status: "9f1e2c3, fetched just now",
  };

  it("adds with the caller's directory, for a relative folder", async () => {
    const { call, added } = setup();
    const ctx: OperationContext = { ...outside, cwd: "/home/me" };

    const row = await call("plugin.add", ctx, {
      source: "git@github.com:acme/ch-plugins.git",
      name: "acme",
      ref: "main",
      path: "plugins",
    });

    expect(added).toEqual([
      {
        source: "git@github.com:acme/ch-plugins.git",
        name: "acme",
        ref: "main",
        path: "plugins",
        cwd: "/home/me",
      },
    ]);
    expect(row).toEqual(acmeRow);
  });

  it("removes by name, passing a missing entry's not-found through", async () => {
    const { call } = setup();

    expect(await call("plugin.remove", outside, { name: "acme" })).toEqual(acmeRow);
    await expect(call("plugin.remove", outside, { name: "nope" })).rejects.toMatchObject({
      category: "not-found",
    });
  });

  it("updates one remote, or every one", async () => {
    const { call, updated } = setup();

    await call("plugin.update", outside, { name: "acme" });
    const rows = await call("plugin.update", outside);

    expect(updated).toEqual(["acme", undefined]);
    expect(rows).toEqual([acmeRow]);
  });
});
