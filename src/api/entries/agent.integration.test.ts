// @vitest-environment node
/**
 * The `agent.message` registry entry, run through the real registry and the
 * real send-agent-message operation, with a test module standing in for the
 * agent's "send" hook — so targeting (by name or path, relative to the caller),
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
import type { WorkspacePath } from "../../intents/contract";
import { projPath, wsPath } from "../../shared/test-fixtures";
import { createLockModule } from "../../modules/lock-module";
import { ApiError } from "../errors";
import type { OperationContext } from "../types";
import { createRegistry } from "./index";

const APP = projPath("/projects/app");
const LIB = projPath("/projects/lib");
const FEAT = wsPath("/projects/app/workspaces/feat");
const OTHER = wsPath("/projects/app/workspaces/other");
/** Branch `feature/x`, in the directory CodeHydra sanitizes it to. */
const FEATURE_X = wsPath("/projects/app/workspaces/feature%x");
const APP_SHARED = wsPath("/projects/app/workspaces/shared");
const LIB_SHARED = wsPath("/projects/lib/workspaces/shared");
const LIB_ONLY = wsPath("/projects/lib/workspaces/only-lib");

/** Two open projects; `shared` exists in both. */
const PROJECTS = [
  { path: APP, name: "app", workspaces: [FEAT, OTHER, APP_SHARED] },
  { path: LIB, name: "lib", workspaces: [LIB_SHARED, LIB_ONLY] },
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
      id: `${project.name}-1` as ProjectId,
      name: project.name,
      path: project.path,
      workspaces: project.workspaces.map((path) => ({
        projectId: `${project.name}-1` as ProjectId,
        name: path.slice(path.lastIndexOf("/") + 1) as WorkspaceName,
        path,
        branch: null,
        metadata: {},
      })),
    })) as unknown as Project[];
  }
}

function setup() {
  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(new SendAgentMessageOperation());
  dispatcher.registerOperation(new ListProjectsOp());
  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: workspacePath.startsWith(LIB) ? LIB : APP,
      workspaceName: workspacePath
        .slice(workspacePath.lastIndexOf("/") + 1)
        .replace("%", "/") as WorkspaceName,
    }),
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
    },
    SILENT_LOGGER
  );

  /**
   * `scope` is the workspace the connection acts on (a shell's `--workspace`,
   * else where it stands); `caller` is where it stands.
   */
  const call = (
    at: { scope: WorkspacePath | null; caller: WorkspacePath | null },
    input: Record<string, unknown>
  ) => {
    const ctx: OperationContext = {
      workspacePath: at.scope,
      callerWorkspacePath: at.caller,
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

const inFeat = { scope: FEAT, caller: FEAT };
const nowhere = { scope: null, caller: null };

describe("agent.message entry", () => {
  it("sends to the caller's own workspace, signed with its name", async () => {
    const { call, sent } = setup();

    const result = await call(inFeat, { text: "hello" });

    expect(result).toBeNull();
    expect(sent).toEqual([
      { workspacePath: FEAT, text: "hello", from: "CodeHydra · workspace feat", wake: false },
    ]);
  });

  it("signs with the workspace's name, not its directory", async () => {
    const { call, sent } = setup();

    await call({ scope: OTHER, caller: FEATURE_X }, { text: "hello" });

    expect(sent[0]?.from).toBe("CodeHydra · workspace feature/x");
  });

  it("signs with where the shell stands when --workspace names another", async () => {
    const { call, sent } = setup();

    await call({ scope: OTHER, caller: FEAT }, { text: "hello" });

    expect(sent).toEqual([
      { workspacePath: OTHER, text: "hello", from: "CodeHydra · workspace feat", wake: false },
    ]);
  });

  it("signs as the CLI from outside every workspace", async () => {
    const { call, sent } = setup();

    await call({ scope: OTHER, caller: null }, { text: "hello" });

    expect(sent[0]!.from).toBe("CodeHydra · ch");
  });

  describe("naming the target (MCP and plugin)", () => {
    it("takes a name, looked up in the caller's project first", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "shared", text: "hello" });

      expect(sent[0]!.workspacePath).toBe(APP_SHARED);
    });

    it("finds a name only another project has", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "only-lib", text: "hello" });

      expect(sent[0]!.workspacePath).toBe(LIB_ONLY);
    });

    it("takes a project to look the name up in", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: "shared", project: "lib", text: "hello" });

      expect(sent[0]!.workspacePath).toBe(LIB_SHARED);
    });

    it("takes an absolute path at its word", async () => {
      const { call, sent } = setup();

      await call(inFeat, { workspace: LIB_ONLY, text: "hello" });

      expect(sent[0]!.workspacePath).toBe(LIB_ONLY);
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
