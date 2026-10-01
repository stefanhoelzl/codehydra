// @vitest-environment node
/**
 * The `agent.message` registry entry, run through the real registry and the
 * real send-agent-message operation, with a test module standing in for the
 * agent's "send" hook — so targeting (by name or ref, relative to the caller),
 * the sender name and input validation are asserted as a caller sees them.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { registerTestInfrastructure } from "../../intents/operations.test-utils";
import {
  SEND_AGENT_MESSAGE_OPERATION_ID,
  SendAgentMessageOperation,
  type SendAgentMessageIntent,
  type SendHookResult,
} from "../../intents/send-agent-message";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type {
  HookContext,
  HookOutput,
  Operation,
  OperationSchemas,
} from "../../intents/lib/operation";
import type { Project, ProjectId, WorkspaceName } from "../../shared/api/types";
import type { ProjectPath, WorkspaceRef } from "../../intents/contract";
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const APP = projPath("/projects/app");
const LIB = projPath("/projects/lib");
/** A workspace of `project`: its directory, and its ref (named `name`). */
function workspace(project: ProjectPath, dir: string, name = dir) {
  return {
    path: wsPath(`${project}/workspaces/${dir}`),
    ref: makeWorkspaceRef(projectRefFor(project), name),
    name,
  };
}

const W_FEAT = workspace(APP, "feat");
const W_OTHER = workspace(APP, "other");
/** Branch `feature/x`, in the directory CodeHydra sanitizes it to. */
const W_FEATURE_X = workspace(APP, "feature%x", "feature/x");
const W_APP_SHARED = workspace(APP, "shared");
const W_LIB_SHARED = workspace(LIB, "shared");
const W_LIB_ONLY = workspace(LIB, "only-lib");

const FEAT = W_FEAT.ref;
const OTHER = W_OTHER.ref;
const FEATURE_X = W_FEATURE_X.ref;
const APP_SHARED = W_APP_SHARED.ref;
const LIB_SHARED = W_LIB_SHARED.ref;
const LIB_ONLY = W_LIB_ONLY.ref;

/** Two open projects; `shared` exists in both. */
const PROJECTS = [
  { path: APP, name: "app", workspaces: [W_FEAT, W_OTHER, W_FEATURE_X, W_APP_SHARED] },
  { path: LIB, name: "lib", workspaces: [W_LIB_SHARED, W_LIB_ONLY] },
];

const listProjectsSchemas = {
  type: INTENT_LIST_PROJECTS,
  payload: z.unknown(),
  result: z.unknown(),
} satisfies OperationSchemas;

class ListProjectsOp implements Operation<typeof listProjectsSchemas> {
  readonly id = "list-projects";
  readonly schemas = listProjectsSchemas;
  async execute(): Promise<Project[]> {
    return PROJECTS.map((project) => ({
      ref: projectRefFor(project.path),
      id: `${project.name}-1` as ProjectId,
      name: project.name,
      path: project.path,
      workspaces: project.workspaces.map((w) => ({
        ref: w.ref,
        projectId: `${project.name}-1` as ProjectId,
        name: w.name as WorkspaceName,
        path: w.path,
        branch: null,
        metadata: {},
      })),
    }));
  }
}

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new SendAgentMessageOperation());
  dispatcher.registerOperation(new ListProjectsOp());
  registerTestInfrastructure(dispatcher, {
    workspaces: Object.fromEntries(
      PROJECTS.flatMap((project) =>
        project.workspaces.map((w) => [
          w.path,
          { projectPath: project.path, workspaceName: w.name as WorkspaceName },
        ])
      )
    ),
    projects: {
      [APP]: { projectId: "app-1" as ProjectId },
      [LIB]: { projectId: "lib-1" as ProjectId },
    },
  });

  const sent: SendAgentMessageIntent["payload"][] = [];
  let unreachable: string | null = null;
  dispatcher.registerModule({
    name: "test-agent",
    hooks: {
      [SEND_AGENT_MESSAGE_OPERATION_ID]: {
        send: {
          handler: async (ctx: HookContext): Promise<HookOutput<SendHookResult>> => {
            if (unreachable !== null) return { result: { sent: false, reason: unreachable } };
            sent.push((ctx.intent as SendAgentMessageIntent).payload);
            return { result: { sent: true } };
          },
        },
      },
    },
  });

  const registry = createRegistry(
    {
      dispatcher,
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
    },
    SILENT_LOGGER
  );

  /** `caller` is the caller's own workspace; the target is the input's `workspace`. */
  const call = (caller: WorkspaceRef | null, input: Record<string, unknown>) => {
    const ctx: OperationContext = {
      workspaceRef: caller,
      cwd: null,
      signal: new AbortController().signal,
    };
    return registry.invoke(registry.get("agent.message"), ctx, input);
  };

  return {
    call,
    sent,
    setUnreachable: (reason: string) => {
      unreachable = reason;
    },
  };
}

const inFeat = FEAT;
const nowhere = null;

describe("agent.message entry", () => {
  it("sends to the caller's own workspace, signed with its name", async () => {
    const { call, sent } = setup();

    const result = await call(inFeat, { text: "hello" });

    expect(result).toBeNull();
    expect(sent).toEqual([
      { workspaceRef: FEAT, text: "hello", from: "CodeHydra · workspace feat", wake: false },
    ]);
  });

  it("signs with the workspace's name, not its directory", async () => {
    const { call, sent } = setup();

    await call(FEATURE_X, { workspace: OTHER, text: "hello" });

    expect(sent[0]?.from).toBe("CodeHydra · workspace feature/x");
  });

  it("signs with the caller's own workspace when it names another", async () => {
    const { call, sent } = setup();

    await call(FEAT, { workspace: OTHER, text: "hello" });

    expect(sent).toEqual([
      { workspaceRef: OTHER, text: "hello", from: "CodeHydra · workspace feat", wake: false },
    ]);
  });

  it("signs as the CLI from outside every workspace", async () => {
    const { call, sent } = setup();

    await call(null, { workspace: OTHER, text: "hello" });

    expect(sent[0]!.from).toBe("CodeHydra · ch");
  });

  describe("naming the target", () => {
    it("takes a name, looked up in the caller's project first", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "shared", text: "hello" });

      expect(sent[0]!.workspaceRef).toBe(APP_SHARED);
    });

    it("finds a name only another project has", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "only-lib", text: "hello" });

      expect(sent[0]!.workspaceRef).toBe(LIB_ONLY);
    });

    it("takes a project to look the name up in", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "shared", project: "lib", text: "hello" });

      expect(sent[0]!.workspaceRef).toBe(LIB_SHARED);
    });

    it("takes a full ref", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: LIB_ONLY, text: "hello" });

      expect(sent[0]!.workspaceRef).toBe(LIB_ONLY);
    });

    it("takes <project>::<name>", async () => {
      const { call, sent } = setup();

      await call(nowhere, { workspace: "lib::shared", text: "hello" });

      expect(sent[0]!.workspaceRef).toBe(LIB_SHARED);
    });

    it("refuses a workspace named by its path, as a usage error", async () => {
      const { call } = setup();

      await expect(call(inFeat, { workspace: W_LIB_ONLY.path, text: "hello" })).rejects.toSatisfy(
        (error) => error instanceof ApiError && error.category === "usage"
      );
    });

    it("refuses a name several other projects have, as a usage error", async () => {
      const { call } = setup();

      await expect(call(nowhere, { workspace: "shared", text: "hello" })).rejects.toSatisfy(
        (error) => error instanceof ApiError && error.category === "usage"
      );
    });

    it("reports a name nobody has as not found", async () => {
      const { call } = setup();

      await expect(call(inFeat, { workspace: "absent", text: "hello" })).rejects.toSatisfy(
        (error) => error instanceof ApiError && error.category === "not-found"
      );
    });

    it("refuses a project without a workspace", async () => {
      const { call } = setup();

      await expect(call(inFeat, { project: "lib", text: "hello" })).rejects.toSatisfy(
        (error) => error instanceof ApiError && error.category === "usage"
      );
    });
  });

  it("refuses without a workspace to send to", async () => {
    const { call } = setup();

    await expect(call(nowhere, { text: "hello" })).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.category === "no-workspace"
    );
  });

  it("refuses an empty message as a usage error", async () => {
    const { call, sent } = setup();

    await expect(call(inFeat, { text: "" })).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.category === "usage"
    );
    expect(sent).toEqual([]);
  });

  it("reports a workspace with no agent to take it as not found", async () => {
    const { call, setUnreachable } = setup();
    setUnreachable("No Claude session is running");

    await expect(call(inFeat, { text: "hello" })).rejects.toSatisfy(
      (error) =>
        error instanceof ApiError &&
        error.category === "not-found" &&
        error.message === "No Claude session is running"
    );
  });

  it("does not let the caller choose the sender", async () => {
    const { call, sent } = setup();

    await call(inFeat, { text: "hello", from: "someone else" });

    expect(sent[0]!.from).toBe("CodeHydra · workspace feat");
  });
});
