// @vitest-environment node
/**
 * The plugin automations adapter: which operations it runs, and how an
 * automation with no workspace of its own names the one an action is for.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { Operation, OperationSchemas } from "../../intents/lib/operation";
import type { Project, ProjectId, WorkspaceName } from "../../shared/api/types";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import { OperationRegistry } from "../registry";
import { defineEntry, type OperationContext } from "../types";
import { OPERATION_NAMES } from "../names";
import { PLUGIN_ACTIONS_MAP } from "./plugin-actions-map";
import { invokePluginAction } from "./plugin-actions";

const APP = projPath("/projects/app");
const FEAT = wsPath("/projects/app/workspaces/feat");

const listProjectsSchemas = {
  type: INTENT_LIST_PROJECTS,
  payload: z.unknown(),
  result: z.unknown(),
} satisfies OperationSchemas;

class ListProjectsOp implements Operation<typeof listProjectsSchemas> {
  readonly id = "list-projects";
  readonly schemas = listProjectsSchemas;
  async execute(): Promise<Project[]> {
    return [
      {
        ref: projectRefFor(APP),
        id: "app-1" as ProjectId,
        name: "app",
        path: APP,
        workspaces: [
          {
            ref: makeWorkspaceRef(projectRefFor(APP), "feat"),
            projectId: "app-1" as ProjectId,
            name: "feat" as WorkspaceName,
            path: FEAT,
            branch: null,
            metadata: {},
          },
        ],
      },
    ] as unknown as Project[];
  }
}

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new ListProjectsOp());
  const calls: Array<{ ctx: OperationContext; input: unknown }> = [];
  const record = async (ctx: OperationContext, input: unknown): Promise<void> => {
    calls.push({ ctx, input });
  };
  const registry = new OperationRegistry([
    defineEntry({
      name: "workspace.hibernate",
      kind: "command",
      description: "hibernate",
      input: z.object({ workspace: z.string().optional(), project: z.string().optional() }),
      requiresWorkspace: true,
      handler: record,
    }),
    defineEntry({
      name: "notification.show",
      kind: "command",
      description: "show",
      input: z.object({ message: z.string(), dismissible: z.boolean().optional() }).strict(),
      requiresWorkspace: false,
      handler: record,
    }),
    defineEntry({
      name: "config.set",
      kind: "command",
      description: "config",
      input: z.object({}),
      requiresWorkspace: false,
      handler: record,
    }),
  ]);
  return { deps: { registry }, calls };
}

describe("PLUGIN_ACTIONS_MAP", () => {
  it("says something about every operation", () => {
    expect(Object.keys(PLUGIN_ACTIONS_MAP).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("leaves the unattended-unsafe operations out", () => {
    for (const name of ["config.set", "lock.take", "report.issue", "agent.lifecycle"] as const) {
      expect(PLUGIN_ACTIONS_MAP[name], name).toBeNull();
    }
    expect(PLUGIN_ACTIONS_MAP["workspace.create"]).toEqual({ kind: "create-workspace" });
  });
});

describe("invokePluginAction", () => {
  it("calls from no workspace, leaving the named one to the operation", async () => {
    const { deps, calls } = setup();

    await invokePluginAction(deps, "workspace.hibernate", { workspace: "feat" });

    expect(calls[0]!.ctx.workspaceRef).toBeNull();
    expect(calls[0]!.input).toEqual({ workspace: "feat" });
  });

  it("fails an action that needs a workspace when the item names none", async () => {
    const { deps } = setup();

    await expect(invokePluginAction(deps, "workspace.hibernate", {})).rejects.toThrow(
      /acts on a workspace/
    );
  });

  it("lets the operation's own schema judge the rendered input", async () => {
    const { deps, calls } = setup();

    await invokePluginAction(deps, "notification.show", { message: "hi", dismissible: true });
    await expect(
      invokePluginAction(deps, "notification.show", { message: "hi", typo: 1 })
    ).rejects.toThrow(/notification\.show/);

    expect(calls).toHaveLength(1);
  });

  it("refuses an operation no automation may run", async () => {
    const { deps, calls } = setup();

    await expect(invokePluginAction(deps, "config.set", {})).rejects.toThrow(
      /not an action an automation can run/
    );
    expect(calls).toEqual([]);
  });
});
